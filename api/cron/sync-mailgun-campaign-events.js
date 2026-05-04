import { supabase } from '../_lib/database.js';
import { syncCampaignEvents } from '../_lib/mailgunEventSync.js';

const OVERALL_BUDGET_MS = 50_000;

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
      .in('status', ['sent', 'paused'])
      .gte('sent_at', thirtyDaysAgo)
      .order('sent_at', { ascending: false });

    if (campaignsError) {
      console.error('[cron/sync-mailgun-events] Failed to fetch campaigns:', campaignsError.message);
      return res.status(500).json({ error: 'Failed to fetch campaigns' });
    }

    if (!campaigns || campaigns.length === 0) {
      console.log('[cron/sync-mailgun-events] No recent campaigns to sync');
      return res.json({ success: true, message: 'No recent campaigns', campaigns_synced: 0 });
    }

    console.log(`[cron/sync-mailgun-events] Found ${campaigns.length} campaigns sent in the last 30 days`);

    const tenantIds = [...new Set(campaigns.map(c => c.tenant_id))];
    const { data: tenants, error: tenantsError } = await supabase
      .from('tenant')
      .select('id, settings')
      .in('id', tenantIds);

    if (tenantsError) {
      console.error('[cron/sync-mailgun-events] Failed to fetch tenants:', tenantsError.message);
      return res.status(500).json({ error: 'Failed to fetch tenant settings' });
    }

    const tenantDomains = new Map();
    for (const t of (tenants || [])) {
      const domain = t.settings?.email_domain?.domain;
      if (domain) tenantDomains.set(t.id, domain);
    }

    const results = [];
    let campaignsSynced = 0;
    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (const campaign of campaigns) {
      const elapsed = Date.now() - startTime;
      const remaining = OVERALL_BUDGET_MS - elapsed;

      if (remaining < 5_000) {
        console.log(`[cron/sync-mailgun-events] Time budget exhausted after ${campaignsSynced} campaigns, ${campaigns.length - campaignsSynced} remaining`);
        break;
      }

      const emailDomain = tenantDomains.get(campaign.tenant_id);
      if (!emailDomain) {
        console.log(`[cron/sync-mailgun-events] Skipping campaign ${campaign.id} - no email domain for tenant ${campaign.tenant_id}`);
        continue;
      }

      const perCampaignBudget = Math.min(remaining - 2_000, 45_000);

      if (perCampaignBudget < 12_000) {
        console.log(`[cron/sync-mailgun-events] Insufficient time remaining (${Math.round(remaining / 1000)}s) for more campaigns, stopping`);
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

    const totalElapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[cron/sync-mailgun-events] Complete: ${campaignsSynced}/${campaigns.length} campaigns synced, ${totalProcessed} events processed, ${totalSkipped} skipped, ${totalErrors} errors, ${totalElapsed}s`);

    return res.json({
      success: true,
      campaigns_found: campaigns.length,
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
