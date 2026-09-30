/**
 * One-off resume operation for the "GRAFTAs deadline extension announcement"
 * campaign that was prematurely marked as `sent` due to the race condition
 * between sendCampaign() and the cron worker processSendingCampaigns().
 *
 * The race itself has now been fixed in api/_lib/campaignService.js — this
 * script exists ONLY to recover the 4,720 recipients whose rows are still in
 * status='pending' and never received the email. The other ~100 recipients
 * who already received it MUST NOT be re-emailed.
 *
 * Hard-coded guardrails (DO NOT REMOVE):
 *   - Only the GRAFTAs campaign id is touched (no broad sweep).
 *   - Only the matching tenant id is touched.
 *   - The campaign name is verified to exactly match the expected value.
 *   - The pending row count is verified to be in the expected ballpark
 *     (3,000–5,000) before flipping status. Aborts otherwise.
 *   - Only `pending` rows are processed by sendBatch, which uses an atomic
 *     claim — already-`sent` rows are never re-sent.
 *   - sendBatch is invoked with the explicit CAMPAIGN_ID; no other campaign
 *     id can be reached from this script.
 *
 * Usage:
 *   # Verification only:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
 *     node scripts/resume-graftas-campaign.mjs --dry-run
 *
 *   # Real run:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
 *     node scripts/resume-graftas-campaign.mjs
 *
 * The script connects to whichever database SUPABASE_URL points at, so the
 * operator is responsible for pointing it at production when running it.
 */

import { sendBatch, getCampaign, updateCampaign } from '../api/_lib/campaignService.js';
import { supabase } from '../api/_lib/database.js';

const CAMPAIGN_ID = '99ffb6d9-3bee-4d67-be53-696ab8dba5c9';
const TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const EXPECTED_NAME = 'GRAFTAs deadline extension announcement';
const EXPECTED_PENDING_MIN = 3000;
const EXPECTED_PENDING_MAX = 5000;

const DRY_RUN = process.argv.includes('--dry-run');

async function countRows(filterFn) {
  const q = filterFn(supabase
    .from('email_campaign_recipient')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', CAMPAIGN_ID));
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

async function main() {
  if (!supabase) {
    console.error('FATAL: Supabase client not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.');
    process.exit(1);
  }

  console.log(`[resume-graftas] Starting (dryRun=${DRY_RUN})`);
  console.log(`[resume-graftas] Target campaign: ${CAMPAIGN_ID}`);
  console.log(`[resume-graftas] Target tenant:   ${TENANT_ID}`);

  // 1. Verify the campaign exists, the name matches, and pending count is sane.
  const { success, campaign, error } = await getCampaign(CAMPAIGN_ID, TENANT_ID);
  if (!success || !campaign) {
    console.error(`FATAL: Campaign ${CAMPAIGN_ID} not found for tenant ${TENANT_ID}: ${error || 'unknown'}`);
    process.exit(1);
  }

  console.log(`[resume-graftas] Found campaign: "${campaign.name}" (status=${campaign.status})`);

  if (campaign.name !== EXPECTED_NAME) {
    console.error(`FATAL: Campaign name "${campaign.name}" does not match expected "${EXPECTED_NAME}". Aborting to avoid mis-targeting.`);
    process.exit(1);
  }

  const pending = await countRows(q => q.eq('status', 'pending'));
  const processing = await countRows(q => q.eq('status', 'processing'));
  const alreadySent = await countRows(q => q.in('status', ['sent', 'delivered', 'opened', 'clicked']));
  const failed = await countRows(q => q.eq('status', 'failed'));
  const bounced = await countRows(q => q.eq('status', 'bounced'));
  const cancelled = await countRows(q => q.eq('status', 'cancelled'));

  console.log(`[resume-graftas] Recipient counts:`);
  console.log(`  pending:    ${pending}`);
  console.log(`  processing: ${processing}`);
  console.log(`  sent-ish:   ${alreadySent}`);
  console.log(`  failed:     ${failed}`);
  console.log(`  bounced:    ${bounced}`);
  console.log(`  cancelled:  ${cancelled}`);

  if (pending < EXPECTED_PENDING_MIN || pending > EXPECTED_PENDING_MAX) {
    console.error(`FATAL: Pending count ${pending} is outside expected range [${EXPECTED_PENDING_MIN}, ${EXPECTED_PENDING_MAX}]. Aborting.`);
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('[resume-graftas] Dry run — verification passed. No changes made.');
    process.exit(0);
  }

  // 2. Flip ONLY this campaign back to 'sending' (and clear completed_at).
  //    Strict .eq('id', ...) + .eq('tenant_id', ...) — no other campaign
  //    can possibly be touched by this update.
  console.log(`[resume-graftas] Flipping campaign ${CAMPAIGN_ID} from '${campaign.status}' back to 'sending'...`);
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
    console.error('FATAL: Failed to flip campaign status:', flipError.message);
    process.exit(1);
  }
  if (!flipped || flipped.length !== 1) {
    console.error(`FATAL: Expected to update exactly 1 campaign row, got ${flipped?.length || 0}. Aborting.`);
    process.exit(1);
  }

  // 3. Re-fetch the campaign with up-to-date status, then drive sendBatch in
  //    a loop directly for this single campaign id until pending+processing
  //    reach zero. sendBatch only ever touches recipients matching the
  //    explicit campaignId we pass in.
  const refreshed = await getCampaign(CAMPAIGN_ID, TENANT_ID);
  const liveCampaign = refreshed.campaign || campaign;

  const { data: tenantRow } = await supabase
    .from('tenant')
    .select('slug')
    .eq('id', TENANT_ID)
    .single();
  const tenantSlug = tenantRow?.slug || '';

  console.log('[resume-graftas] Beginning batched send (100 recipients per batch)...');
  const startedAt = Date.now();
  let iteration = 0;
  let totalSent = 0;
  let totalFailed = 0;

  while (true) {
    iteration += 1;
    const result = await sendBatch(CAMPAIGN_ID, TENANT_ID, liveCampaign, tenantSlug, null);
    totalSent += result.sent || 0;
    totalFailed += result.failed || 0;

    const remaining = await countRows(q => q.in('status', ['pending', 'processing']));
    const sentSoFar = await countRows(q => q.in('status', ['sent', 'delivered', 'opened', 'clicked']));
    console.log(`[resume-graftas] iter=${iteration} batchSent=${result.sent || 0} batchFailed=${result.failed || 0} remaining=${remaining} totalSentSoFar=${sentSoFar}`);

    if (result.cancelled) {
      console.warn('[resume-graftas] Campaign was cancelled mid-resume — stopping.');
      break;
    }
    if ((result.sent || 0) === 0 && (result.failed || 0) === 0 && remaining === 0) {
      console.log('[resume-graftas] All recipients processed.');
      break;
    }
    if ((result.sent || 0) === 0 && (result.failed || 0) === 0 && remaining > 0) {
      console.warn(`[resume-graftas] Batch claimed nothing but ${remaining} remain (likely stuck 'processing'). Pausing 10s and retrying.`);
      await new Promise(r => setTimeout(r, 10_000));
      continue;
    }

    // Small inter-iteration pause to be polite to Mailgun and the DB.
    await new Promise(r => setTimeout(r, 500));
  }

  // 4. Ensure final status is 'sent' if everything drained.
  const finalPending = await countRows(q => q.in('status', ['pending', 'processing']));
  if (finalPending === 0) {
    const finalSent = await countRows(q => q.in('status', ['sent', 'delivered', 'opened', 'clicked']));
    await updateCampaign(CAMPAIGN_ID, {
      status: 'sent',
      completed_at: new Date().toISOString(),
      sent_count: finalSent,
    }, TENANT_ID);
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    console.log(`[resume-graftas] Campaign marked 'sent'. final sent_count=${finalSent}, elapsed=${elapsedSec}s, totalSent=${totalSent}, totalFailed=${totalFailed}`);
  } else {
    console.warn(`[resume-graftas] Loop exited but ${finalPending} recipients remain. The cron will continue draining them every minute.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
  });
