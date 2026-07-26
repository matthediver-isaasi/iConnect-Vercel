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
  retry_scheduled: {
    subject: (c) => `Membership payment retry scheduled`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>A retry of your monthly membership payment of ${c.currency} ${c.monthlyAmount} has been scheduled.</p>
      <p>Please make sure funds are available in your account. You'll receive advance notice from GoCardless before the collection.</p>`,
  },
  new_mandate_required: {
    subject: (c) => `New Direct Debit set-up needed for your membership`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>Your Direct Debit mandate for the ${c.yearLabel} membership is no longer usable, so we can't collect your monthly payments.</p>
      <p>To keep your membership payments on track, please set up a new Direct Debit${c.setupUrl ? ` using this secure link: <a href="${c.setupUrl}">${c.setupUrl}</a>` : ' from your membership payment page'}.</p>
      <p>No payment is taken until the new mandate is active, and you will never be charged twice for the same instalment.</p>`,
  },
  mandate_cancelled: {
    subject: (c) => `Your membership Direct Debit mandate was cancelled`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>The Direct Debit mandate for your ${c.yearLabel} membership has been cancelled, so no further payments can be collected.</p>
      <p>Your membership itself has NOT been cancelled. To continue paying monthly, please set up a new Direct Debit, or contact us to arrange a different payment method.</p>`,
  },
  at_risk_of_suspension: {
    subject: (c) => `Action needed — membership at risk`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>We still haven't been able to collect your monthly membership payments and the grace period has now ended.</p>
      <p>Your membership benefits may be restricted or suspended until payments are brought up to date. Please contact us or resolve the payment problem from your membership page as soon as possible.</p>`,
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
  // Phase 5 — renewals & migration -----------------------------------------
  renewal_notice: {
    subject: (c) => `Your membership renews soon — ${c.renewalYear || 'next year'}`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>Your ${c.yearLabel} membership is coming to an end, and your monthly Direct Debit is set to renew automatically for ${c.renewalYear || 'the next membership year'}.</p>
      <p>The renewal plan will be <strong>${c.newInstalmentCount || c.instalmentCount} monthly payments of ${c.newCurrency || c.currency} ${c.newMonthlyAmount || c.monthlyAmount}</strong>${c.newPlanTotal ? ` (total ${c.newCurrency || c.currency} ${c.newPlanTotal})` : ''}, collected using your existing Direct Debit mandate — no action is needed.</p>
      <p>If you do not wish to renew, or your details have changed, please contact us before the new membership year begins.</p>`,
  },
  renewal_confirmation_required: {
    subject: (c) => `Action needed — confirm your membership renewal for ${c.renewalYear || 'next year'}`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>Your ${c.yearLabel} membership is coming to an end. To continue paying by monthly Direct Debit for ${c.renewalYear || 'the next membership year'}, please confirm your renewal.</p>
      <p>The new plan will be <strong>${c.newInstalmentCount || c.instalmentCount} monthly payments of ${c.newCurrency || c.currency} ${c.newMonthlyAmount || c.monthlyAmount}</strong>${c.newPlanTotal ? ` (total ${c.newCurrency || c.currency} ${c.newPlanTotal})` : ''}.</p>
      <p>Confirm from your membership payment page once the new membership year opens — your existing Direct Debit mandate will be reused, so there is no need to re-enter bank details.</p>
      <p>If you do nothing, no payment will be taken for the new year.</p>`,
  },
  renewal_confirmed: {
    subject: (c) => `Membership renewal confirmed — ${c.yearLabel}`,
    body: (c) => `
      <p>Hi ${c.firstName},</p>
      <p>Your membership has been renewed for ${c.yearLabel}: ${c.instalmentCount} monthly payments of ${c.currency} ${c.monthlyAmount} by Direct Debit, using your existing mandate.</p>
      ${c.firstChargeDate ? `<p>Your first collection for the new year is expected on or around <strong>${c.firstChargeDate}</strong>.</p>` : ''}
      <p>You'll receive advance notice from GoCardless before each collection.</p>`,
  },
};

export const DD_EMAIL_EVENTS = Object.freeze(Object.keys(EVENTS));

function contextFromAgreement(agreement, member) {
  const snap = agreement?.metadata?.dd || {};
  return {
    firstName: member?.first_name || (agreement?.organization_id ? 'there' : 'Member'),
    yearLabel: snap.membership_year || 'this year',
    instalmentCount: snap.instalment_count || 12,
    monthlyAmount: snap.monthly_amount != null ? Number(snap.monthly_amount).toFixed(2) : '',
    currency: snap.currency || 'GBP',
    firstChargeDate: null,
  };
}

/**
 * Resolve lifecycle-email recipients for an agreement.
 *   member agreement       -> the member's email
 *   organisation agreement -> billing contact email (if payer) + the primary
 *                             contact member's email, de-duplicated.
 * Returns { recipients: [{ email, firstName }], reason? }.
 */
export async function resolveDdEmailRecipients(agreement, { db = supabase } = {}) {
  if (agreement?.member_id) {
    const { data: member, error } = await db
      .from('member')
      .select('id, email, first_name, last_name')
      .eq('id', agreement.member_id)
      .maybeSingle();
    if (error || !member?.email) return { recipients: [], reason: 'member email not found' };
    return { recipients: [{ email: member.email, firstName: member.first_name || 'Member' }] };
  }

  if (agreement?.organization_id) {
    const recipients = [];
    if (agreement.dd_payer === 'billing_contact' && agreement.billing_contact_email) {
      recipients.push({
        email: agreement.billing_contact_email,
        firstName: (agreement.billing_contact_name || '').trim().split(/\s+/)[0] || 'there',
      });
    }
    if (agreement.primary_contact_member_id) {
      const { data: member } = await db
        .from('member')
        .select('id, email, first_name')
        .eq('id', agreement.primary_contact_member_id)
        .maybeSingle();
      if (member?.email) {
        recipients.push({ email: member.email, firstName: member.first_name || 'there' });
      }
    }
    const seen = new Set();
    const deduped = recipients.filter((r) => {
      const key = r.email.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return deduped.length ? { recipients: deduped } : { recipients: [], reason: 'no organisation recipients' };
  }

  return { recipients: [], reason: 'no member or organisation on agreement' };
}

/**
 * Send one lifecycle email for a DD agreement. Resolves recipients itself
 * (member, or org billing contact + primary contact).
 * Never throws — logs and returns { sent: boolean }.
 */
export async function sendDdLifecycleEmail(eventKey, agreement, { db = supabase, send = sendTenantEmail, extraContext = {} } = {}) {
  try {
    const tpl = EVENTS[eventKey];
    if (!tpl) return { sent: false, reason: `unknown event ${eventKey}` };

    const { recipients, reason } = await resolveDdEmailRecipients(agreement, { db });
    if (!recipients.length) return { sent: false, reason: reason || 'no recipients' };

    let sentAny = false;
    let lastError = null;
    for (const recipient of recipients) {
      const ctx = { ...contextFromAgreement(agreement, { first_name: recipient.firstName }), ...extraContext };
      const result = await send({
        tenantId: agreement.tenant_id,
        to: recipient.email,
        subject: tpl.subject(ctx),
        html: tpl.body(ctx),
      });
      if (result && result.success === false) {
        console.error(`[DD Emails] ${eventKey} send failed for agreement ${agreement.id} (${recipient.email}):`, result.error);
        lastError = result.error;
      } else {
        sentAny = true;
      }
    }
    return sentAny ? { sent: true } : { sent: false, reason: lastError || 'send failed' };
  } catch (err) {
    console.error(`[DD Emails] ${eventKey} failed for agreement ${agreement?.id}:`, err.message);
    return { sent: false, reason: err.message };
  }
}

/**
 * Phase 5 — migration invitation email (tenant -> member): invite an
 * existing Stripe/invoice-paying member to switch to monthly Direct Debit
 * from a given membership year. No agreement exists yet, so this takes the
 * offer terms directly. Never throws — returns { sent: boolean }.
 */
export async function sendDdMigrationInviteEmail({ tenantId, member, invite, offer, setupUrl, send = sendTenantEmail } = {}) {
  try {
    if (!tenantId || !member?.email || !invite?.token || !offer || !setupUrl) {
      return { sent: false, reason: 'missing tenantId/member/invite/offer/setupUrl' };
    }
    const firstName = member.first_name || 'Member';
    const currency = offer.currency || 'GBP';
    const monthly = Number(offer.monthlyAmount).toFixed(2);
    const total = offer.planTotal != null ? Number(offer.planTotal).toFixed(2) : '';
    const expiry = invite.expires_at
      ? new Date(invite.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
      : null;
    const result = await send({
      tenantId,
      to: member.email,
      subject: `Switch your membership to monthly Direct Debit`,
      html: `
        <p>Hi ${firstName},</p>
        <p>You can now pay your membership by monthly Direct Debit, starting from the <strong>${invite.switch_from_year}</strong> membership year.</p>
        <p>The plan is ${offer.instalmentCount} monthly payments of ${currency} ${monthly}${total ? ` (total ${currency} ${total})` : ''}. Your current membership and payment method are not affected — the switch only applies from ${invite.switch_from_year}.</p>
        <p><a href="${setupUrl}">Review the details and set up your Direct Debit</a></p>
        ${expiry ? `<p>This link expires on <strong>${expiry}</strong>.</p>` : ''}
        <p>Payments are protected by the Direct Debit Guarantee. If you'd rather keep paying as you do now, you can simply ignore this email or decline from the link above.</p>`,
    });
    if (result && result.success === false) {
      console.error(`[DD Emails] migration invite send failed (member ${member.id}):`, result.error);
      return { sent: false, reason: result.error };
    }
    return { sent: true };
  } catch (err) {
    console.error('[DD Emails] migration invite failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

/**
 * Phase 3 — billing-contact invitation email. Carries the secure set-up
 * link; states org, category, monthly amount, instalments, total, expiry.
 * Never throws — returns { sent: boolean }.
 */
export async function sendDdInvitationEmail({ agreement, invitation, organizationName, setupUrl, db = supabase, send = sendTenantEmail } = {}) {
  try {
    if (!agreement || !invitation?.invited_email || !setupUrl) {
      return { sent: false, reason: 'missing agreement/invitation/setupUrl' };
    }
    const snap = agreement.metadata?.dd || {};
    const firstName = (invitation.invited_name || '').trim().split(/\s+/)[0] || 'there';
    const currency = snap.currency || 'GBP';
    const monthly = snap.monthly_amount != null ? Number(snap.monthly_amount).toFixed(2) : '';
    const total = snap.plan_total != null ? Number(snap.plan_total).toFixed(2) : '';
    const expiry = invitation.expires_at
      ? new Date(invitation.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
      : null;

    const result = await send({
      tenantId: agreement.tenant_id,
      to: invitation.invited_email,
      subject: `Direct Debit set-up requested for ${organizationName || 'your organisation'}`,
      html: `
        <p>Hi ${firstName},</p>
        <p>You've been asked to set up the Direct Debit for <strong>${organizationName || 'your organisation'}</strong>'s
        ${snap.membership_year || ''} membership${snap.tier_label ? ` (${snap.tier_label})` : ''}.</p>
        <p>The plan is ${snap.instalment_count || 12} monthly payments of ${currency} ${monthly}${total ? ` (total ${currency} ${total})` : ''}.</p>
        <p><a href="${setupUrl}">Review the details and set up the Direct Debit</a></p>
        ${expiry ? `<p>This link expires on <strong>${expiry}</strong>.</p>` : ''}
        <p>You'll be asked to confirm that you are authorised to set up Direct Debits on the organisation's bank account.
        Payments are protected by the Direct Debit Guarantee.</p>`,
    });
    if (result && result.success === false) {
      console.error(`[DD Emails] invitation send failed for agreement ${agreement.id}:`, result.error);
      return { sent: false, reason: result.error };
    }
    return { sent: true };
  } catch (err) {
    console.error(`[DD Emails] invitation failed for agreement ${agreement?.id}:`, err.message);
    return { sent: false, reason: err.message };
  }
}
