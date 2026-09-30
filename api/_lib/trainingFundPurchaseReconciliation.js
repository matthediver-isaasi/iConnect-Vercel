// Task #1660 — Reconcile pending invoice-method Training Fund purchases.
//
// Given a single `training_fund_purchase` row paid by invoice that is
// still `pending`, ask its accounting provider (Xero/QBO) for the current
// invoice status. When the invoice has settled as `paid`, release the
// funds into the org's available balance via the shared, idempotent
// credit helper (which also clears the matching pending balance and writes
// the ledger row).
//
// Card purchases are NOT handled here — they credit on the Stripe confirm
// endpoint. Only invoice-method, status=pending rows are scanned.

import { supabase } from './database.js';
import { getAccountingProviderByName, PROVIDER_XERO } from './accountingProvider.js';
import { creditTrainingFundForPurchase } from './trainingFundPurchase.js';

/**
 * Reconcile a single training_fund_purchase row.
 *
 * @param {Object} args
 * @param {Object} args.row - a training_fund_purchase row
 * @returns {Promise<{ recordId, transitioned, skippedReason }>}
 */
export async function reconcilePurchaseRow({ row }) {
  if (!row) return skipped(null, 'row-not-found');

  const recordId = row.id;

  if (row.status !== 'pending') return skipped(recordId, `already-${row.status}`);
  if (row.payment_method !== 'invoice') return skipped(recordId, 'not-invoice');

  const invoiceId = row.accounting_invoice_id || row.xero_invoice_id;
  if (!invoiceId) return skipped(recordId, 'no-invoice-id');

  const providerName = row.accounting_provider || PROVIDER_XERO;
  const provider = getAccountingProviderByName(providerName);

  if (typeof provider.fetchInvoiceStatus !== 'function') {
    return skipped(recordId, `provider-${providerName}-no-status-support`);
  }

  let snapshot;
  try {
    snapshot = await provider.fetchInvoiceStatus(invoiceId, row.tenant_id);
  } catch (err) {
    console.error(`[trainingFundPurchaseReconciliation] ${providerName} fetchInvoiceStatus failed for purchase ${recordId} (invoice ${invoiceId}): ${err.message}`);
    throw err;
  }

  if (!snapshot) return skipped(recordId, 'invoice-not-found');

  const status = snapshot.status; // 'paid' | 'voided' | 'partial' | 'unpaid'

  // Voided invoice — cancel the purchase and drop the pending amount.
  if (status === 'voided') {
    await cancelVoidedPurchase(row);
    return { recordId, transitioned: true, skippedReason: null, outcome: 'cancelled' };
  }

  if (status !== 'paid') {
    return skipped(recordId, `invoice-${status}`);
  }

  // Invoice settled as paid — release the funds (idempotent).
  const result = await creditTrainingFundForPurchase({
    purchaseId: recordId,
    paidAt: snapshot.paidAt || new Date().toISOString(),
    source: 'invoice_reconciliation',
  });

  if (!result.credited) {
    return skipped(recordId, result.reason || 'not-credited');
  }

  console.log(`[trainingFundPurchaseReconciliation] purchase ${recordId} invoice paid -> credited +${result.amount} (provider=${providerName}, invoice=${invoiceId})`);
  return { recordId, transitioned: true, skippedReason: null, outcome: 'credited' };
}

/**
 * Mark a purchase cancelled when its invoice was voided, and remove the
 * amount it was contributing to the org's pending balance.
 */
async function cancelVoidedPurchase(row) {
  const { data: claimed } = await supabase
    .from('training_fund_purchase')
    .update({ status: 'cancelled' })
    .eq('id', row.id)
    .eq('status', 'pending')
    .select('id, amount, organization_id, payment_method');

  if (!claimed || claimed.length === 0) return; // already processed

  const purchase = claimed[0];
  if (purchase.payment_method !== 'invoice') return;

  const amount = Number(purchase.amount) || 0;
  const { data: org } = await supabase
    .from('organization')
    .select('id, training_fund_pending_balance')
    .eq('id', purchase.organization_id)
    .maybeSingle();
  if (!org) return;

  const pendingBefore = Number(org.training_fund_pending_balance) || 0;
  await supabase
    .from('organization')
    .update({ training_fund_pending_balance: Math.max(0, pendingBefore - amount) })
    .eq('id', org.id);

  console.log(`[trainingFundPurchaseReconciliation] purchase ${row.id} invoice voided -> cancelled, pending -${amount} on org ${org.id}`);
}

function skipped(recordId, reason) {
  return { recordId, transitioned: false, skippedReason: reason };
}
