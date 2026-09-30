import { supabase } from './database.js';
import { fireWorkflowForPaidRow } from './membershipPaymentReconciliation.js';

export function toMinorUnits(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

export function getMembershipGrandTotal(simResult, addonTotals = null) {
  const membershipTotal = Number(simResult?.totalWithVat ?? simResult?.finalCost ?? 0);
  const addonTotal = Number(addonTotals?.total ?? 0);
  return Math.round((membershipTotal + addonTotal) * 100) / 100;
}

export function isZeroDueMembership(simResult, addonTotals = null) {
  return toMinorUnits(getMembershipGrandTotal(simResult, addonTotals)) === 0;
}

export function isZeroDueExistingMembership(record) {
  if (!record) return false;
  const storedTotal = record.total_with_vat ?? record.final_cost;
  return storedTotal != null && toMinorUnits(storedTotal) === 0;
}

export function canActivateScheduledMembershipWithoutInvoice(record) {
  return record?.payment_status === 'paid' && isZeroDueExistingMembership(record);
}

export function zeroDuePaymentFields(paidAt = new Date().toISOString()) {
  return {
    payment_status: 'paid',
    paid_at: paidAt,
    payment_method: null,
    stripe_payment_intent_id: null,
  };
}

export async function fireNewZeroDueMembershipPaidWorkflow({
  table,
  row,
  paidAt,
  baseUrl = '',
  source = 'membership_zero_due',
  client = supabase,
  workflowDispatcher = fireWorkflowForPaidRow,
}) {
  if (!row?.id) return { fired: false, skippedReason: 'no-history-row' };
  const { data: durableRow, error } = await client
    .from(table)
    .select('*')
    .eq('id', row.id)
    .maybeSingle();
  if (error) throw new Error(`Failed to reload zero-due membership ${table}#${row.id}: ${error.message}`);
  if (!durableRow || durableRow.payment_status !== 'paid') {
    return { fired: false, skippedReason: 'row-not-durably-paid' };
  }
  const deliveryKey = `membership-paid:${table}:${durableRow.id}`;
  return workflowDispatcher({
    table,
    row: durableRow,
    snapshot: { paidAt: durableRow.paid_at || paidAt },
    baseUrl,
    source,
    deliveryKey,
  });
}