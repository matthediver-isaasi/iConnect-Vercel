// Reporting evidence only. Deliberately separate from renewal-policy authority.
export const UNEXPIRED_SOURCE = 'bnms_unexpired_2027_operator_attestation';
export function isBnmsUnexpiredAttestation(h) {
  let notes;
  try { notes = typeof h.notes === 'string' ? JSON.parse(h.notes) : h.notes; } catch { return false; }
  return h.tenant_id === 'ff2df806-b321-4254-b651-3af11fccf1db'
    && !!h.member_id && !h.organization_id && h.status === 'active'
    && h.payment_status === 'paid' && h.payment_method === 'upfront'
    && h.membership_year === 'Legacy membership (start unknown)'
    && h.term_start_date == null && h.config_id == null && h.billing_agreement_id == null
    && h.final_cost == null && h.total_with_vat == null
    && typeof h.term_end_date === 'string'
    && h.term_end_date >= '2027-01-04' && h.term_end_date <= '2027-08-28'
    && notes?.source === UNEXPIRED_SOURCE && notes.version === 1
    && notes.paymentAuthority === 'operator_confirmed_paid'
    && notes.startDateAuthority === 'unknown_not_inferred'
    && notes.expiryAuthority === 'retained_legacy_expiry'
    && notes.memberId === h.member_id && notes.expiry === h.term_end_date;
}
