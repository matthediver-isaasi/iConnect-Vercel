// Recognition only: this is not authority for renewal, invoicing or collection.
export function isBnmsExpiryGapEvidence(record) {
  if (record?.tenant_id !== 'ff2df806-b321-4254-b651-3af11fccf1db'
      || record.membership_source !== 'personal' || record.membership_year !== '2026/2027'
      || record.status !== 'active' || record.payment_status !== 'paid'
      || record.payment_method !== 'upfront' || record.billing_period !== 'annual'
      || record.currency !== 'GBP' || !record.tier_label
      || record.config_id != null || record.term_start_date != null
      || record.membership_renewal_date != null || record.term_key != null
      || record.term_duration_months != null || record.commitment_snapshot != null
      || record.billing_agreement_id != null
      || record.final_cost !== null || record.total_with_vat !== null
      || record.accounting_invoice_id != null || record.xero_invoice_id != null) return false;
  const expiry = record.term_end_date;
  if (typeof expiry !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)
      || expiry < '2027-01-01' || expiry > '2027-10-19'
      || !Number.isFinite(Date.parse(expiry))
      || new Date(expiry).toISOString().slice(0,10) !== expiry) return false;
  let notes;
  try {notes = typeof record.notes === 'string' ? JSON.parse(record.notes) : record.notes;} catch {return false;}
  return notes?.source === 'bnms_2027_expiry_gap_correction'
    && notes.version === 1
    && notes.approval === 'owner_authorised_same_condition_correction_2026_10_19'
    && notes.expiryAuthority === 'retained_legacy_expiry'
    && notes.startDateAuthority === 'unknown_not_inferred'
    && notes.paymentAuthority === 'imported_paid_membership_invoice_not_provider_reverified'
    && Array.isArray(notes.historicalInvoiceIds) && notes.historicalInvoiceIds.length > 0;
}
