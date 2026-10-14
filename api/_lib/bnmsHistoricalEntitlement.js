// Persisted historical evidence, not an inclusion list or renewal authority.
export const HISTORICAL_ENTITLEMENT_SOURCE = 'bnms_retained_expiry_historical_entitlement';
export function isBnmsHistoricalEntitlement(h) {
  let n;
  try { n = typeof h?.notes === 'string' ? JSON.parse(h.notes) : h?.notes; } catch { return false; }
  const date = h?.term_end_date;
  if (h?.tenant_id !== 'ff2df806-b321-4254-b651-3af11fccf1db' || !h.member_id
    || !['active','expired'].includes(h.status) || !h.tier_label
    || h.membership_year !== 'Legacy membership (start unknown)' || h.billing_period !== 'annual'
    || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(Date.parse(date))
    || new Date(date).toISOString().slice(0,10) !== date) return false;
  if (['organization_id','term_start_date','config_id','billing_agreement_id',
    'membership_renewal_date','renewal_policy_snapshot','commitment_snapshot','previous_term_id',
    'term_key','term_duration_months','term_anchor_date','membership_successor_election_id',
    'stripe_payment_intent_id'].some(k => h[k] != null)) return false;
  if (n?.source !== HISTORICAL_ENTITLEMENT_SOURCE || n.version !== 1
    || n.scope !== 'historical_entitlement_only' || n.memberId !== h.member_id || n.expiry !== date
    || n.startDateAuthority !== 'unknown_not_inferred' || n.expiryAuthority !== 'operator_approved_retained_expiry'
    || n.futureCollectionConsent !== false || n.providerWrites !== 0
    || !/^[a-f0-9]{64}$/.test(n.approvalHash || '') || !/^[a-f0-9]{64}$/.test(n.sourceHash || '')) return false;
  if (n.paymentAuthority === 'xero_authorised_payments') {
    return h.payment_status === 'paid' && h.payment_method === 'upfront' && h.currency === 'GBP'
      && h.accounting_provider === 'xero' && !!h.accounting_invoice_id && !!h.accounting_invoice_number
      && h.accounting_invoice_id === h.xero_invoice_id && h.accounting_invoice_number === h.xero_invoice_number
      && n.invoiceId === h.accounting_invoice_id && Array.isArray(n.paymentIds) && n.paymentIds.length > 0
      && Number.isFinite(Date.parse(h.paid_at)) && Number.isFinite(h.annual_cost) && h.annual_cost > 0
      && h.annual_cost === h.final_cost && h.final_cost === h.total_with_vat && h.vat_amount === 0;
  }
  if (['annual_cost','prorata_cost','final_cost','total_with_vat','vat_amount','currency','paid_at',
    'accounting_provider','accounting_invoice_id','accounting_invoice_number','xero_invoice_id',
    'xero_invoice_number'].some(k => h[k] != null)) return false;
  return n.invoiceAuthority === 'unresolved_not_linked' &&
    ((n.paymentAuthority === 'operator_confirmed_paid' && h.payment_status === 'paid' && h.payment_method === 'upfront')
    || (n.paymentAuthority === 'entitlement_only_not_cash_payment' && h.payment_status === 'unpaid'
      && h.payment_method === 'direct_debit'));
}
