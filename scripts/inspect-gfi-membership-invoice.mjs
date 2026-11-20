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
if (process.argv.includes('--verify-approved')) {
  const expected = [
    { id: 'fcf450ae-1ea3-4381-8f98-878ef8bdf8dd', number: 'SI-43043', total: 3847.2, due: 0, status: 'PAID', reference: '8132266', net: 3206, description: 'Service Membership - August 2025 - July 2026' },
    { id: 'b7bc6529-bf70-4db8-a99a-a623d76f7f3c', number: 'SI-44957', total: 4559.7, due: 4559.7, status: 'AUTHORISED', reference: '8140415', net: 3799.75, description: 'HE Membership subscription for 1 August 2026 - 31 July 2027.\nTier: Tier 10\nFee: GBP 3799.75' },
  ];
  for (const target of expected) {
    const response = await readOnlyFetch(`https://api.xero.com/api.xro/2.0/Invoices/${target.id}`, {
      headers: { Authorization: `Bearer ${token.accessToken}`, 'xero-tenant-id': token.tenantId, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Exact invoice verification returned HTTP ${response.status}`);
    const { Invoices = [] } = await response.json();
    const invoice = Invoices[0];
    if (Invoices.length !== 1 || invoice.InvoiceID !== target.id || invoice.InvoiceNumber !== target.number
      || invoice.Contact?.ContactID !== '3ece7d50-6515-4e5a-b321-1f6252514718'
      || invoice.Type !== 'ACCREC' || invoice.CurrencyCode !== 'GBP'
      || invoice.Total !== target.total || invoice.AmountDue !== target.due
      || invoice.Status !== target.status || invoice.Reference !== target.reference
      || invoice.SubTotal !== target.net || invoice.LineItems?.length !== 1
      || invoice.LineItems[0].Description !== target.description) throw new Error('Approved invoice evidence changed; stopping');
    console.log(JSON.stringify({ verified: true, company: token.tenantId, ...target,
      fullyPaidOnDate: invoice.FullyPaidOnDate || null, checkedAt: new Date().toISOString() }));
  }
  process.exit(0);
}
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
