import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverInvoiceCredits } from './invoiceCreditDiscovery.js';
import { readXeroInvoiceCreditEvidence } from './xero.js';
import { readQuickBooksInvoiceCreditEvidence } from './quickbooks.js';

const xero = (overrides = {}) => ({
  provider: 'xero', invoiceId: 'inv',
  readInvoice: async () => ({ InvoiceID: 'inv', Contact: { ContactID: 'contact' }, CreditNotes: [] }),
  listNotes: async () => [], ...overrides,
});
const note = overrides => ({ CreditNoteID: 'cn', Contact: { ContactID: 'contact' },
  Total: 12, CurrencyCode: 'GBP', Status: 'AUTHORISED', ...overrides });

test('Xero full empty customer enumeration is verified, identity failures never empty', async () => {
  assert.equal((await discoverInvoiceCredits(xero())).complete, true);
  await assert.rejects(discoverInvoiceCredits(xero({
    readInvoice: async () => ({ InvoiceID: 'other', Contact: { ContactID: 'contact' } }),
  })), /identity/);
  await assert.rejects(discoverInvoiceCredits(xero({ listNotes: async () => undefined })), /pagination/);
  await assert.rejects(discoverInvoiceCredits(xero({ listNotes: async () => [note({ Contact: { ContactID: 'foreign' } })] })), /identity/);
});
test('Xero invoice-linked credits recovered; unallocated customer notes prevent empty coverage', async () => {
  const result = await discoverInvoiceCredits(xero({
    listNotes: async (_, page) => page === 1 ? [note({ Allocations: [{ Invoice: { InvoiceID: 'inv' } }] })] : [],
  }));
  assert.equal(result.complete, true);
  assert.equal(result.notes[0].amount, 12);
  assert.equal(result.coverage.pages, 2);
  const unknown = await discoverInvoiceCredits(xero({ listNotes: async (_, page) => page === 1 ? [note()] : [] }));
  assert.equal(unknown.complete, false);
  assert.equal(unknown.notes.length, 0);
  const partial = await discoverInvoiceCredits(xero({
    listNotes: async (_, page) => page === 1 ? [note({ Allocations: [
      { Invoice: { InvoiceID: 'inv' } }, { Invoice: { InvoiceID: 'other' } },
    ] })] : [],
  }));
  assert.equal(partial.notes[0].ambiguousAttribution, true);
});
test('missing linked identities, repeated pages and scan caps cannot establish complete accounting coverage', async () => {
  assert.equal((await discoverInvoiceCredits(xero({
    readInvoice: async () => ({ InvoiceID: 'inv', Contact: { ContactID: 'contact' }, CreditNotes: [{ CreditNoteID: 'missing' }] }),
  }))).complete, false);
  await assert.rejects(discoverInvoiceCredits(xero({ listNotes: async () => [note()] })), /pagination/);
  await assert.rejects(discoverInvoiceCredits(xero({ listNotes: async (_, page) => [note({ CreditNoteID: `cn${page}` })] })), /coverage incomplete/);
});
const qbo = overrides => ({
  provider: 'quickbooks', invoiceId: '1',
  readInvoice: async () => ({ Id: '1', CustomerRef: { value: '10' }, LinkedTxn: [{ TxnId: '5', TxnType: 'Payment' }] }),
  readPayment: async () => ({ Id: '5', CustomerRef: { value: '10' }, Line: [{ LinkedTxn: [
    { TxnId: '1', TxnType: 'Invoice' }, { TxnId: '7', TxnType: 'CreditMemo' },
  ] }] }),
  listNotes: async (_, page) => page === 1 ? [{ Id: '7', CustomerRef: { value: '10' }, TotalAmt: 8, CurrencyRef: { value: 'GBP' } }] : [],
  ...overrides,
});
test('QuickBooks payment links discover invoice credit memos with customer and invoice identity validation', async () => {
  const result = await discoverInvoiceCredits(qbo());
  assert.equal(result.notes[0].providerId, '7');
  assert.equal(result.notes[0].amount, null);
  assert.equal(result.notes[0].ambiguousAttribution, true);
  assert.equal(result.complete, true);
  await assert.rejects(discoverInvoiceCredits(qbo({
    readPayment: async () => ({ Id: 'wrong' }),
  })), /identity/);
  await assert.rejects(discoverInvoiceCredits(qbo({
    readPayment: async () => ({ Id: '5', CustomerRef: { value: '10' }, Line: [] }),
  })), /linkage/);
  const empty = await discoverInvoiceCredits(qbo({
    readInvoice: async () => ({ Id: '1', CustomerRef: { value: '10' } }), listNotes: async () => [],
  }));
  assert.equal(empty.complete, true);
});

test('partially applied QuickBooks memo never substitutes its full total for invoice credit', async () => {
  const result = await discoverInvoiceCredits(qbo({
    readPayment: async () => ({ Id: '5', CustomerRef: { value: '10' }, Line: [
      { Amount: 20, LinkedTxn: [{ TxnId: '1', TxnType: 'Invoice' }] },
      { Amount: 20, LinkedTxn: [{ TxnId: '7', TxnType: 'CreditMemo' }] },
    ] }),
    listNotes: async (_, page) => page === 1
      ? [{ Id: '7', CustomerRef: { value: '10' }, TotalAmt: 100, CurrencyRef: { value: 'GBP' } }] : [],
  }));
  assert.equal(result.notes[0].amount, null);
  assert.equal(result.notes[0].ambiguousAttribution, true);
});

test('Xero wrapper uses only tenant-authorized GET requests and customer-filtered pagination', async () => {
  const id = '00000000-0000-0000-0000-000000000001';
  const customer = '00000000-0000-0000-0000-000000000002';
  const urls = [];
  const result = await readXeroInvoiceCreditEvidence('app-tenant', id, {
    loadToken: async tenant => { assert.equal(tenant, 'app-tenant'); return { accessToken: 'test', tenantId: 'xero-tenant' }; },
    fetcher: async (url, options) => {
      urls.push(url);
      assert.equal(options.method, 'GET');
      assert.equal(options.headers['xero-tenant-id'], 'xero-tenant');
      return { ok: true, json: async () => url.includes('/Invoices/')
        ? { Invoices: [{ InvoiceID: id, Contact: { ContactID: customer } }] } : { CreditNotes: [] } };
    },
  });
  assert.equal(result.complete, true);
  assert.equal(urls.length, 2);
  assert.match(decodeURIComponent(urls[1]), /Contact.ContactID==Guid/);
  await assert.rejects(readXeroInvoiceCreditEvidence('app-tenant', id, {
    loadToken: async () => ({}), fetcher: async () => ({ ok: false, status: 429 }),
  }), /lookup failed/);
});
test('QuickBooks wrapper uses SELECT-only bounded customer pages and validates company-scoped identity', async () => {
  const queries = [];
  const result = await readQuickBooksInvoiceCreditEvidence('app-tenant', '1', {
    loadToken: async tenant => { assert.equal(tenant, 'app-tenant'); return { accessToken: 'test', realmId: 'realm', environment: 'sandbox' }; },
    queryReader: async (_, realm, environment, sql) => {
      assert.equal(realm, 'realm'); assert.equal(environment, 'sandbox');
      assert.match(sql, /^SELECT /); queries.push(sql);
      return sql.includes('FROM Invoice')
        ? { QueryResponse: { Invoice: [{ Id: '1', CustomerRef: { value: '10' } }] } }
        : { QueryResponse: {} };
    },
  });
  assert.equal(result.complete, true);
  assert.match(queries[1], /CustomerRef = '10' STARTPOSITION 1 MAXRESULTS 100/);
  await assert.rejects(readQuickBooksInvoiceCreditEvidence('app-tenant', "1' OR 1=1"), /Invalid/);
});