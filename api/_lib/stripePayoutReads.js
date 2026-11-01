import { invoiceEvidence, PAYOUT_SOURCES } from '../../shared/stripePayoutReport.mjs';

const id = value => typeof value === 'string' ? value : value?.id || null;
const date = seconds => Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
export function payoutSummary(p) {
  return { id: p.id, amount: p.amount, currency: p.currency, status: p.status,
    mode: p.livemode ? 'live' : 'test',
    arrivalDate: date(p.arrival_date)?.slice(0, 10), automatic: p.automatic,
    supported: p.automatic === true && p.method !== 'instant',
    limitation: p.automatic !== true || p.method === 'instant' ? 'Manual and instant payout attribution is unsupported.' : null };
}
export async function readPayoutPage(stripe, payoutId, cursor, mode) {
  const p = await stripe.payouts.retrieve(payoutId);
  if (p.id !== payoutId || p.livemode !== (mode === 'live')) throw new Error('Payout environment mismatch.');
  const payout = payoutSummary(p);
  if (!payout.supported) return { payout, rows: [], next: null, unsupported: true };
  if (p.reconciliation_status === 'in_progress') throw new Error('Stripe payout reconciliation is still in progress.');
  const page = await stripe.balanceTransactions.list({
    payout: payoutId, limit: 10, ...(cursor ? { starting_after: cursor } : {}), expand: ['data.source'],
  });
  if (!Array.isArray(page.data) || (page.has_more && !page.data.length)) throw new Error('Incomplete Stripe page.');
  const rows = [];
  // At most ten sources; groups of two bound remote concurrency and transport time.
  for (let i = 0; i < page.data.length; i += 2) {
    rows.push(...await Promise.all(page.data.slice(i, i + 2).map(async t => {
      let source = t.source;
      const sourceId = id(source);
      let charge = source?.object === 'charge' ? source : null;
      const refund = source?.object === 'refund' ? source : null;
      if (refund?.charge) charge = typeof refund.charge === 'object'
        ? refund.charge : await stripe.charges.retrieve(refund.charge);
      return { id: t.id, type: t.type, currency: t.currency, gross: t.amount, fee: t.fee, net: t.net,
        balanceDate: date(t.created), paymentDate: date(charge?.created),
        sourceId, chargeId: id(charge), refundId: id(refund), paymentIntentId: id(charge?.payment_intent),
        stripeInvoiceId: id(charge?.invoice) };
    })));
  }
  return { payout, rows, next: page.has_more ? page.data.at(-1).id : null };
}

// One exact-ID source page per request. Continue through EMPTY, not short, pages
// because PostgREST deployments can cap rows below our requested limit.
export async function readEvidencePage(db, tenantId, source, ids, offset, mode) {
  if (!PAYOUT_SOURCES.includes(source)) throw new Error('Invalid evidence source.');
  const column = source === 'form_submission' ? 'payment_reference'
    : source === 'membership_instalment_invoices' ? 'external_payment_id' : 'stripe_payment_intent_id';
  let query = db.from(source).select('*').eq('tenant_id', tenantId).in(column, ids);
  if (source === 'form_submission') query = query.eq('payment_provider', 'stripe');
  if (source === 'membership_instalment_invoices') query = query.eq('provider', 'stripe');
  const { data, error } = await query.order('id').range(offset, offset + 99)
    .abortSignal(AbortSignal.timeout(8000));
  if (error) throw new Error(`Stored linkage unavailable for ${source}; retrieval is incomplete.`);
  if (!Array.isArray(data)) throw new Error('Invalid stored linkage response.');
  const rows = data.filter(r => r.tenant_id === tenantId && ids.includes(r[column])
    && (!r.environment || r.environment === mode)).map(r => invoiceEvidence(r, source));
  return { rows, next: data.length ? offset + data.length : null };
}
