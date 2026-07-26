// GoCardless Phase 2 — Direct Debit lifecycle emails (tenant -> member).
//
// Lifecycle events (spec's seven milestones + failure/cancel paths):
//   setup_started               — member started the DD journey (hosted flow issued)
//   setup_incomplete            — hosted flow abandoned / billing request cancelled
//   mandate_active              — mandate confirmed
//   first_collection_scheduled  — subscription created; first collection date known
//   membership_activated        — membership flipped active per the tier's rule
//   first_payment               — first instalment collected
//   payment_confirmed           — a subsequent instalment collected
//   payment_failed              — an instalment failed (grace period)
//   payment_overdue             — repeated failure; plan needs attention
//   plan_cancelled              — mandate/subscription cancelled
//   plan_completed              — all instalments collected
//
// Best-effort by design: callers fire-and-forget; sendTenantEmail never
// throws upstream state handling. `send` is injectable for tests.

import { supabase } from './database.js';
import { sendTenantEmail } from './tenantEmailService.js';

const EVENTS = {
  setup_started: {
    subject: (c) => `Your Direct Debit set-up for ${c.yearLabel} membership`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>You've chosen to pay your ${c.yearLabel} membership by monthly Direct Debit
      (${c.instalmentCount} payments of ${c.currency} ${c.monthlyAmount}).</p>
      <p>Your Direct Debit mandate is being set up with your bank. We'll confirm as soon as it's active — no payment is taken until then.</p>`,
  },
  setup_incomplete: {
    subject: (c) => `Your Direct Debit set-up was not completed`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>Your monthly Direct Debit set-up for the ${c.yearLabel} membership was not completed, so no payment plan is in place yet.</p>
      <p>You can restart the set-up from your membership payment page at any time, or choose a different payment method.</p>`,
  },
  mandate_active: {
    subject: (c) => `Direct Debit confirmed — ${c.yearLabel} membership`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>Your Direct Debit mandate is now active. Your ${c.yearLabel} membership will be collected in
      ${c.instalmentCount} monthly payments of ${c.currency} ${c.monthlyAmount}.</p>
      ${c.firstChargeDate ? `<p>Your first collection is expected on or around <strong>${c.firstChargeDate}</strong>.</p>` : ''}
      <p>You'll receive advance notice from GoCardless before each collection.</p>`,
  },
  first_collection_scheduled: {
    subject: (c) => `First membership payment scheduled — ${c.yearLabel}`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>Your monthly membership payment plan is now in place: ${c.instalmentCount} payments of ${c.currency} ${c.monthlyAmount}.</p>
      ${c.firstChargeDate ? `<p>Your first collection is scheduled on or around <strong>${c.firstChargeDate}</strong>.</p>` : '<p>Your first collection will be taken as soon as your bank allows.</p>'}
      <p>GoCardless will notify you in advance of each collection, and your payments are protected by the Direct Debit Guarantee.</p>`,
  },
  membership_activated: {
    subject: (c) => `Your ${c.yearLabel} membership is now active`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>Good news — your ${c.yearLabel} membership is now active. Your annual membership is being paid in ${c.instalmentCount} monthly instalments of ${c.currency} ${c.monthlyAmount} by Direct Debit.</p>
      <p>Welcome aboard!</p>`,
  },
  first_payment: {
    subject: (c) => `First membership payment received — ${c.yearLabel}`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>Your first monthly membership payment of ${c.currency} ${c.monthlyAmount} has been collected successfully. Thank you!</p>
      <p>The remaining instalments will be collected automatically each month.</p>`,
  },
  payment_confirmed: {
    subject: (c) => `Membership payment received — ${c.yearLabel}`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>Your monthly membership payment of ${c.currency} ${c.monthlyAmount} has been collected successfully. Thank you!</p>`,
  },
  payment_failed: {
    subject: (c) => `Membership payment problem — action may be needed`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>A monthly membership payment of ${c.currency} ${c.monthlyAmount} could not be collected from your bank account.</p>
      <p>The payment will be retried automatically. Please make sure funds are available, or contact us if your bank details have changed.</p>`,
  },
  payment_overdue: {
    subject: (c) => `Membership payments overdue`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>We have been unable to collect your monthly membership payments, and your payment plan is now overdue.</p>
      <p>Please contact us to bring your membership up to date.</p>`,
  },
  plan_cancelled: {
    subject: (c) => `Your membership Direct Debit has been cancelled`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>Your Direct Debit for the ${c.yearLabel} membership has been cancelled. No further payments will be taken.</p>
      <p>If this wasn't intended, or you'd like to set up a new payment arrangement, please contact us.</p>`,
  },
  plan_completed: {
    subject: (c) => `Membership payments complete — ${c.yearLabel}`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>All ${c.instalmentCount} monthly payments for your ${c.yearLabel} membership have now been collected. Your membership is fully paid — thank you!</p>`,
  },
};

export const DD_EMAIL_EVENTS = Object.freeze(Object.keys(EVENTS));

function contextFromAgreement(agreement, member) {
  const snap = agreement?.metadata?.dd || {};
  return {
    firstName: member?.first_name || 'Member',
    yearLabel: snap.membership_year || 'this year',
    instalmentCount: snap.instalment_count || 12,
    monthlyAmount: snap.monthly_amount != null ? Number(snap.monthly_amount).toFixed(2) : '',
    currency: snap.currency || 'GBP',
    firstChargeDate: null,
  };
}

/**
 * Send one lifecycle email for a DD agreement. Loads the member itself.
 * Never throws — logs and returns { sent: boolean }.
 */
export async function sendDdLifecycleEmail(eventKey, agreement, { db = supabase, send = sendTenantEmail, extraContext = {} } = {}) {
  try {
    const tpl = EVENTS[eventKey];
    if (!tpl) return { sent: false, reason: `unknown event ${eventKey}` };
    if (!agreement?.member_id) return { sent: false, reason: 'no member on agreement' };

    const { data: member, error } = await db
      .from('member')
      .select('id, email, first_name, last_name')
      .eq('id', agreement.member_id)
      .maybeSingle();
    if (error || !member?.email) return { sent: false, reason: 'member email not found' };

    const ctx = { ...contextFromAgreement(agreement, member), ...extraContext };
    const result = await send({
      tenantId: agreement.tenant_id,
      to: member.email,
      subject: tpl.subject(ctx),
      html: tpl.body(ctx),
    });
    if (result && result.success === false) {
      console.error(`[DD Emails] ${eventKey} send failed for agreement ${agreement.id}:`, result.error);
      return { sent: false, reason: result.error };
    }
    return { sent: true };
  } catch (err) {
    console.error(`[DD Emails] ${eventKey} failed for agreement ${agreement?.id}:`, err.message);
    return { sent: false, reason: err.message };
  }
}
