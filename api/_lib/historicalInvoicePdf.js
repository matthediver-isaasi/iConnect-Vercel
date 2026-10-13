import { getValidXeroAccessToken } from './xero.js';
import { accessError } from './historicalInvoiceAccess.js';

// Called only by the explicit, authenticated PDF endpoint. Never by a list or import.
export async function getHistoricalInvoicePdf(row, dependencies = {}) {
  const { accessToken, tenantId } = await (dependencies.getToken || getValidXeroAccessToken)(row.tenant_id);
  if (tenantId !== row.xero_company_id) throw accessError(409, 'The connected Xero organisation differs from the historical import');
  const transport = dependencies.fetch || fetch;
  async function get(path, accept) {
    const response = await transport(`https://api.xero.com/api.xro/2.0/${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'xero-tenant-id': tenantId, Accept: accept },
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 429) throw accessError(429, 'Xero is temporarily rate limited. Please try again later.');
    if (response.status === 404) return null;
    if (!response.ok) throw accessError(502, 'Xero could not retrieve this historical document');
    return response;
  }
  let id = row.xero_document_id;
  let type = row.xero_document_type;
  if (!id) {
    // Negative source amounts may be a credit note OR a negative invoice.
    const types = row.record_kind === 'credit' ? ['CreditNotes', 'Invoices'] : ['Invoices'];
    for (const candidate of types) {
      const field = candidate === 'Invoices' ? 'InvoiceNumber' : 'CreditNoteNumber';
      const filter = encodeURIComponent(`${field}==${JSON.stringify(row.invoice_number)}`);
      const response = await get(`${candidate}?where=${filter}`, 'application/json');
      if (!response) continue;
      const documents = (await response.json())[candidate] || [];
      const matching = documents.filter(doc => doc[field] === row.invoice_number &&
        doc.Type === (candidate === 'Invoices' ? 'ACCREC' : 'ACCRECCREDIT'));
      if (matching.length > 1) throw accessError(409, 'Multiple matching documents require administrator review');
      if (matching.length === 1) {
        const doc = matching[0];
        // Source credits retain their negative sign; Xero credit totals are positive.
        const amountMatches = Math.abs(Math.round(Number(doc.Total) * 100)) === Math.abs(Number(row.amount_minor));
        if (!amountMatches) throw accessError(409, 'Xero document amount differs from the historical record');
        id = doc[candidate === 'Invoices' ? 'InvoiceID' : 'CreditNoteID'];
        type = candidate;
        break;
      }
    }
  }
  if (!id) throw accessError(404, 'This historical document was not found in Xero');
  const response = await get(`${type}/${encodeURIComponent(id)}`, 'application/pdf');
  if (!response) throw accessError(404, 'This historical document is no longer available in Xero');
  const pdf = Buffer.from(await response.arrayBuffer());
  if (pdf.subarray(0, 5).toString() !== '%PDF-') throw accessError(502, 'Xero did not return a PDF');
  return { pdf, id, type };
}
