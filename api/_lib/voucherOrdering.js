// Shared pure helpers for voucher redemption ordering (first-expiry-first-used)
// and expiry-ledger breakdown math. Used by both booking endpoints and the
// voucher expiry cron; kept dependency-free so node --test can exercise them.

const OVERRIDE_NOTE =
  'Voucher order manually selected by admin; first-expiry-first-used ordering overridden';

/**
 * Order voucher ids for redemption.
 * - manual === true: preserve the caller-sent order and return an audit note.
 * - otherwise: sort by earliest expires_at, then earliest issued_at, then id
 *   (first-expiry-first-used). Vouchers without an expiry sort last.
 *
 * @param {string[]} ids - voucher ids in the order the client sent them
 * @param {Object<string, {expires_at?: string, issued_at?: string}>} byId
 * @param {boolean} manual - caller explicitly requested manual ordering
 * @returns {{ orderedIds: string[], overrideNote: string | null }}
 */
export function orderVoucherIdsForRedemption(ids, byId, manual) {
  const input = Array.isArray(ids) ? [...ids] : [];
  if (manual === true) {
    return { orderedIds: input, overrideNote: OVERRIDE_NOTE };
  }
  if (input.length < 2 || !byId) {
    return { orderedIds: input, overrideNote: null };
  }
  const sortKey = (id) => {
    const v = byId[id];
    const exp = v?.expires_at ? new Date(v.expires_at).getTime() : Infinity;
    const iss = v?.issued_at ? new Date(v.issued_at).getTime() : Infinity;
    return [isNaN(exp) ? Infinity : exp, isNaN(iss) ? Infinity : iss];
  };
  const orderedIds = input.sort((a, b) => {
    const [ae, ai] = sortKey(a);
    const [be, bi] = sortKey(b);
    if (ae !== be) return ae - be;
    if (ai !== bi) return ai - bi;
    return String(a) < String(b) ? -1 : 1;
  });
  return { orderedIds, overrideNote: null };
}

/**
 * Compute the original/used/remaining breakdown for an expiring voucher from
 * its transaction ledger.
 *
 * Model: `remaining` is the voucher's current value. "Previously used" is the
 * net consumption — usage debits (booking_usage, debit_adjustment) minus
 * value credited back (cancellation_refund) — clamped at 0. The original
 * value is then remaining + used. Award / credit_adjustment entries are part
 * of the original value by construction and must NOT be subtracted, otherwise
 * a voucher with an award ledger row would compute original ≈ 0.
 *
 * Example: awarded 100, used 30, remaining 70 -> { original: 100, used: 30 }.
 *
 * @param {number} remaining - current voucher value (> 0)
 * @param {Array<{amount: any, type: string}>} txns - prior ledger entries
 * @returns {{ originalValue: number, usedValue: number }}
 */
export function computeExpiryBreakdown(remaining, txns) {
  let debits = 0;
  let refunds = 0;
  for (const t of Array.isArray(txns) ? txns : []) {
    const amt = Math.abs(parseFloat(t?.amount ?? 0));
    if (isNaN(amt)) continue;
    if (t.type === 'booking_usage' || t.type === 'debit_adjustment') debits += amt;
    else if (t.type === 'cancellation_refund') refunds += amt;
  }
  const usedValue = Math.max(0, debits - refunds);
  return { originalValue: remaining + usedValue, usedValue };
}
