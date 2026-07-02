// One-off, CRON_SECRET-guarded endpoint to resume the GRAFTAs campaign that
// was prematurely marked as 'sent' by the race condition between
// sendCampaign() and the cron worker processSendingCampaigns(). The race is
// now fixed in api/_lib/campaignService.js — this endpoint exists ONLY to
// recover the ~4,720 recipients still in status='pending' for that one
// specific campaign.
//
// The endpoint does NOT send emails directly (Vercel functions max out at
// 60s and 4,720 sends would exceed that). Instead it verifies the campaign
// matches every expected guardrail and flips its status from 'sent' back to
// 'sending' so the existing every-minute cron worker drains the remaining
// recipients in 100-row batches over the following ~47 minutes.
//
// REMOVE THIS FILE after the resume completes. It is intentionally not
// referenced anywhere else. Hard-coded id/tenant/name guardrails make it
// impossible to repurpose this endpoint for any other campaign.

import { supabase } from '../_lib/database.js';

const CAMPAIGN_ID = '99ffb6d9-3bee-4d67-be53-696ab8dba5c9';
const TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const EXPECTED_NAME = 'GRAFTAs deadline extension announcement';
const EXPECTED_PENDING_MIN = 3000;
const EXPECTED_PENDING_MAX = 5000;

async function countRows(filterFn) {
  const q = filterFn(
    supabase
      .from('email_campaign_recipient')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', CAMPAIGN_ID)
  );
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

export default async function handler(req, res) {
  // AuthN: must present the platform CRON_SECRET. Same convention as
  // /api/email-campaigns/process-scheduled.js.
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(500).json({ error: 'CRON_SECRET not configured' });
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const dryRun = req.query?.dryRun === 'true' || req.body?.dryRun === true;

  try {
    // Verify campaign exists, name matches, and pending count is sane.
    const { data: campaign, error: fetchError } = await supabase
      .from('email_campaign')
      .select('id, tenant_id, name, status, completed_at, total_recipients, sent_count')
      .eq('id', CAMPAIGN_ID)
      .eq('tenant_id', TENANT_ID)
      .single();

    if (fetchError || !campaign) {
      return res.status(404).json({
        error: 'Target campaign not found for expected tenant',
        details: fetchError?.message,
      });
    }

    if (campaign.name !== EXPECTED_NAME) {
      return res.status(409).json({
        error: 'Campaign name does not match expected — refusing to act',
        expectedName: EXPECTED_NAME,
        actualName: campaign.name,
      });
    }

    const pending = await countRows(q => q.eq('status', 'pending'));
    const processing = await countRows(q => q.eq('status', 'processing'));
    const alreadySent = await countRows(q => q.in('status', ['sent', 'delivered', 'opened', 'clicked']));
    const failed = await countRows(q => q.eq('status', 'failed'));
    const bounced = await countRows(q => q.eq('status', 'bounced'));
    const cancelled = await countRows(q => q.eq('status', 'cancelled'));

    const counts = { pending, processing, alreadySent, failed, bounced, cancelled };

    if (pending < EXPECTED_PENDING_MIN || pending > EXPECTED_PENDING_MAX) {
      return res.status(409).json({
        error: `Pending count ${pending} outside expected range [${EXPECTED_PENDING_MIN}, ${EXPECTED_PENDING_MAX}]. Refusing to act.`,
        counts,
        currentStatus: campaign.status,
      });
    }

    if (dryRun) {
      return res.json({
        success: true,
        dryRun: true,
        campaignId: CAMPAIGN_ID,
        campaignName: campaign.name,
        currentStatus: campaign.status,
        counts,
        wouldFlipTo: 'sending',
        note: 'After flip, the every-minute cron will drain pending recipients in 100-row batches.',
      });
    }

    // Flip ONLY this campaign back to 'sending' (and clear completed_at).
    // Strict id+tenant filter — nothing else can be touched.
    const { data: flipped, error: flipError } = await supabase
      .from('email_campaign')
      .update({
        status: 'sending',
        completed_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', CAMPAIGN_ID)
      .eq('tenant_id', TENANT_ID)
      .select('id, status');

    if (flipError) {
      return res.status(500).json({ error: 'Failed to flip campaign status', details: flipError.message });
    }
    if (!flipped || flipped.length !== 1) {
      return res.status(500).json({ error: `Expected exactly 1 row updated, got ${flipped?.length || 0}` });
    }

    console.log(`[resume-graftas] Flipped campaign ${CAMPAIGN_ID} from '${campaign.status}' to 'sending'. Cron will now drain ${pending} pending recipients.`);

    return res.json({
      success: true,
      campaignId: CAMPAIGN_ID,
      campaignName: campaign.name,
      previousStatus: campaign.status,
      newStatus: 'sending',
      counts,
      note: 'The every-minute cron worker will now drain pending recipients in 100-row batches. Estimated time: ~47 minutes for 4,720 recipients.',
    });
  } catch (err) {
    console.error('[resume-graftas] Unexpected error:', err);
    return res.status(500).json({ error: err.message });
  }
}
