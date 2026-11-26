import { supabase } from '../_lib/database.js';
import { syncCampaignEvents, fetchMailgunEvents, fetchMailgunEventPage } from '../_lib/mailgunEventSync.js';
import { recoverCampaignAcceptance } from '../_lib/campaignAcceptanceRecovery.js';
import { finalizeCampaignDelivery } from '../_lib/campaignClaimJournal.js';
import { syncEventEmailDeliveries } from '../_lib/eventEmailDelivery.js';

const OVERALL_BUDGET_MS = 55_000;
const MIN_USEFUL_BUDGET_MS = 12_000;
const PER_CAMPAIGN_CAP_MS = 45_000;
const BUDGET_RESERVE_MS = 2_000;

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/sync-mailgun-events] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const startTime = Date.now();

  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: campaigns, error: campaignsError } = await supabase
      .from('email_campaign')
      .select('id, tenant_id, from_email, status, sent_at')
      .in('status', ['sent', 'paused', 'sending'])
      .gte('sent_at', thirtyDaysAgo)
      .order('sent_at', { ascending: false });

    if (campaignsError) {
      console.error('[cron/sync-mailgun-events] Failed to fetch campaigns:', campaignsError.message);
      return res.status(500).json({ error: 'Failed to fetch campaigns' });
    }

    const campaignList = campaigns || [];
    console.log(`[cron/sync-mailgun-events] Found ${campaignList.length} campaigns sent in the last 30 days`);

    const tenantDomains = new Map();
    const tenantIds = [...new Set(campaignList.map(c => c.tenant_id))];
    if (tenantIds.length) {
      const { data: tenants, error: tenantsError } = await supabase
        .from('tenant')
        .select('id, settings')
        .in('id', tenantIds);

      if (tenantsError) {
        console.error('[cron/sync-mailgun-events] Failed to fetch tenants:', tenantsError.message);
        return res.status(500).json({ error: 'Failed to fetch tenant settings' });
      }

      for (const t of (tenants || [])) {
        const domain = t.settings?.email_domain?.domain;
        if (domain) tenantDomains.set(t.id, domain);
      }
    }

    // Reconcile unresolved transport outcomes before spending the budget on
    // engagement history for already-completed campaigns.
    campaignList.sort((a,b) => Number(b.status==='sending')-Number(a.status==='sending'));
    const results = [];
    let campaignsSynced = 0;
    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (let idx = 0; idx < campaignList.length; idx++) {
      if (Date.now()+6000>=startTime+OVERALL_BUDGET_MS) break;
      const campaign = campaignList[idx];
      if (['sending','paused'].includes(campaign.status)) {
        const domain=tenantDomains.get(campaign.tenant_id);
        if (domain) {
          try {
            const recovered=await recoverCampaignAcceptance(supabase,campaign,domain,fetchMailgunEvents,
              Math.min(startTime+OVERALL_BUDGET_MS-2000,Date.now()+12000));
            if (recovered && campaign.status==='sending') {
              await finalizeCampaignDelivery(supabase,campaign.id,campaign.tenant_id);
            }
          } catch(error) {
            totalErrors++;
            console.error('[Campaign acceptance recovery] Failed:',campaign.id,error.message);
          }
        }
      }
      // The general engagement synchronizer persists whole recipient snapshots.
      // Do not race it against active send-result writes; the acceptance-only
      // path above uses a processing CAS and never regresses engagement history.
      if (campaign.status==='sending') continue;
      const elapsed = Date.now() - startTime;
      const remaining = OVERALL_BUDGET_MS - elapsed;

      if (remaining < 5_000) {
        console.log(`[cron/sync-mailgun-events] Time budget exhausted after ${campaignsSynced} campaigns, ${campaignList.length - idx} remaining`);
        break;
      }

      const emailDomain = tenantDomains.get(campaign.tenant_id);
      if (!emailDomain) {
        console.log(`[cron/sync-mailgun-events] Skipping campaign ${campaign.id} - no email domain for tenant ${campaign.tenant_id}`);
        continue;
      }

      const perCampaignBudget = Math.min(remaining - BUDGET_RESERVE_MS, PER_CAMPAIGN_CAP_MS);

      if (perCampaignBudget < MIN_USEFUL_BUDGET_MS) {
        console.log(`[cron/sync-mailgun-events] Insufficient time remaining (${Math.round(remaining / 1000)}s) for another campaign, stopping after ${campaignsSynced} synced, ${campaignList.length - idx} remaining`);
        break;
      }

      try {
        const result = await syncCampaignEvents(campaign, emailDomain, campaign.tenant_id, perCampaignBudget);

        campaignsSynced++;
        totalProcessed += result.processed;
        totalSkipped += result.skipped;
        totalErrors += result.errors;

        results.push({
          campaignId: campaign.id,
          tenantId: campaign.tenant_id,
          processed: result.processed,
          skipped: result.skipped,
          errors: result.errors,
          elapsedSeconds: result.elapsedSeconds,
        });

        if (result.timedOut) {
          console.log(`[cron/sync-mailgun-events] Campaign ${campaign.id} hit its time budget, moving on`);
        }
      } catch (err) {
        console.error(`[cron/sync-mailgun-events] Error syncing campaign ${campaign.id}:`, err.message);
        totalErrors++;
        results.push({
          campaignId: campaign.id,
          tenantId: campaign.tenant_id,
          error: err.message,
        });
      }
    }

    // Event email (confirmation/reminder/follow-up) recovery uses whatever
    // budget the campaigns left. Rows record the domain they were sent from.
    let eventEmailSync = null;
    if (Date.now() + 8000 < startTime + OVERALL_BUDGET_MS) {
      try {
        eventEmailSync = await syncEventEmailDeliveries(supabase, fetchMailgunEvents, {
          defaultDomain: process.env.MAILGUN_DOMAIN || null,
          deadline: startTime + OVERALL_BUDGET_MS - BUDGET_RESERVE_MS,
          fetchNext: fetchMailgunEventPage,
        });
        totalErrors += eventEmailSync.errors;
      } catch (err) {
        totalErrors++;
        console.error('[cron/sync-mailgun-events] Event email recovery failed:', err.message);
        eventEmailSync = { error: err.message };
      }
    }

    const totalElapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[cron/sync-mailgun-events] Complete: ${campaignsSynced}/${campaignList.length} campaigns synced, ${totalProcessed} events processed, ${totalSkipped} skipped, ${totalErrors} errors, ${totalElapsed}s`);

    return res.json({
      success: true,
      campaigns_found: campaignList.length,
      event_email_sync: eventEmailSync,
      campaigns_synced: campaignsSynced,
      total_processed: totalProcessed,
      total_skipped: totalSkipped,
      total_errors: totalErrors,
      elapsed_seconds: totalElapsed,
      details: results,
    });
  } catch (error) {
    console.error('[cron/sync-mailgun-events] Error:', error);
    return res.status(500).json({ error: 'Failed to run scheduled Mailgun sync', details: error.message });
  }
}
