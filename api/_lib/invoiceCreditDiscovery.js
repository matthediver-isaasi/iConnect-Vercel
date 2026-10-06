// Read-only, customer-bounded discovery. Unallocated/customer credits cannot
// safely be assigned to a booking: their presence prevents verified empty.
export async function discoverInvoiceCredits({ provider, invoiceId, readInvoice, listNotes, readPayment }) {
  const invoice = await readInvoice(invoiceId);
  const xero = provider === 'xero';
  const identity = xero ? invoice?.InvoiceID : invoice?.Id;
  const customer = xero ? invoice?.Contact?.ContactID : invoice?.CustomerRef?.value;
  if (String(identity) !== String(invoiceId) || !customer) throw new Error('Invoice identity mismatch');
  const links = new Set(xero ? (invoice.CreditNotes || []).map(n => n.CreditNoteID)
    : (invoice.LinkedTxn || []).filter(t => t.TxnType === 'CreditMemo').map(t => String(t.TxnId)));
  let ambiguousPayment = false;
  if (!xero) {
    const payments = (invoice.LinkedTxn || []).filter(t => t.TxnType === 'Payment');
    if (payments.length > 25) throw new Error('Invoice payment coverage limit exceeded');
    for (const link of payments) {
      const payment = await readPayment(String(link.TxnId));
      if (String(payment?.Id) !== String(link.TxnId) || String(payment.CustomerRef?.value) !== String(customer)) {
        throw new Error('Invoice payment identity mismatch');
      }
      const transactions = (payment.Line || []).flatMap(line => line.LinkedTxn || []);
      if (!transactions.some(t => t.TxnType === 'Invoice' && String(t.TxnId) === String(invoiceId))) {
        throw new Error('Invoice payment linkage mismatch');
      }
      if (transactions.some(t => t.TxnType === 'Invoice' && String(t.TxnId) !== String(invoiceId))) ambiguousPayment = true;
      for (const t of transactions.filter(t => t.TxnType === 'CreditMemo')) links.add(String(t.TxnId));
    }
  }
  const notes = [];
  const seen = new Set();
  let unknown = false;
  for (let page = 1; page <= 5; page++) {
    const batch = await listNotes(String(customer), page);
    if (!Array.isArray(batch)) throw new Error('Invalid accounting pagination response');
    for (const note of batch) {
      const id = String(xero ? note.CreditNoteID || '' : note.Id || '');
      const contact = xero ? note.Contact?.ContactID : note.CustomerRef?.value;
      if (!id || String(contact) !== String(customer) || seen.has(id)) throw new Error('Accounting note identity or pagination mismatch');
      seen.add(id);
      const allocations = xero ? note.Allocations || [] : [];
      const linked = links.has(id) || allocations.some(a => a.Invoice?.InvoiceID === invoiceId);
      if (!linked) { unknown = true; continue; }
      const amount = xero ? note.Total : note.TotalAmt;
      notes.push({
        // QuickBooks Payment links prove identity, not the invoice-specific
        // application amount. A memo can be partially applied or shared across
        // payments. Never substitute its full TotalAmt for that allocation.
        providerId: id, amount: !xero || amount == null ? null : Number(amount),
        currency: xero ? note.CurrencyCode : note.CurrencyRef?.value,
        status: xero ? note.Status : note.Voided ? 'VOIDED' : 'AUTHORISED',
        ambiguousAttribution: !xero || ambiguousPayment || (xero && (
          !allocations.length || allocations.some(a => a.Invoice?.InvoiceID !== invoiceId)
          || allocations.some(a => !Number.isFinite(Number(a.Amount)))
          || Math.abs(allocations.reduce((sum, a) => sum + Number(a.Amount), 0) - Number(amount)) > 0.000001
        )),
      });
    }
    // Require an explicit empty terminal page, not a short-page heuristic.
    if (!batch.length) return {
      invoiceId, provider, notes,
      complete: !unknown && [...links].every(id => seen.has(String(id))),
      coverage: { kind: 'invoice_and_customer_credit_notes', paginationComplete: true,
        unmatchedCustomerCredits: unknown, pages: page },
    };
  }
  throw new Error('Accounting credit pagination limit exceeded; coverage incomplete');
}