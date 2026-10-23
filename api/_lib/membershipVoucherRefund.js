import { fundedMonthlySnapshot, monthlyFundingSlice } from './membershipVoucherMonthly.js';
import { refundVoucherAllocation } from './voucherCreditService.js';

export function membershipVoucherCancellationSummary(agreement) {
  const funding = (agreement?.metadata?.dd || agreement?.metadata?.card)?.voucher_funding;
  return funding ? { voucherFunding: {
    settlementId: funding.settlement_id, disposition: 'retained',
    reason: funding.variable_credit
      ? 'Uncollected credit is released when cancellation is confirmed. Credit tied to an uncertain payment remains reserved; settled credit follows the refund policy.'
      : 'Stopping future collections is not a refund under the existing cancellation policy.',
    allocations: funding.allocations.map(a => ({ voucherId: a.voucherId, ownerType: a.ownerType, displayName: a.displayName, amountMinor: a.amountMinor })),
  } } : {};
}

export function proportionalVoucherRefund(allocations, cashMinor, refundedMinor) {
  if (![cashMinor,refundedMinor].every(Number.isSafeInteger) || cashMinor <= 0 || refundedMinor < 0 || refundedMinor > cashMinor) {
    throw new Error('Confirmed cash refund exceeds the original collection');
  }
  let prefix = 0n;
  const numerator = BigInt(refundedMinor), denominator = BigInt(cashMinor);
  return allocations.map(a => {
    const before = prefix; prefix += BigInt(a.amountMinor);
    return { ...a, cumulativeMinor: Number(prefix * numerator / denominator - before * numerator / denominator) };
  });
}

export async function membershipVoucherRefundContext(db, payment, replacementExpiry = null) {
  const receipts = await db.from('membership_voucher_collection').select('*')
    .eq('tenant_id', payment.tenant_id).eq('provider','gocardless')
    .like('external_reference', `${payment.gocardless_payment_id}:unit:%`).order('ordinal');
  if (receipts.error && ['42P01','PGRST205'].includes(receipts.error.code)) return null;
  if (receipts.error) throw new Error('Could not verify original membership refund funding');
  if (!receipts.data?.length) return null;
  if (receipts.data.some(r => r.settlement_id !== receipts.data[0].settlement_id)
      || receipts.data.reduce((sum,r) => sum + Number(r.cash_minor),0) !== Number(payment.amount_minor)) {
    throw new Error('Reconcile original membership collection before refunding its funding');
  }
  const purchase = await db.from('membership_voucher_settlement').select('*')
    .eq('id',receipts.data[0].settlement_id).eq('tenant_id',payment.tenant_id).single();
  if (purchase.error || !purchase.data) throw new Error('Original membership credit purchase unavailable');
  const funding = fundedMonthlySnapshot(purchase.data.monthly_snapshot,purchase.data.funding,purchase.data.id).voucher_funding;
  const byAllocation = new Map();
  const slices = funding.variable_credit ? await db.from('membership_variable_voucher_slice').select('*')
    .eq('tenant_id', payment.tenant_id).eq('settlement_id', purchase.data.id)
    .in('ordinal', receipts.data.map(r => r.ordinal)).eq('state','settled') : null;
  if (slices && (slices.error || slices.data?.length !== receipts.data.length)) throw new Error('Actual variable collection funding is unavailable');
  for (const receipt of receipts.data) for (const allocation of (slices
    ? slices.data.find(s => s.ordinal === receipt.ordinal).allocations : monthlyFundingSlice(funding,receipt.ordinal).allocations)) {
    const existing = byAllocation.get(allocation.id);
    byAllocation.set(allocation.id,{ ...allocation, amountMinor: allocation.amountMinor + (existing?.amountMinor || 0) });
  }
  const allocations = [...byAllocation.values()];
  const sources = await db.from('voucher').select('id,expires_at').eq('tenant_id',payment.tenant_id)
    .in('id',allocations.map(a => a.voucherId));
  if (sources.error || sources.data?.length !== new Set(allocations.map(a => a.voucherId)).size) throw new Error('Original voucher refund owners could not be verified');
  const expired = sources.data.filter(v => Date.parse(v.expires_at) <= Date.now());
  const newExpiryDate = replacementExpiry && /^\d{4}-\d{2}-\d{2}$/.test(replacementExpiry)
    ? `${replacementExpiry}T23:59:59.000Z` : replacementExpiry;
  if (expired.length && (!newExpiryDate || !Number.isFinite(Date.parse(newExpiryDate)) || Date.parse(newExpiryDate) <= Date.now())) {
    throw new Error('Original credit has expired. Approve a future replacement expiry in this refund dialog before refunding, or reconcile the prior cash refund with that expiry.');
  }
  return { allocations, reversalOptions: { voucherReplacements: expired.map(v => ({ voucherId: v.id,newExpiryDate })) } };
}

export async function reconcileMembershipVoucherCashRefund(db, payment, refunds, options = {}) {
  // Some GoCardless API versions omit refund status. In that case only the
  // tenant-bound mirror of a signed refund lifecycle event supplies status;
  // an admin's submitted/created request is never treated as paid evidence.
  const mirrored = await db.from('gocardless_refunds').select('gocardless_refund_id,status,amount_minor')
    .eq('tenant_id',payment.tenant_id).eq('gocardless_payment_id',payment.gocardless_payment_id);
  if (mirrored.error) throw new Error('Could not verify confirmed refund lifecycle evidence');
  const byId = new Map((mirrored.data || []).map(r => [r.gocardless_refund_id,r]));
  const confirmed = refunds.filter(r => {
    const mirror = byId.get(r.id);
    if (r.links?.payment && r.links.payment !== payment.gocardless_payment_id) throw new Error('Refund belongs to another collection');
    if (!r.status && mirror && Number(mirror.amount_minor) !== Number(r.amount)) throw new Error('Refund amount conflicts with signed lifecycle evidence');
    return ['paid','refund_settled'].includes(r.status || mirror?.status);
  });
  if (!confirmed.length) {
    const restored = await db.from('voucher_allocation_refund').select('allocation_id')
      .eq('tenant_id',payment.tenant_id).eq('refund_key',`membership-gocardless:${payment.gocardless_payment_id}`)
      .gt('cumulative_minor',0).limit(1);
    if (restored.error && !['42P01','PGRST205'].includes(restored.error.code)) throw new Error('Could not verify previous credit refund effects');
    if (restored.data?.length) throw new Error('Previously confirmed cash refund is no longer confirmed; financial reconciliation is required, not an automatic credit debit');
    return { pending: true, message: 'Credit remains with the original purchase until the provider confirms the cash refund.' };
  }
  const refunded = confirmed.reduce((sum,r) => sum + Number(r.amount || 0),0);
  const context = await membershipVoucherRefundContext(db,payment,options.replacementExpiry);
  if (!context) return { applicable: false };
  const outcomes = [];
  for (const allocation of proportionalVoucherRefund(context.allocations,Number(payment.amount_minor),refunded)) {
    outcomes.push(await refundVoucherAllocation(db,{
      tenantId: payment.tenant_id, allocationId: allocation.id,
      refundKey: `membership-gocardless:${payment.gocardless_payment_id}`,
      cumulativeMinor: allocation.cumulativeMinor, reversalOptions: context.reversalOptions,
    }));
  }
  return { applicable: true, confirmedCashRefundMinor: refunded, vouchers: outcomes };
}
