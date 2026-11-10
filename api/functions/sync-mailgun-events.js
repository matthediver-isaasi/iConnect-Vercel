import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { syncCampaignEvents, fetchMailgunEvents } from '../_lib/mailgunEventSync.js';
import { recoverCampaignAcceptance } from '../_lib/campaignAcceptanceRecovery.js';
import { finalizeCampaignDelivery } from '../_lib/campaignClaimJournal.js';

const ALLOWED_ORIGINS = ['https://iconn.app', 'https://www.iconn.app'];
const TIME_BUDGET_MS = 50_000;

function getAllowedOrigin(requestOrigin) {
  if (!requestOrigin) return ALLOWED_ORIGINS[0];
  if (ALLOWED_ORIGINS.includes(requestOrigin)) return requestOrigin;
  if (requestOrigin.endsWith('.iconn.app')) return requestOrigin;
  return ALLOWED_ORIGINS[0];
}

export default async function handler(req, res) {
  const origin = getAllowedOrigin(req.headers.origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) return res.status(401).json({ error: 'Unauthorized - tenant required' });
  const isAuthorized = await hasAdminAccess(tenantContext);
  if (!isAuthorized) return res.status(403).json({ error: 'Forbidden - requires admin access' });

  const tenantId = tenantContext.tenantId;
  const { campaignId } = req.body || {};
  if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });

  try {
    const started = Date.now();
    const { data: campaign, error: campaignError } = await supabase
      .from('email_campaign')
      .select('id, tenant_id, from_email, status, sent_at')
      .eq('id', campaignId)
      .eq('tenant_id', tenantId)
      .single();

    if (campaignError || !campaign) return res.status(404).json({ error: 'Campaign not found' });

    const { data: tenant, error: tenantError } = await supabase
      .from('tenant')
      .select('settings')
      .eq('id', tenantId)
      .single();

    if (tenantError) throw new Error('Unable to load tenant email settings');
    const emailDomain = tenant?.settings?.email_domain?.domain;
    if (!emailDomain) return res.status(400).json({ error: 'No email domain configured for this tenant' });

    // Positive acceptance evidence only. This never invokes the sender or
    // releases uncertain submissions back to the queue.
    const acceptance = await recoverCampaignAcceptance(supabase, campaign, emailDomain, fetchMailgunEvents,
      started + 25_000, { detailed: true });
    const result = await syncCampaignEvents(campaign, emailDomain, tenantId,
      Math.max(1000, TIME_BUDGET_MS - (Date.now() - started)), { lookbackDays: 7 });
    await finalizeCampaignDelivery(supabase, campaign.id, tenantId);
    const { count: unresolved, error: countError } = await supabase.from('email_campaign_recipient')
      .select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id).eq('status', 'processing');
    if (countError) throw countError;

    return res.json({
      success: true,
      partial: result.timedOut,
      summary: {
        acceptance_checked: acceptance.checked,
        acceptance_recovered: acceptance.recovered,
        awaiting_reconciliation: unresolved,
        total_events: result.totalEvents,
        processed: result.processed,
        skipped: result.skipped,
        errors: result.errors,
        elapsed_seconds: result.elapsedSeconds,
        ...(result.timedOut ? { stopped_at: result.lastEventType, message: 'Time budget reached — click Sync again to continue processing remaining events.' } : {}),
      }
    });
  } catch (error) {
    console.error('[Sync Mailgun Events] Error:', error);
    return res.status(503).json({ error: 'Delivery status could not be fully checked. No emails were resent. Please retry or ask an administrator to check Mailgun Events access.' });
  }
}
