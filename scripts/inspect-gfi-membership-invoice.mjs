// Read-only invoice/contact diagnosis for the explicitly reported organisation.
// OAuth renewal may refresh credentials; no accounting writes are permitted.
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const { supabase } = await import('../api/_lib/database.js');
const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
const { prepareMembershipSourceRequest } = await import('../api/_lib/accountingSourcePreparation.js');
const tenantId = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const { data: row, error } = await supabase.from('accounting_request_queue').select('*')
  .eq('tenant_id', tenantId).eq('id', 'e8e1200d-b096-4bc0-bc1d-dc6de200d56d').single();
if (error || !row) throw new Error('Unable to load the pinned accounting request');
const token = await getValidXeroAccessToken(tenantId);
if (token.tenantId !== row.company_id) throw new Error('Accounting company has changed; stopping');
const readOnlyFetch = async (url, init = {}) => {
  if ((init.method || 'GET').toUpperCase() !== 'GET') {
    throw Object.assign(new Error('Read-only inspection refused an accounting write'), { code: 'READ_ONLY_WRITE_BLOCKED' });
  }
  const parsed = new URL(url);
  if (parsed.origin !== 'https://api.xero.com') throw new Error('Unexpected provider host');
  return fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
};
try {
  await prepareMembershipSourceRequest({ row, transport: {
    fetch: readOnlyFetch, timeoutMs: 20000, deadlineAt: Date.now() + 60000,
    resolveConnection: async () => ({ accessToken: token.accessToken, companyId: token.tenantId }),
  } });
  console.log(JSON.stringify({ preparation: 'Read-only preparation succeeded; no invoice was submitted' }));
} catch (error) {
  console.log(JSON.stringify({ preparation: 'blocked', code: error.code || null, reason: String(error.message).slice(0, 350) }));
}
for (let page = 1; page <= 5; page++) {
  const url = new URL('https://api.xero.com/api.xro/2.0/Invoices');
  url.searchParams.set('where', 'Type=="ACCREC"&&Contact.Name=="University of Wolverhampton"');
  url.searchParams.set('page', String(page));
  const response = await readOnlyFetch(url, { headers: {
    Authorization: `Bearer ${token.accessToken}`, 'xero-tenant-id': token.tenantId, Accept: 'application/json',
  } });
  if (!response.ok) throw new Error(`Read-only invoice lookup returned HTTP ${response.status}`);
  const { Invoices = [] } = await response.json();
  console.log(JSON.stringify({ page, invoices: Invoices.map(i => ({
    number: i.InvoiceNumber, status: i.Status, reference: i.Reference,
    date: i.DateString || i.Date, total: i.Total, amountDue: i.AmountDue,
    membershipDetails: ['SI-44957', 'SI-43043'].includes(i.InvoiceNumber)
      ? { id: i.InvoiceID, contactId: i.Contact?.ContactID, currency: i.CurrencyCode,
        lines: (i.LineItems || []).map(l => ({ description: l.Description, amount: l.LineAmount, tax: l.TaxAmount })) } : undefined,
  })) }));
  if (Invoices.length < 100) break;
  if (page === 5) console.log('Inspection capped; more results may exist.');
}
