const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;

// Only persisted linkage is authority. A display number or today's active
// accounting provider cannot identify an historical invoice.
export function formSubmissionInvoice(submission) {
  if (submission?.payment_provider !== 'invoice') return null;
  const meta = submission.payment_meta || {};
  const result = meta.invoice_result || {};
  const ids = [result.id, result.invoiceId, result.invoice_id, result.accounting_invoice_id, result.xero_invoice_id]
    .map(text).filter(Boolean);
  const providers = [meta.invoice_order?.provider, result.provider, result.accounting_provider,
    result.xero_invoice_id ? 'xero' : null].map(text).filter(Boolean);
  const number = text(result.invoiceNumber) || text(result.invoice_number)
    || text(result.accounting_invoice_number) || text(result.xero_invoice_number);
  const linked = ids.length > 0 && providers.length > 0
    && new Set(ids).size === 1 && new Set(providers).size === 1
    && ['xero', 'quickbooks'].includes(providers[0]);
  return { number, linked, invoiceId: linked ? ids[0] : null, provider: linked ? providers[0] : null };
}

export function formInvoiceFilename(number, submissionId) {
  const label = String(number || submissionId || 'download').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return `invoice-${label}.pdf`;
}
