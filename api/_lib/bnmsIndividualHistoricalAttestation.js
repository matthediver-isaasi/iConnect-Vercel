// Reporting only: separately approved historical entitlement, not renewal consent.
export const INDIVIDUAL_HISTORY_SOURCE = 'bnms_individual_historical_attestation';
export function isBnmsIndividualHistoricalAttestation(h) {
  let n; try { n=typeof h?.notes==='string'?JSON.parse(h.notes):h?.notes; } catch { return false; }
  return h?.tenant_id==='ff2df806-b321-4254-b651-3af11fccf1db'
    && h.member_id==='eda44595-1c5d-4bf8-8395-8c75b19774b5'
    && h.term_end_date==='2026-08-27' && ['active','expired'].includes(h.status)
    && h.payment_status==='paid' && h.payment_method==='upfront'
    && h.membership_year==='Legacy membership (start unknown)' && h.billing_period==='annual'
    && ['organization_id','term_start_date','config_id','billing_agreement_id','annual_cost',
      'prorata_cost','final_cost','total_with_vat','currency','paid_at','accounting_invoice_id',
      'xero_invoice_id','membership_renewal_date','renewal_policy_snapshot','commitment_snapshot',
      'previous_term_id','term_key'].every(k=>h[k]==null)
    && n?.source===INDIVIDUAL_HISTORY_SOURCE && n.version===1
    && n.approvalDate==='2026-10-14' && n.scope==='historical_entitlement_only'
    && n.memberId===h.member_id && n.expiry===h.term_end_date
    && n.paymentAuthority==='operator_confirmed_paid'
    && n.startDateAuthority==='unknown_not_inferred'
    && n.invoiceAuthority==='not_verified_not_linked'
    && /^[a-f0-9]{64}$/.test(n.sourceHash||'');
}
