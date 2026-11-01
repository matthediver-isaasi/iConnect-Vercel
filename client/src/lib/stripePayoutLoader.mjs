import { PAYOUT_SOURCES, reconcilePayout } from '../../../shared/stripePayoutReport.mjs';

export async function loadCompletePayout(payoutId, mode, { signal, onProgress = () => {}, request = fetch } = {}) {
  const get = async params => {
    const response = await request(`/api/admin/stripe-payout-report?${new URLSearchParams({ mode, ...params })}`,
      { credentials: 'include', signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Report retrieval failed.');
    return body;
  };
  const transactions = [], evidence = [], cursors = new Set();
  let cursor = '', payout;
  do {
    if (cursors.has(cursor)) throw new Error('Provider pagination did not advance.');
    cursors.add(cursor);
    const page = await get({ payout: payoutId, ...(cursor ? { cursor } : {}) });
    if (page.unsupported) throw new Error(page.payout?.limitation || 'Payout attribution is unsupported.');
    if (payout && JSON.stringify(payout) !== JSON.stringify(page.payout)) throw new Error('Payout changed during retrieval. Reload.');
    payout = page.payout;
    transactions.push(...page.rows);
    const ids = [...new Set(page.rows.flatMap(r => [r.paymentIntentId, r.stripeInvoiceId]).filter(Boolean))];
    if (ids.length) {
      for (const source of PAYOUT_SOURCES) {
        let offset = 0;
        do {
          const result = await get({ action: 'evidence', source, scope: page.evidenceToken, offset: String(offset) });
          evidence.push(...result.rows);
          if (result.next !== null && (!Number.isSafeInteger(result.next) || result.next <= offset)) {
            throw new Error('Stored linkage pagination did not advance.');
          }
          offset = result.next;
        } while (offset !== null);
      }
    }
    onProgress(transactions.length);
    cursor = page.next;
  } while (cursor);
  return reconcilePayout(payout, transactions, evidence, true);
}
