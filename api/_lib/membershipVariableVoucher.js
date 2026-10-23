import { variableMembershipCreditSchedule } from './membershipVariableVoucherAllocation.js';

export const hasVariableVoucherFunding = agreement =>
  agreement?.metadata?.dd?.voucher_funding?.variable_credit === true;

export function variableFundedSnapshot(snapshot, funding, settlementId) {
  if (!settlementId || funding.variableCredit !== true
      || snapshot.collection_policy?.pricing_policy !== 'dynamic'
      || snapshot.payment_mode !== 'direct_debit' || snapshot.invoicing_mode !== 'per_instalment'
      || funding.currency !== snapshot.currency || !snapshot.commitment?.term_key
      || funding.payableMinor !== null || funding.remainingMinor !== null) {
    throw new Error('Variable voucher funding does not match the purchased Direct Debit term');
  }
  const creditSchedule = variableMembershipCreditSchedule({
    creditMinor: funding.voucherMinor, instalmentCount: snapshot.instalment_count,
  });
  if (JSON.stringify(creditSchedule) !== JSON.stringify(funding.creditSchedule)) {
    throw new Error('Reserved variable credit schedule changed');
  }
  return { ...snapshot, plan_total: null, billing_request_payment: null,
    voucher_funding: { variable_credit: true, settlement_id: settlementId,
      term_key: snapshot.commitment.term_key, instalment_count: snapshot.instalment_count,
      credit_minor: funding.voucherMinor, creditSchedule, allocations: funding.allocations } };
}

export async function settleVariableVoucherCollection(db, reservationId, tenantId) {
  const result = await db.rpc('membership_variable_voucher_settle_collection', {
    p_tenant_id: tenantId, p_reservation_id: reservationId,
  });
  if (result.error) throw new Error(result.error.message);
  if (!result.data?.id) throw new Error('Variable collection settlement evidence is missing');
  return result.data;
}

export async function variableVoucherInvoicePrice(db, tenantId, price) {
  let rate = 0;
  if (price.vat_rate) {
    let tax;
    try { tax = typeof price.vat_rate === 'string' ? JSON.parse(price.vat_rate) : price.vat_rate; }
    catch { tax = { taxType: price.vat_rate }; }
    const loaded = await db.from('system_settings').select('setting_value')
      .eq('tenant_id', tenantId).eq('setting_key', `xero_vat_rates_${tenantId}`).maybeSingle();
    if (loaded.error) throw new Error('Actual collection tax rates are unavailable');
    let rates;
    try { rates = JSON.parse(loaded.data?.setting_value || '{}').rates; } catch { /* reject below */ }
    const matches = rates?.filter(row => row.taxType === tax?.taxType);
    if (matches?.length !== 1 || matches[0].effectiveRate == null) throw new Error('Actual collection tax rate requires reconciliation');
    rate = Number(matches[0].effectiveRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error('Actual collection tax rate is invalid');
  }
  const net = Math.round(price.monthly_amount_minor / (1 + rate / 100));
  if (net + Math.round(net * rate / 100) !== price.monthly_amount_minor) {
    throw new Error('Actual collection tax rounding does not reconcile to its gross price');
  }
  return { ...price, invoice_net_minor: net, invoice_vat_rate_percent: rate };
}
