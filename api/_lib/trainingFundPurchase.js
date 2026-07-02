// Task #1660 — Shared helper to release a Training Fund purchase into the
// organisation's available balance.
//
// A purchase row is credited at most once, and concurrent credits for the same
// org must never lose updates. Both invariants are enforced inside the Postgres
// function `credit_training_fund_purchase` (see the migration): it claims the
// row with a compare-and-set on `status` (pending -> paid) under a row lock,
// then mutates the balance with an in-place expression (col = col + amount) and
// writes the ledger row — all in a single transaction. A second caller (e.g.
// the reconciliation cron racing the Stripe confirm endpoint) finds the row
// already `paid` and no-ops.
//
// Used by both the Stripe confirm handler (card purchases) and the
// invoice-payment reconciliation cron (invoice purchases).

import { supabase } from './database.js';

/**
 * Credit a training_fund_purchase into the org's available balance.
 *
 * @param {Object} args
 * @param {string} args.purchaseId
 * @param {string} [args.paidAt] - ISO timestamp the invoice/payment settled
 * @param {string} [args.source] - 'stripe_confirm' | 'invoice_reconciliation' (for ledger reason)
 * @returns {Promise<{ credited: boolean, reason?: string, amount?: number, balanceAfter?: number, transactionId?: string }>}
 */
export async function creditTrainingFundForPurchase({ purchaseId, paidAt = null, source = 'purchase' }) {
  if (!supabase) throw new Error('Supabase not configured');
  if (!purchaseId) throw new Error('purchaseId is required');

  const settledAt = paidAt || new Date().toISOString();

  // The whole claim -> credit -> ledger sequence runs atomically server-side.
  const { data, error } = await supabase.rpc('credit_training_fund_purchase', {
    p_purchase_id: purchaseId,
    p_paid_at: settledAt,
    p_source: source,
  });

  if (error) {
    throw new Error(`Failed to credit purchase ${purchaseId}: ${error.message}`);
  }

  const result = data || {};
  if (!result.credited) {
    return { credited: false, reason: result.reason || 'already-processed-or-missing' };
  }

  console.log(`[trainingFundPurchase] Credited purchase ${purchaseId} +${result.amount} -> ${result.balance_after} [${source}]`);

  return {
    credited: true,
    amount: result.amount != null ? Number(result.amount) : undefined,
    balanceAfter: result.balance_after != null ? Number(result.balance_after) : undefined,
    transactionId: result.transaction_id || undefined,
  };
}
