/**
 * Server-owned linkage for member-scoped GoCardless monthly Direct Debit
 * applications.  Applicant identity is deliberately represented only by a
 * digest in idempotency keys and agreement metadata.
 */
import { createHash } from 'node:crypto';

export function normalizeFormMonthlyDirectDebitEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

export function formMonthlyDirectDebitAgreementKey(submissionId) {
  if (!submissionId) throw new Error('submissionId is required');
  return `form-dd:${submissionId}`;
}

export function formMonthlyDirectDebitApplicantAgreementKey({ tenantId, email, membershipYear }) {
  const normalized = normalizeFormMonthlyDirectDebitEmail(email);
  if (!tenantId || !normalized || !membershipYear) {
    throw new Error('tenantId, applicant email, and membershipYear are required');
  }
  const digest = createHash('sha256')
    .update(`${tenantId}\n${normalized}\n${membershipYear}`)
    .digest('hex');
  return `form-dd-applicant:${digest}`;
}

export function formMonthlyDirectDebitSubmissionKey({ browserKey, email, tenantId, membershipYear }) {
  const normalized = normalizeFormMonthlyDirectDebitEmail(email);
  if (!browserKey?.trim?.() || !tenantId || !normalized || !membershipYear) {
    throw new Error('browser key, tenant, applicant email, and membershipYear are required');
  }
  const digest = createHash('sha256')
    .update(`${tenantId}\n${browserKey.trim()}\n${normalized}\n${membershipYear}`)
    .digest('hex');
  return `monthly-dd-v1:${digest}`;
}

export async function claimFormMonthlyDirectDebitApplicantAgreement(db, {
  tenantId, submissionId, applicantEmail, membershipYear, agreementKey,
  environment, ddSnapshot, memberId = null,
}) {
  const { data, error } = await db.rpc('claim_form_monthly_direct_debit_applicant_agreement', {
    p_tenant_id: tenantId,
    p_submission_id: submissionId,
    p_applicant_email: normalizeFormMonthlyDirectDebitEmail(applicantEmail),
    p_membership_year: membershipYear,
    p_agreement_key: agreementKey,
    p_environment: environment,
    p_dd_snapshot: ddSnapshot || {},
    p_member_id: memberId,
  });
  if (error) return { data: null, error };
  if (data?.ok !== true || !data.agreement) {
    const e = new Error(data?.detail || 'Applicant agreement claim did not complete');
    e.code = data?.code || 'AGREEMENT_CLAIM_FAILED';
    return { data: null, error: e };
  }
  return { data: data.agreement, error: null, recoveredLegacy: data.recovered_legacy === true };
}

export async function persistMonthlyDirectDebitLink(db, submission, offer, agreement, {
  billingRequestId = agreement?.gocardless_billing_request_id,
  billingRequestFlowId = agreement?.gocardless_billing_request_flow_id,
} = {}) {
  if (!submission?.id || !agreement?.id) throw new Error('Submission and billing agreement are required');
  if (!agreement.tenant_id || !submission.tenant_id || agreement.tenant_id !== submission.tenant_id) {
    throw new Error('Billing agreement tenant does not match submission');
  }
  if (agreement.provider && agreement.provider !== 'gocardless') {
    throw new Error('Billing agreement provider is not GoCardless');
  }
  if (String(agreement.metadata?.form_submission_id || submission.id) !== String(submission.id)) {
    throw new Error('Billing agreement is not linked to this submission');
  }
  if (submission.payment_provider !== 'gocardless_monthly_dd' || submission.payment_status !== 'pending') {
    throw new Error('Submission is not a pending monthly Direct Debit submission');
  }
  if (!billingRequestId || !billingRequestFlowId) {
    throw new Error('Billing agreement does not have a published GoCardless Billing Request flow');
  }
  const current = submission.payment_meta?.monthly_direct_debit || {};
  const next = {
    ...current, offer, agreement_id: agreement.id,
    billing_request_id: billingRequestId, billing_request_flow_id: billingRequestFlowId,
  };
  if (current.agreement_id === next.agreement_id
    && current.billing_request_id === next.billing_request_id
    && current.billing_request_flow_id === next.billing_request_flow_id
    && submission.payment_reference === billingRequestId) return submission;
  const { data, error } = await db.from('form_submission')
    .update({
      payment_meta: { ...(submission.payment_meta || {}), monthly_direct_debit: next },
      payment_reference: billingRequestId,
    })
    .eq('id', submission.id).eq('tenant_id', submission.tenant_id)
    .eq('payment_provider', 'gocardless_monthly_dd').eq('payment_status', 'pending')
    .select().maybeSingle();
  if (error || !data) throw new Error(error?.message || 'Pending submission could not be linked to Direct Debit');
  return data;
}

export async function findFormMonthlyDirectDebitAgreement(db, { tenantId, submissionId, agreementId = null }) {
  if (!tenantId || !submissionId) return { data: null, error: null };
  if (agreementId) return db.from('membership_billing_agreements').select('*')
    .eq('tenant_id', tenantId).eq('id', agreementId).maybeSingle();
  const byKey = await db.from('membership_billing_agreements').select('*')
    .eq('tenant_id', tenantId).eq('idempotency_key', formMonthlyDirectDebitAgreementKey(submissionId)).maybeSingle();
  if (byKey.error || byKey.data) return byKey;
  return db.from('membership_billing_agreements').select('*').eq('tenant_id', tenantId)
    .filter('metadata->>form_submission_id', 'eq', String(submissionId))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export function isFormMonthlyDirectDebitPending(submission, agreement = null) {
  return !!submission && submission.payment_status === 'pending'
    && (!agreement || ['payment_setup_required', 'mandate_pending'].includes(agreement.status));
}