// Task #2995 — Reconcile job postings stuck in `pending_payment` whose
// Stripe charge actually succeeded.
//
// Failure mode: after Stripe confirms the card, the browser must call
// `confirmJobPostingPayment` to flip the posting to paid/pending_approval.
// If that call never happens (tab closed, network error, JS error) the
// charge succeeds but the posting stays stuck with no server-side safety
// net. This helper is the safety net: it re-runs the exact same
// verification the browser confirm path performs (PaymentIntent status
// `succeeded` + metadata/stored-intent match) and flips genuinely-paid
// postings via an idempotent compare-and-set claim.
//
// Tenant resolution: historically `createJobPostingNonMember` inserted
// rows WITHOUT tenant_id, so many stuck rows have tenant_id NULL. For
// those we probe each Stripe-enabled tenant's account and only attribute
// the posting to a tenant whose PaymentIntent carries matching
// `metadata.job_posting_id` — the metadata written by
// `createJobPostingPaymentIntent` at charge time. A successful claim
// backfills tenant_id so the posting shows up in the tenant admin queue.
//
// Postings whose payment did not succeed are never touched.

import Stripe from 'stripe';
import { supabase } from './database.js';
import { getStripeCredentials } from './stripeCredentials.js';
import { sendEmail } from './emailService.js';

const LOG = '[jobPostingPaymentReconciliation]';

async function getStripeForTenant(tenantId) {
  if (!tenantId) return null;
  let creds;
  try {
    creds = await getStripeCredentials(tenantId, 'jobs');
  } catch (err) {
    console.error(`${LOG} failed to load Stripe credentials for tenant ${tenantId}: ${err.message}`);
    return null;
  }
  if (!creds || !creds.secret_key || !creds.is_enabled) return null;
  return new Stripe(creds.secret_key);
}

async function listStripeEnabledTenantIds() {
  const { data, error } = await supabase
    .from('tenant_integrations')
    .select('tenant_id')
    .eq('integration_type', 'stripe')
    .eq('is_enabled', true);
  if (error) {
    console.error(`${LOG} failed to list Stripe tenants: ${error.message}`);
    return [];
  }
  return (data || []).map((r) => r.tenant_id).filter(Boolean);
}

/**
 * Find the tenant whose Stripe account owns this posting's PaymentIntent,
 * and return the retrieved PaymentIntent alongside.
 *
 * - If the posting has a tenant_id, only that tenant is checked and the
 *   verification matches `confirmJobPostingPayment` exactly (metadata match
 *   OR stored-intent match — the stored match is inherently true here since
 *   we look the PI up by the stored id).
 * - If tenant_id is NULL, every Stripe-enabled tenant is probed and a
 *   tenant is only accepted when the PaymentIntent's metadata names this
 *   exact posting (prevents cross-tenant misattribution).
 */
async function resolvePaymentIntent(row) {
  const piId = row.stripe_payment_intent_id;

  if (row.tenant_id) {
    const stripe = await getStripeForTenant(row.tenant_id);
    if (!stripe) return { skippedReason: 'tenant-stripe-not-configured' };
    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.retrieve(piId);
    } catch (err) {
      if (err?.code === 'resource_missing') return { skippedReason: 'payment-intent-not-found' };
      throw err;
    }
    const metadataMatch = String(paymentIntent.metadata?.job_posting_id) === String(row.id);
    const storedMatch = row.stripe_payment_intent_id === paymentIntent.id;
    if (!metadataMatch && !storedMatch) return { skippedReason: 'verification-mismatch' };
    return { tenantId: row.tenant_id, paymentIntent };
  }

  // No tenant on the row — probe Stripe-enabled tenants; require metadata match.
  const tenantIds = await listStripeEnabledTenantIds();
  for (const tenantId of tenantIds) {
    const stripe = await getStripeForTenant(tenantId);
    if (!stripe) continue;
    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.retrieve(piId);
    } catch (err) {
      if (err?.code === 'resource_missing') continue; // not this tenant's account
      console.error(`${LOG} tenant ${tenantId} PI retrieve error for posting ${row.id}: ${err.message}`);
      continue;
    }
    if (String(paymentIntent.metadata?.job_posting_id) === String(row.id)) {
      return { tenantId, paymentIntent };
    }
    // PI id exists in this account but names a different posting — do not trust it.
    console.warn(`${LOG} tenant ${tenantId} has PI ${piId} but metadata.job_posting_id != ${row.id}; skipping`);
  }
  return { skippedReason: 'no-owning-tenant-found' };
}

/**
 * Reconcile a single job_posting row.
 *
 * @param {Object} args
 * @param {Object} args.row - a job_posting row (must include all columns used below)
 * @param {boolean} [args.sendEmails=true] - fire the poster/admin emails on success
 * @returns {Promise<{recordId, transitioned, skippedReason, tenantId?}>}
 */
export async function reconcileJobPostingRow({ row, sendEmails = true }) {
  if (!row) return skipped(null, 'row-not-found');
  const recordId = row.id;

  if (row.status !== 'pending_payment') return skipped(recordId, `already-${row.status}`);
  if (!row.stripe_payment_intent_id) return skipped(recordId, 'no-payment-intent');

  const resolved = await resolvePaymentIntent(row);
  if (!resolved.paymentIntent) return skipped(recordId, resolved.skippedReason);

  const { tenantId, paymentIntent } = resolved;

  if (paymentIntent.status !== 'succeeded') {
    return skipped(recordId, `payment-${paymentIntent.status}`);
  }

  // Compare-and-set claim: only one caller (cron run, script, or the
  // browser confirm path) can flip the row out of pending_payment.
  const update = {
    status: 'pending_approval',
    payment_status: 'paid',
    payment_date: new Date().toISOString(),
  };
  if (!row.tenant_id && tenantId) update.tenant_id = tenantId;

  // Trust Stripe for the amount actually charged (some stuck rows carry a
  // stale amount_paid from creation time; emails below quote this figure).
  const chargedAmount = (paymentIntent.amount_received ?? paymentIntent.amount) / 100;
  if (Number.isFinite(chargedAmount) && chargedAmount > 0 && Number(row.amount_paid) !== chargedAmount) {
    update.amount_paid = chargedAmount;
  }

  const { data: claimed, error: updateError } = await supabase
    .from('job_posting')
    .update(update)
    .eq('id', recordId)
    .eq('status', 'pending_payment')
    .select();

  if (updateError) {
    console.error(`${LOG} update failed for posting ${recordId}: ${updateError.message}`);
    throw new Error(updateError.message);
  }
  if (!claimed || claimed.length === 0) {
    // Someone else processed it between our read and write — no emails.
    return skipped(recordId, 'already-claimed');
  }

  const posting = claimed[0];
  console.log(`${LOG} posting ${recordId} reconciled -> pending_approval (tenant=${tenantId}, pi=${paymentIntent.id})`);

  if (sendEmails) {
    await sendReconciliationEmails({ posting, tenantId });
  }

  return { recordId, transitioned: true, skippedReason: null, tenantId };
}

/**
 * Same notifications as the normal payment-success path: poster
 * confirmation + admin review notification. Only called by the claim
 * winner, so no double-send. Email failures are logged, never thrown —
 * the posting is already recovered.
 */
async function sendReconciliationEmails({ posting, tenantId }) {
  let tenantName = 'The Team';
  try {
    const { data: tenantData } = await supabase
      .from('tenant')
      .select('name')
      .eq('id', tenantId)
      .single();
    if (tenantData?.name) tenantName = `${tenantData.name} Team`;
  } catch { /* keep default */ }

  // 1) Poster confirmation
  if (posting.contact_email) {
    const result = await sendEmail({
      to: posting.contact_email,
      subject: 'Job Posting Payment Confirmed - Pending Approval',
      tenantId,
      html: `
        <h2>Payment Confirmed!</h2>
        <p>Dear ${posting.contact_name || 'there'},</p>
        <p>Your payment of £${posting.amount_paid} for the job posting <strong>${posting.title}</strong> at <strong>${posting.company_name}</strong> has been received successfully.</p>
        <p>Your job posting is now pending approval from our team. You'll receive another email once it's approved and live on the job board.</p>
        <p><strong>Job Details:</strong></p>
        <ul>
          <li>Title: ${posting.title}</li>
          <li>Company: ${posting.company_name}</li>
          <li>Location: ${posting.location || ''}</li>
          <li>Type: ${posting.job_type || ''}</li>
        </ul>
        <p>Best regards,<br>${tenantName}</p>
      `,
    });
    if (!result?.success) {
      console.error(`${LOG} poster confirmation email failed for posting ${posting.id}: ${result?.error || 'unknown'}`);
    }
  }

  // 2) Admin review notification — members of this tenant whose role is an
  // ADMIN role that does not exclude job posting management. (The legacy
  // webhook filtered only on excluded_features, which matches ordinary
  // member roles too and can fan out to thousands of recipients — never
  // reuse that filter.) A hard cap bounds the blast radius regardless.
  const MAX_ADMIN_NOTIFICATIONS = 25;
  try {
    const { data: roles } = await supabase
      .from('role')
      .select('id, is_admin, is_tenant_admin, excluded_features')
      .eq('tenant_id', tenantId);
    const jobRoleIds = (roles || [])
      .filter((r) => (r.is_admin === true || r.is_tenant_admin === true)
        && !(r.excluded_features || []).includes('admin.job-postings'))
      .map((r) => r.id);
    if (jobRoleIds.length === 0) return;

    const { data: notifyMembers } = await supabase
      .from('member')
      .select('id, email')
      .eq('tenant_id', tenantId)
      .in('role_id', jobRoleIds)
      .limit(MAX_ADMIN_NOTIFICATIONS + 1);

    if ((notifyMembers || []).length > MAX_ADMIN_NOTIFICATIONS) {
      console.warn(`${LOG} admin notification recipient list exceeds ${MAX_ADMIN_NOTIFICATIONS} for tenant ${tenantId}; capping`);
      notifyMembers.length = MAX_ADMIN_NOTIFICATIONS;
    }

    for (const member of notifyMembers || []) {
      if (!member.email || member.email.endsWith('@deleted.local')) continue;
      const result = await sendEmail({
        to: member.email,
        subject: 'New Paid Job Posting Awaiting Approval',
        tenantId,
        html: `
          <h2>New Paid Job Posting Submitted</h2>
          <p>A non-member has paid and submitted a new job posting that requires approval:</p>
          <p><strong>Job Details:</strong></p>
          <ul>
            <li>Title: ${posting.title}</li>
            <li>Company: ${posting.company_name}</li>
            <li>Location: ${posting.location || ''}</li>
            <li>Posted by: ${posting.contact_name || ''} (${posting.contact_email || ''})</li>
            <li>Amount Paid: £${posting.amount_paid}</li>
          </ul>
          <p>Please log in to the admin portal to review and approve this posting.</p>
        `,
      });
      if (!result?.success) {
        console.error(`${LOG} admin notification email failed (to ${member.email}) for posting ${posting.id}: ${result?.error || 'unknown'}`);
      }
    }
  } catch (err) {
    console.error(`${LOG} admin notification error for posting ${posting.id}: ${err.message}`);
  }
}

function skipped(recordId, reason) {
  return { recordId, transitioned: false, skippedReason: reason };
}
