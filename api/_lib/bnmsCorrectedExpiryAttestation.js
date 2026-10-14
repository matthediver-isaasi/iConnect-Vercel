// Historical membership evidence for the separately approved corrected-date
// cohort. This helper must never establish renewal policy or provider settlement.
export const CORRECTED_EXPIRY_SOURCE = 'bnms_corrected_expiry_operator_attestation';
export const CORRECTED_EXPIRY_COHORT = 'ac63496b148b5047c7ccb8ab28db0fd60919e5e79c898cf8e527393c5044d69c';
export const CORRECTED_EXPIRY_APPROVAL_DATE = '2026-10-14';
export function isBnmsCorrectedExpiryAttestation(h) {
  let notes;
  try { notes = typeof h?.notes === 'string' ? JSON.parse(h.notes) : h?.notes; } catch { return false; }
  if (!h || h.tenant_id !== 'ff2df806-b321-4254-b651-3af11fccf1db'
    || !h.member_id || h.organization_id || !['active','expired'].includes(h.status)
    || h.payment_status !== 'paid' || !['upfront','direct_debit'].includes(h.payment_method)
    || h.membership_year !== 'Legacy membership (start unknown)' || h.billing_period !== 'annual'
    || !/^\d{4}-\d{2}-\d{2}$/.test(h.term_end_date || '')
    || h.term_end_date < '2024-12-11' || h.term_end_date > '2027-10-06') return false;
  const parsed = new Date(`${h.term_end_date}T00:00:00Z`);
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0,10) !== h.term_end_date) return false;
  // Unknowns remain unknown. This is not a billing commitment or invoice link.
  if (['term_start_date','config_id','billing_agreement_id','annual_cost','prorata_cost',
    'final_cost','total_with_vat','currency','paid_at','accounting_provider',
    'accounting_invoice_id','accounting_invoice_number','xero_invoice_id','xero_invoice_number',
    'membership_renewal_date','renewal_policy_snapshot','term_key','term_duration_months',
    'term_anchor_date','previous_term_id','commitment_snapshot','membership_successor_election_id',
    'stripe_payment_intent_id'].some(key => h[key] != null)) return false;
  return notes?.source === CORRECTED_EXPIRY_SOURCE && notes.version === 1
    && notes.cohortHash === CORRECTED_EXPIRY_COHORT
    && notes.approvalDate === CORRECTED_EXPIRY_APPROVAL_DATE
    && notes.scope === 'historical_entitlement_only'
    && notes.paymentAuthority === 'operator_confirmed_paid'
    && notes.startDateAuthority === 'unknown_not_inferred'
    && notes.expiryAuthority === 'retained_corrected_legacy_expiry'
    && notes.invoiceAuthority === 'not_verified_not_linked'
    && notes.historicalAmountAuthority === 'unknown_not_inferred'
    && notes.currencyAuthority === 'unknown_not_inferred'
    && notes.ddEvidenceRecorded === (h.payment_method === 'direct_debit')
    && notes.memberId === h.member_id && notes.expiry === h.term_end_date
    && /^[a-f0-9]{64}$/.test(notes.sourceHash || '');
}
