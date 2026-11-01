// Shared projection: one row per Stripe balance transaction, never per booking.
export const PAYOUT_SOURCES = ['booking', 'complex_event_booking', 'member_membership_history',
  'organisation_membership_history', 'training_fund_purchase', 'form_submission', 'membership_instalment_invoices'];

export function invoiceEvidence(record, source) {
  const r = source === 'form_submission' ? record.payment_meta?.membership_result || {} : record;
  const provider = r.accounting_provider || (r.xero_invoice_id ? 'xero' : null);
  const id = r.accounting_invoice_id || r.xero_invoice_id || null;
  const number = r.accounting_invoice_number || r.xero_invoice_number || null;
  const conflict = !!(r.accounting_invoice_id && r.xero_invoice_id
    && (provider !== 'xero' || r.accounting_invoice_id !== r.xero_invoice_id));
  return { source, sourceId: record.id, reference: record.booking_group_reference || record.booking_reference || record.id,
    historyId: source === 'form_submission' ? r.history_id : null,
    historyTable: source === 'form_submission' ? r.table : null,
    paymentId: source === 'form_submission' ? record.payment_reference
      : source === 'membership_instalment_invoices' ? record.external_payment_id : record.stripe_payment_intent_id,
    provider, id, number, conflict,
    url: !conflict && provider === 'xero' && id
      ? `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${encodeURIComponent(id)}` : null };
}

export function reconcilePayout(payout, transactions, evidence, complete) {
  const seen = new Set();
  const totals = {};
  const rows = transactions.map(t => {
    if (seen.has(t.id)) throw new Error('Duplicate balance transaction; reload the report.');
    seen.add(t.id);
    for (const key of ['gross', 'fee', 'net']) if (!Number.isSafeInteger(t[key])) throw new Error('Invalid Stripe amount.');
    if (t.gross - t.fee !== t.net) throw new Error('Inconsistent Stripe transaction amounts.');
    const total = totals[t.currency] ||= { gross: 0, fee: 0, net: 0 };
    for (const key of ['gross', 'fee', 'net']) {
      total[key] += t[key];
      if (!Number.isSafeInteger(total[key])) throw new Error('Report total exceeds safe integer range.');
    }
    const rawLinks = evidence.filter(e => e.paymentId && [t.paymentIntentId, t.stripeInvoiceId].includes(e.paymentId));
    const links = rawLinks.map(e => {
      if (e.source !== 'form_submission' || e.id || !e.historyId) return e;
      const history = rawLinks.find(h => h.source === e.historyTable && h.sourceId === e.historyId
        && h.paymentId === e.paymentId);
      return history ? { ...history, source: e.source, sourceId: e.sourceId, reference: e.reference } : e;
    });
    const invoices = [...new Map(links.filter(e => e.id || e.number)
      .map(e => [`${e.provider}:${e.id || e.number}`, e])).values()];
    const ambiguous = links.some(e => e.conflict) || links.some(a => links.some(b =>
      a !== b && a.id && a.id === b.id && a.provider === b.provider && a.number && b.number && a.number !== b.number))
      || invoices.some(a =>
      invoices.some(b => a !== b && a.provider === b.provider && a.number && a.number === b.number && a.id !== b.id));
    const status = ambiguous ? 'Ambiguous' : !t.paymentIntentId && !t.stripeInvoiceId ? 'Unsupported source'
      : !links.length ? 'Unmatched' : links.some(e => !e.id || !e.provider) ? 'Missing invoice'
        : invoices.some(e => e.provider !== 'xero') ? 'Other accounting provider' : 'Matched';
    const reason = ambiguous ? 'Conflicting stored invoice evidence; review required.'
      : status === 'Unsupported source' ? 'No supported charge or refund payment identity; retained in payout totals.'
        : status === 'Unmatched' ? 'No exact stored link. May be external, historical or an unsupported recurring collection.'
          : status === 'Missing invoice' ? 'Payment record found, but invoice identity or provider is missing.'
            : status === 'Other accounting provider' ? 'Stored invoice belongs to another accounting provider, not Xero.'
              : 'Exact stored payment link; multiple invoices are listed without allocating the payment.';
    return { ...t, sources: [...new Set(links.map(e => `${e.source}: ${e.reference}`))],
      invoices: ambiguous ? invoices.map(i => ({ ...i, url: null, conflict: true })) : invoices, status,
      reason: reason + (t.refundId ? ' Refund links refer to original invoices, not evidence of a credit note.' : '') };
  });
  const variance = complete && Number.isSafeInteger(payout.amount)
    ? (totals[payout.currency]?.net || 0) - payout.amount : null;
  return { payout, rows, totals, complete, variance,
    balanced: complete && variance === 0 && Object.keys(totals).every(c => c === payout.currency) };
}

// Stripe retains two-decimal API representation for ISK and UGX.
const ZERO = new Set('bif clp djf gnf jpy kmf krw mga pyg rwf vnd vuv xaf xof xpf'.split(' '));
const THREE = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);
export function payoutMoney(minor, currency) {
  const digits = ZERO.has(currency) ? 0 : THREE.has(currency) ? 3 : 2;
  return `${currency.toUpperCase()} ${(minor / 10 ** digits).toFixed(digits)}`;
}
function cell(value) {
  // Financial cells are validated minor-unit integers, not untrusted strings.
  // Keep their signs numeric so spreadsheet SUM includes refunds/reversals.
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Invalid numeric CSV value.');
    return String(value);
  }
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}
export function payoutCsv(report) {
  if (!report.complete) throw new Error('Complete retrieval is required before export.');
  const p = report.payout;
  const lines = [
    ['Payout', 'Status', 'Arrival date', 'Currency', 'Payout amount minor', 'Retrieval complete', 'Balanced', 'Variance minor', 'Stripe mode'],
    [p.id, p.status, p.arrivalDate, p.currency, p.amount, true, report.balanced, report.variance, p.mode],
    ['Balance transaction', 'Type', 'Payment date UTC', 'Balance date UTC', 'Currency', 'Gross minor', 'Fee minor', 'Net minor',
      'Source ID', 'Charge ID', 'Refund ID', 'Payment intent ID', 'Stripe invoice ID', 'Source references',
      'Accounting invoices', 'Invoice links', 'Match status', 'Reason'],
    ...report.rows.map(r => [r.id, r.type, r.paymentDate, r.balanceDate, r.currency, r.gross, r.fee, r.net,
      r.sourceId, r.chargeId, r.refundId, r.paymentIntentId, r.stripeInvoiceId, r.sources.join('; '),
      r.invoices.map(i => `${i.provider || 'unknown'}: ${i.number || i.id}`).join('; '),
      r.invoices.map(i => i.url).filter(Boolean).join('; '), r.status, r.reason]),
    ['Currency totals', 'Gross minor', 'Fee minor', 'Net minor'],
    ...Object.entries(report.totals).map(([currency, t]) => [currency, t.gross, t.fee, t.net]),
  ];
  return '\uFEFF' + lines.map(row => row.map(cell).join(',')).join('\r\n');
}
