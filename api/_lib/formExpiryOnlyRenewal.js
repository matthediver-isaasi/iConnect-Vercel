import { isAttestedExpiryOnlyHistory } from './expiryOnlyRenewalPolicy.js';

// A server-loaded immutable assignment authorises a renewal window, not a
// historical commencement, price, provider settlement, or recurring consent.
export function hasFormExpiryOnlyProvenance(history, tenantId) {
  if (!isAttestedExpiryOnlyHistory(history, tenantId)) return false;
  let notes = history.notes;
  try { if (typeof notes === 'string') notes = JSON.parse(notes); } catch { return false; }
  return notes?.version === 1 && /^[a-f0-9]{64}$/.test(notes.sourceHash)
    && notes.paymentAuthority === 'operator_attested_upfront_paid_2025_2026'
    && notes.startDateAuthority === 'unknown_not_inferred'
    && notes.expiryAuthority === 'retained_legacy_expiry'
    && ['operator_attested_existing_2025_2026', 'operator_reviewed_pilot',
      'explicit_invoice_2025_2026'].includes(notes.termAuthority);
}

export function assignedFormExpiryPolicy(history, tenantId, policy) {
  return hasFormExpiryOnlyProvenance(history, tenantId)
    && policy?.policySource === 'operator_assigned_expiry_only'
    && policy.assignmentId && policy.configId && policy.tenantId === tenantId
    && policy.historyId === history.id && policy.memberId === history.member_id
    && policy.expiryDate === history.term_end_date
    && policy.renewalOpenDays === 90 && policy.renewalGraceDays === 90
    ? policy : null;
}