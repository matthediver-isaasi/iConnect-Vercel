/**
 * Durable linkage between a pending form submission and its provisional
 * monthly-card billing agreement / Stripe Checkout session.
 */
import { createHash } from 'node:crypto';

export function formMonthlyCardAgreementKey(submissionId) {
  if (!submissionId) throw new Error('submissionId is required');
  return `form-card:${submissionId}`;
}

export function normalizeFormMonthlyCardEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/**
 * Provider/database idempotency shared by all attempts for one applicant and
 * membership year. The email is hashed so it never appears in logs or keys.
 * This prevents two tabs with different form idempotency keys from creating
 * two Stripe subscriptions before either form has created/resolved the member.
 */
export function formMonthlyCardApplicantAgreementKey({ tenantId, email, membershipYear }) {
  const normalized = normalizeFormMonthlyCardEmail(email);
  if (!tenantId || !normalized || !membershipYear) {
    throw new Error('tenantId, applicant email, and membershipYear are required');
  }
  const digest = createHash('sha256')
    .update(`${tenantId}\n${normalized}\n${membershipYear}`)
    .digest('hex');
  return `form-card-applicant:${digest}`;
}

export async function findExistingFormApplicantMember(db, { tenantId, email }) {
  const normalized = normalizeFormMonthlyCardEmail(email);
  if (!tenantId || !normalized) return { data: null, error: null };
  // Match process-application's tenant-scoped, case-insensitive email lookup.
  // Escape ILIKE wildcard characters so an email is always an exact identity.
  const pattern = normalized.replace(/[\\%_]/g, '\\$&');
  const { data, error } = await db
    .from('member')
    .select('id, email')
    .eq('tenant_id', tenantId)
    .ilike('email', pattern)
    .limit(2);
  if (error) return { data: null, error };
  if ((data || []).length > 1) {
    return { data: null, error: new Error('Applicant email matches more than one member') };
  }
  return { data: data?.[0] || null, error: null };
}

/**
 * Atomically attach the resolved member and reserve their membership year.
 * The SECURITY DEFINER RPC validates the agreement/submission association,
 * serializes on tenant+member+year, rejects any other history/open agreement,
 * and inserts the pending history row in the same transaction.
 */
export async function claimFormMonthlyCardMembership(db, {
  agreementId,
  submissionId,
  memberId,
  history,
  reserveOnly = false,
}) {
  const { data, error } = await db.rpc('claim_form_monthly_card_membership', {
    p_agreement_id: agreementId,
    p_submission_id: submissionId,
    p_member_id: memberId,
    p_history: history || {},
    p_reserve_only: reserveOnly === true,
  });
  if (error) {
    return {
      ok: false,
      retryable: true,
      detail: `membership-year claim failed: ${error.message}`,
    };
  }
  if (!data || data.ok !== true) {
    return {
      ok: false,
      conflict: data?.conflict === true,
      retryable: data?.conflict !== true,
      code: data?.code || null,
      detail: data?.detail || 'membership-year claim did not complete',
      historyId: data?.history_id || null,
      conflictingAgreementId: data?.agreement_id || null,
    };
  }
  return {
    ok: true,
    historyId: data.history_id || null,
    idempotent: data.idempotent === true,
    reserved: data.reserved === true,
  };
}

export async function releaseExpiredFormMonthlyCardCheckout(db, {
  agreementId,
  checkoutSessionId,
}) {
  if (!agreementId || !checkoutSessionId) {
    return { ok: false, retryable: false, detail: 'agreement and Checkout session are required' };
  }
  const { data, error } = await db.rpc('release_expired_form_monthly_card_checkout', {
    p_agreement_id: agreementId,
    p_checkout_session_id: checkoutSessionId,
  });
  if (error) {
    return {
      ok: false,
      retryable: true,
      detail: `expired Checkout release failed: ${error.message}`,
    };
  }
  return {
    ok: data?.ok === true,
    released: data?.released === true,
    idempotent: data?.idempotent === true,
    retryable: data?.ok !== true,
    code: data?.code || null,
    detail: data?.detail || null,
  };
}

export async function persistMonthlyCheckoutLink(db, submission, offer, agreement) {
  if (!submission?.id || !agreement?.id) {
    throw new Error('Submission and billing agreement are required');
  }
  if (!agreement.redirect_url || !agreement.stripe_checkout_session_id) {
    throw new Error('Billing agreement does not have a published Stripe Checkout session');
  }

  const current = submission.payment_meta?.monthly_card || {};
  const nextMonthly = {
    ...current,
    offer,
    agreement_id: agreement.id,
    checkout_url: agreement.redirect_url,
    checkout_session_id: agreement.stripe_checkout_session_id,
  };
  const alreadyLinked = current.agreement_id === nextMonthly.agreement_id
    && current.checkout_url === nextMonthly.checkout_url
    && current.checkout_session_id === nextMonthly.checkout_session_id;
  if (alreadyLinked) return submission;

  const { data, error } = await db
    .from('form_submission')
    .update({
      payment_meta: {
        ...(submission.payment_meta || {}),
        monthly_card: nextMonthly,
      },
    })
    .eq('id', submission.id)
    .eq('payment_status', 'pending')
    .select()
    .maybeSingle();
  if (error || !data) {
    throw new Error(error?.message || 'Pending submission could not be linked to card checkout');
  }
  return data;
}

export async function findFormMonthlyCardAgreement(db, {
  tenantId,
  submissionId,
  agreementId = null,
}) {
  if (!tenantId || !submissionId) return { data: null, error: null };
  if (agreementId) {
    return db
      .from('membership_billing_agreements')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('id', agreementId)
      .maybeSingle();
  }
  const byLegacyKey = await db
    .from('membership_billing_agreements')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('idempotency_key', formMonthlyCardAgreementKey(submissionId))
    .maybeSingle();
  if (byLegacyKey.error || byLegacyKey.data) return byLegacyKey;
  return db
    .from('membership_billing_agreements')
    .select('*')
    .eq('tenant_id', tenantId)
    .filter('metadata->>form_submission_id', 'eq', String(submissionId))
    .maybeSingle();
}