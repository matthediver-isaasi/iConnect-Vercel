import { getAccountingProvider } from './accountingProvider.js';
import { xeroRateLimitedFetch } from './xeroRateLimit.js';

// PO amounts have historically been displayed in GBP. Never label a foreign
// invoice as pounds, or accept a response from a different Xero organisation.
export async function readPoXeroInvoices(tenantId, references, {
  getProvider = getAccountingProvider, fetcher = xeroRateLimitedFetch,
} = {}) {
  const provider = await getProvider(tenantId);
  if (provider.name !== 'xero') throw new Error('Expected the tenant Xero accounting connection');
  const { accessToken, tenantId: xeroTenantId } = await provider.getRawAccessToken(tenantId);
  if (!xeroTenantId) throw new Error('Missing expected Xero organisation');
  const headers = { Authorization: `Bearer ${accessToken}`, 'xero-tenant-id': xeroTenantId, Accept: 'application/json' };
  const orgResponse = await fetcher('https://api.xero.com/api.xro/2.0/Organisation', { headers });
  if (!orgResponse.ok) throw new Error('Could not verify Xero organisation');
  const orgs = (await orgResponse.json()).Organisations;
  if (orgs?.length !== 1 || orgs[0].OrganisationID !== xeroTenantId || orgs[0].BaseCurrency !== 'GBP') {
    throw new Error('Xero organisation or currency mismatch');
  }
  const result = new Map();
  for (let i = 0; i < references.length; i += 50) {
    const batch = references.slice(i, i + 50);
    const ids = batch.filter(r => r.id).map(r => r.id);
    const numbers = batch.filter(r => !r.id).map(r => r.number);
    const params = new URLSearchParams();
    if (ids.length) params.set('IDs', ids.join(','));
    if (numbers.length) params.set('InvoiceNumbers', numbers.join(','));
    // IDs and numbers are fetched separately to avoid Xero intersecting filters.
    const groups = ids.length && numbers.length
      ? [new URLSearchParams({ IDs: ids.join(',') }), new URLSearchParams({ InvoiceNumbers: numbers.join(',') })]
      : [params];
    for (const query of groups) {
      const response = await fetcher(`https://api.xero.com/api.xro/2.0/Invoices?${query}`, { headers });
      if (!response.ok) throw new Error(`Xero invoice verification failed (${response.status})`);
      const invoices = (await response.json()).Invoices || [];
      for (const ref of batch) {
        const matches = invoices.filter(inv => ref.id ? inv.InvoiceID === ref.id : inv.InvoiceNumber === ref.number);
        if (matches.length !== 1) continue;
        const invoice = matches[0];
        if (!invoice.InvoiceID || (ref.number && invoice.InvoiceNumber !== ref.number)) continue;
        result.set(ref.key, {
          invoice,
          verified: invoice.CurrencyCode === 'GBP' && typeof invoice.Total === 'number'
            && Number.isFinite(invoice.Total) && invoice.Total >= 0 && typeof invoice.Status === 'string'
            && Boolean(invoice.Status),
        });
      }
    }
  }
  return result;
}

export function poAmount({ storedAmount, xeroLinked, evidence }) {
  if (!xeroLinked) return { amount: Math.round((storedAmount + Number.EPSILON) * 100) / 100, amountVerified: true, amountSource: 'stored', currency: 'GBP' };
  return {
    amount: evidence?.verified ? evidence.invoice.Total : null,
    amountVerified: Boolean(evidence?.verified),
    amountSource: 'xero', currency: 'GBP',
  };
}

export function storedPoAmount(row, source) {
  if (source === 'booking') return Number(row.total_cost ?? row.ticket_price) || 0;
  if (source === 'transaction') return Number(row.total_cost_before_discount) || 0;
  if (source === 'training_fund_purchase') return Number(row.amount) || 0;
  return Number(row.total_with_vat ?? row.final_cost) || 0;
}

export function poInvoiceGuard(summary) {
  if (!summary || summary.rowCount === 0) return { ok: false, status: 404, code: 'not_found', error: 'Invoice not found for this tenant' };
  const status = summary.xeroStatus;
  if (['VOIDED', 'DELETED', 'PAID'].includes(status)) {
    return { ok: false, status: 409, code: `invoice_${status.toLowerCase()}`, error: `This invoice is ${status.toLowerCase()} in Xero and cannot accept a PO or reminder.` };
  }
  if (!summary.amountVerified) return { ok: false, status: 503, code: 'amount_unverified', error: 'Xero invoice amount could not be verified. Try again before sending a reminder or submitting a PO.' };
  return { ok: true };
}
