import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventInvoiceRecoveryXero } from './eventInvoiceRecoveryXero.js';
import { processEventInvoiceRecovery, recoveryIdentity } from './eventInvoiceRecovery.js';

const job = () => ({
  id: 'operation', tenant_id: 'tenant', source: 'booking', booking_group_reference: 'BOOK-EXACT',
  lease_token: 'lease', attempts: 1,
  snapshot: {
    version: 1, provider: { connectionId: 'connection', xeroTenantId: 'org' },
    legacyDiscovery: { version: 1, fromDate: '2026-09-01', toDate: '2026-10-02' },
    contact: { email: 'buyer@example.test' }, currency: 'GBP', amount: 166.67, paymentMethod: 'stripe',
    invoice: {
      Type: 'ACCREC', Status: 'AUTHORISED', CurrencyCode: 'GBP', LineAmountTypes: 'Inclusive',
      Date: '2026-09-21', DueDate: '2026-10-21', Contact: { ContactID: 'buyer' }, Reference: 'TBC',
      LineItems: [{ Description: 'Approved event ticket', Quantity: 1, UnitAmount: 166.67,
        AccountCode: '200', TaxType: 'OUTPUT2', TaxAmount: 27.78 }],
    },
    settlement: { paymentIntentId: 'pi_FullExact123', status: 'succeeded', livemode: true,
      amount: 166.67, currency: 'GBP', paidAt: '2026-09-21T10:00:00Z', accountCode: '090' },
  },
});
const oldInvoice = (changes = {}) => {
  const j = job();
  return { ...j.snapshot.invoice, InvoiceID: 'old-invoice', InvoiceNumber: 'INV-OLD', Reference: 'PO-123',
    Status: 'PAID', Total: 166.67, AmountPaid: 166.67, AmountDue: 0,
    LineItems: [{ ...j.snapshot.invoice.LineItems[0], LineAmount: 166.67,
      Description: 'Historical event registration (pi_FullExact123)' }], ...changes };
};
const oldPayment = (changes = {}) => ({
  PaymentID: 'old-payment', Reference: 'Stripe: pi_FullExact123', Amount: 166.67, Status: 'AUTHORISED',
  Date: '/Date(1789948800000+0000)/', Account: { Code: '090' },
  Invoice: { InvoiceID: 'old-invoice', CurrencyCode: 'GBP' }, ...changes,
});
function database(j = job()) {
  const journal = [];
  return { journal,
    from(table) {
      return { select() { return this; }, eq() { return this; },
        async maybeSingle() {
          return { data: table === 'tenant_accounting_settings' ? { active_provider: 'xero' }
            : table === 'tenant_integrations' ? { is_enabled: true }
              : { id: 'connection', tenant_id: 'org', access_token: 'isolated-token',
                expires_at: new Date(Date.now() + 3600_000).toISOString() } };
        } };
    },
    async rpc(name, args) {
      journal.push([name, args]);
      return { data: name.endsWith('_claim') ? j : true };
    },
  };
}
async function fixture({ row = job(), invoicePages = [[oldInvoice()], []],
  paymentPages = [[oldPayment()], []], exact = [], handler = null } = {}) {
  const calls = [];
  const db = database(row);
  const identity = recoveryIdentity(row.tenant_id, row.source, row.booking_group_reference);
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ url: decodeURIComponent(url), init });
    assert.equal(init.headers['xero-tenant-id'], 'org');
    assert.ok(init.signal);
    assert.equal(init.method, 'GET', 'legacy evidence discovery must not write');
    if (handler) {
      const result = handler(parsed, init);
      if (result) return result;
    }
    let data;
    const page = Number(parsed.searchParams.get('page') || 1);
    if (/\/Invoices\/[^/]+$/.test(parsed.pathname)) data = { Invoices: [oldInvoice()] };
    else if (/\/Payments\/[^/]+$/.test(parsed.pathname)) data = { Payments: [oldPayment()] };
    else if (parsed.pathname.endsWith('/Payments')) data = { Payments: paymentPages[page - 1] || [] };
    else if (parsed.searchParams.get('where')?.startsWith('InvoiceNumber==')) data = { Invoices: exact };
    else data = { Invoices: invoicePages[page - 1] || [] };
    return { ok: true, status: 200, json: async () => data };
  };
  const options = { db, row, identity, guard: async () => {}, deadlineAt: Date.now() + 30_000, fetchImpl };
  const adapter = await createEventInvoiceRecoveryXero(options);
  return { adapter, calls, db, options };
}

test('fully paginated legacy invoice/payment adoption accepts PO/TBC and full PI, not new number', async () => {
  const { adapter, calls } = await fixture();
  const [invoice] = await adapter.findInvoices();
  const [payment] = await adapter.findPayments();
  assert.equal(invoice.InvoiceNumber, 'INV-OLD');
  assert.doesNotThrow(() => adapter.validateInvoice(invoice));
  assert.doesNotThrow(() => adapter.validatePayment(payment, invoice));
  assert.equal(calls.length, 5);
  assert.ok(calls[1].url.includes('Date>=DateTime(2026,09,01)'));
  assert.ok(calls[3].url.includes('Reference=="Stripe: pi_FullExact123"'));
  assert.ok(calls[2].url.includes('page=2'));
  assert.ok(calls[4].url.includes('page=2'));
  await assert.rejects(adapter.createInvoice(), /invoice_creation_ambiguous/);
  await assert.rejects(adapter.createPayment(invoice), /payment_creation_ambiguous/);
});

test('processor adopts paid legacy evidence and journals both IDs without starting a write', async () => {
  const f = await fixture();
  const result = await processEventInvoiceRecovery({ db: f.db,
    providerFactory: options => createEventInvoiceRecoveryXero({ ...options, fetchImpl: f.options.fetchImpl }) });
  assert.equal(result.status, 'complete');
  assert.equal(f.db.journal.some(([name]) => name.endsWith('_start_write')), false);
  assert.equal(f.db.journal.at(-1)[1].p_invoice_id, 'old-invoice');
  assert.equal(f.db.journal.at(-1)[1].p_payment_id, 'old-payment');
});

test('second-page evidence is adopted and exact duplicate invoices fail closed', async () => {
  const unrelated = oldInvoice({ InvoiceID: 'other', Total: 200, AmountPaid: 166.67,
    LineItems: [{ ...oldInvoice().LineItems[0], Description: 'Same event pi_Unrelated' }] });
  const f = await fixture({ invoicePages: [[unrelated], [oldInvoice()], []] });
  assert.equal((await f.adapter.findInvoices())[0].InvoiceID, 'old-invoice');
  const conflict = await fixture({ invoicePages: [[oldInvoice(),
    oldInvoice({ InvoiceID: 'second-old-invoice' })], []] });
  await assert.rejects(conflict.adapter.findInvoices(), /invoice_identity_ambiguous/);
});

test('exact legacy payment discovers its invoice outside invoice search window', async () => {
  const f = await fixture({ invoicePages: [[]] });
  const [invoice] = await f.adapter.findInvoices();
  assert.equal(invoice.InvoiceID, 'old-invoice');
  assert.ok(f.calls.some(call => call.url.endsWith('/Invoices/old-invoice')));
  f.adapter.validateInvoice(invoice);
});

test('truncated/prefix PI, PO, title and same amount are not identities', async () => {
  for (const description of ['pi_FullExact', 'pi_FullExact123extra', 'pi_FullExact123_suffix', 'Approved event ticket']) {
    const f = await fixture({ invoicePages: [[oldInvoice({
      Reference: 'BOOK-EXACT', LineItems: [{ ...oldInvoice().LineItems[0], Description: description }],
    })], []], paymentPages: [[]] });
    assert.deepEqual(await f.adapter.findInvoices(), []);
  }
});

test('amount 200 paid 166.67 is not adopted or used as a financial template', async () => {
  const f = await fixture({ invoicePages: [[oldInvoice({ Total: 200 })], []] });
  const [invoice] = await f.adapter.findInvoices();
  assert.throws(() => f.adapter.validateInvoice(invoice), /invoice_evidence_mismatch/);
});

test('legacy financial VAT, account, dates, currency and purchaser are still exact', async () => {
  const f = await fixture();
  const [invoice] = await f.adapter.findInvoices();
  for (const change of [{ CurrencyCode: 'USD' }, { Date: '2026-09-22' }, { DueDate: '2026-10-22' },
    { Contact: { ContactID: 'someone-else' } }, { LineAmountTypes: 'Exclusive' },
    { LineItems: [{ ...invoice.LineItems[0], TaxAmount: 33.33 }] },
    { LineItems: [{ ...invoice.LineItems[0], TaxType: 'NONE' }] },
    { LineItems: [{ ...invoice.LineItems[0], AccountCode: '201' }] }]) {
    assert.throws(() => f.adapter.validateInvoice({ ...invoice, ...change }), /invoice_evidence_mismatch/);
  }
  for (const change of [{ Reference: 'Stripe: pi_FullExact' }, { Amount: 200 },
    { Status: 'DELETED' }, { Account: { Code: 'elsewhere' } },
    { Invoice: { InvoiceID: 'other', CurrencyCode: 'GBP' } }, { Date: '2026-09-22' }]) {
    assert.throws(() => f.adapter.validatePayment(oldPayment(change), invoice), /payment_evidence_mismatch/);
  }
  assert.throws(() => f.adapter.validatePayment(oldPayment(), { ...invoice, AmountPaid: 200 }),
    /payment_evidence_mismatch/);
});

test('known invoice and payment IDs win without scanning; missing IDs cannot create', async () => {
  const row = { ...job(), invoice_id: 'old-invoice', payment_id: 'old-payment' };
  const f = await fixture({ row });
  const [invoice] = await f.adapter.findInvoices();
  f.adapter.validateInvoice(invoice);
  f.adapter.validatePayment((await f.adapter.findPayments())[0], invoice);
  assert.deepEqual(f.calls.map(call => new URL(call.url).pathname.split('/').at(-1)),
    ['old-invoice', 'old-payment']);
  const missing = await fixture({ row, handler: url => url.pathname.endsWith('/Invoices/old-invoice')
    ? { ok: true, json: async () => ({ Invoices: [] }) } : null });
  await assert.rejects(missing.adapter.findInvoices(), /known_invoice_unavailable/);
  await assert.rejects(missing.adapter.createInvoice(), /known_invoice_unavailable/);
  const paymentOnly = await fixture({ row: { ...job(), payment_id: 'old-payment' } });
  assert.equal((await paymentOnly.adapter.findInvoices())[0].InvoiceID, 'old-invoice');
  assert.deepEqual(paymentOnly.calls.map(call => new URL(call.url).pathname.split('/').at(-1)),
    ['old-payment', 'old-invoice']);
});

test('failed, malformed, repeated or unterminated pages never authorize writes', async () => {
  for (const options of [
    { invoicePages: [[oldInvoice({ LineItems: undefined })], []] },
    { invoicePages: [[oldInvoice()], [oldInvoice()]] },
    { invoicePages: [[oldInvoice({ InvoiceID: 'one' })], [oldInvoice({ InvoiceID: 'two' })],
      [oldInvoice({ InvoiceID: 'three' })]] },
    { handler: url => url.searchParams.get('page') === '2'
      ? { ok: false, status: 503 } : null },
    { handler: url => url.pathname.endsWith('/Payments')
      ? { ok: true, json: async () => ({ Payments: null }) } : null },
  ]) {
    const f = await fixture(options);
    await assert.rejects(f.adapter.findInvoices());
    await assert.rejects(f.adapter.createInvoice());
    assert.equal(f.calls.some(call => call.init.method !== 'GET'), false);
  }
});

test('legacy rate limits preserve Retry-After and stop processing before write journals', async () => {
  const f = await fixture({ handler: url => url.searchParams.has('page')
    ? { ok: false, status: 429, headers: new Headers({ 'retry-after': '7200' }) } : null });
  const result = await processEventInvoiceRecovery({ db: f.db, random: () => 0,
    providerFactory: options => createEventInvoiceRecoveryXero({ ...options, fetchImpl: f.options.fetchImpl }) });
  assert.equal(result.status, 'retry');
  assert.equal(f.calls.length, 2);
  assert.equal(f.db.journal.at(-1)[1].p_reason, 'provider_rate_limited');
  assert.equal(f.db.journal.some(([name]) => name.endsWith('_start_write')), false);
  assert.ok(Date.parse(f.db.journal.at(-1)[1].p_cooldown) > Date.now() + 7200_000);
});

test('same-name legacy purchaser needs exact email; payment ambiguity prevents creation', async () => {
  const row = job();
  row.snapshot.invoice.Contact = { Name: 'Purchaser' };
  const f = await fixture({ row, invoicePages: [[oldInvoice({
    Contact: { Name: 'Purchaser', EmailAddress: 'wrong@example.test' },
  })], []] });
  assert.throws(() => f.adapter.validateInvoice((oldInvoice({
    Contact: { Name: 'Purchaser', EmailAddress: 'buyer@example.test' },
  }))), /invoice_evidence_mismatch/, 'not discovered yet, not authorized');
  const [invoice] = await f.adapter.findInvoices();
  assert.throws(() => f.adapter.validateInvoice(invoice), /invoice_evidence_mismatch/);
  assert.doesNotThrow(() => f.adapter.validateInvoice({ ...invoice,
    Contact: { Name: 'Purchaser', EmailAddress: 'BUYER@example.test' } }));
  const conflict = await fixture({ paymentPages: [[oldPayment(),
    oldPayment({ PaymentID: 'second' })], []] });
  await assert.rejects(conflict.adapter.findInvoices(), /payment_identity_ambiguous/);
});

test('invoice/account booking adoption requires an explicitly exact booking reference', async () => {
  const row = job();
  row.snapshot.paymentMethod = 'invoice';
  row.snapshot.settlement = null;
  await assert.rejects(fixture({ row }), /legacy_discovery_scope_invalid/);
  row.snapshot.legacyDiscovery.bookingReference = row.booking_group_reference;
  const f = await fixture({ row, invoicePages: [[oldInvoice({ Reference: 'BOOK-EXACT',
    LineItems: [{ ...oldInvoice().LineItems[0], Description: 'Historical invoice event' }] })], []] });
  const [invoice] = await f.adapter.findInvoices();
  f.adapter.validateInvoice(invoice);
  assert.deepEqual(await f.adapter.findPayments(), []);
  assert.equal(f.calls.some(call => call.url.includes('/Payments')), false);
});

test('old paid invoice without its exact payment evidence is review, never a new payment', async () => {
  const f = await fixture({ paymentPages: [[]] });
  const result = await processEventInvoiceRecovery({ db: f.db,
    providerFactory: options => createEventInvoiceRecoveryXero({ ...options, fetchImpl: f.options.fetchImpl }) });
  assert.equal(result.status, 'needs_review');
  assert.equal(f.db.journal.at(-1)[1].p_reason, 'invoice_settlement_mismatch');
  assert.equal(f.db.journal.some(([name]) => name.endsWith('_start_write')), false);
});

test('request budget and deadline remain fail-closed during legacy discovery', async () => {
  const f = await fixture();
  let guarded = 0;
  const adapter = await createEventInvoiceRecoveryXero({ ...f.options,
    guard: async () => { guarded++; },
    fetchImpl: async (url, init) => {
      assert.equal(init.method, 'GET');
      if (url.includes('InvoiceNumber')) return { ok: true, json: async () => ({ Invoices: [] }) };
      if (url.includes('/Payments')) return { ok: true, json: async () => ({ Payments: [] }) };
      return { ok: true, json: async () => ({ Invoices: [oldInvoice({
        Contact: { ContactID: 'buyer', Name: 'Purchaser' },
      })] }) };
    } });
  // The ordinary no-network deadline path rejects before provider calls.
  await assert.rejects(createEventInvoiceRecoveryXero({ ...f.options, deadlineAt: Date.now() - 1 }),
    /time_budget/);
  // Repeated pages fail closed before any attempt at writing.
  await assert.rejects(adapter.findInvoices(), /legacy_lookup_ambiguous/);
  assert.equal(guarded, 3);
  const unrelated = id => oldInvoice({ InvoiceID: id,
    LineItems: [{ ...oldInvoice().LineItems[0], Description: 'pi_Unrelated' }] });
  const exhausted = await fixture({
    invoicePages: [[unrelated('one')], [unrelated('two')], []],
    paymentPages: [[oldPayment()], [oldPayment({ PaymentID: 'second-payment',
      Invoice: { InvoiceID: 'second-invoice' } })], []],
  });
  await assert.rejects(exhausted.adapter.findInvoices(), /request_budget/);
  assert.equal(exhausted.calls.length, 8);
  await assert.rejects(exhausted.adapter.createInvoice(), /request_budget/);
});

test('legacy scope must cover the evidenced date and malformed exact payment responses block creation', async () => {
  const row = job();
  row.snapshot.legacyDiscovery.fromDate = '2026-09-22';
  await assert.rejects(fixture({ row }), /legacy_discovery_scope_invalid/);
  const f = await fixture({ paymentPages: [[oldPayment({ Reference: 'Stripe: pi_FullExact' })], []] });
  await assert.rejects(f.adapter.findInvoices(), /payment_lookup_invalid/);
  await assert.rejects(f.adapter.createInvoice(), /payment_lookup_invalid/);
});

test('only complete absence authorizes journaled writes with stable deterministic keys', async () => {
  const row = job();
  const db = database(row);
  const identity = recoveryIdentity(row.tenant_id, row.source, row.booking_group_reference);
  const calls = [];
  const createdInvoice = { ...row.snapshot.invoice, InvoiceID: 'new-invoice', InvoiceNumber: identity,
    Total: 166.67, AmountPaid: 0, AmountDue: 166.67,
    LineItems: [{ ...row.snapshot.invoice.LineItems[0], LineAmount: 166.67 }] };
  const result = await processEventInvoiceRecovery({ db,
    providerFactory: options => createEventInvoiceRecoveryXero({ ...options,
      fetchImpl: async (url, init) => {
        calls.push([url, init]);
        let data;
        if (init.method === 'POST') {
          assert.equal(calls.slice(0, -1).every(([, prior]) => prior.method === 'GET'), true);
          assert.equal(calls.length, 4, 'exact invoice, terminal invoice and terminal payment scans precede write');
          assert.equal(init.headers['Idempotency-Key'], `${identity}-invoice`);
          data = { Invoices: [createdInvoice] };
        } else if (init.method === 'PUT') {
          assert.equal(init.headers['Idempotency-Key'], `${identity}-payment`);
          data = { Payments: [oldPayment({ PaymentID: 'new-payment',
            Reference: `${identity}:pi_FullExact123`,
            Invoice: { InvoiceID: 'new-invoice', CurrencyCode: 'GBP' } })] };
        } else if (url.includes('/Accounts')) {
          data = { Accounts: [{ Code: '090', Status: 'ACTIVE', Type: 'BANK', CurrencyCode: 'GBP' }] };
        } else data = url.includes('/Payments') ? { Payments: [] } : { Invoices: [] };
        return { ok: true, json: async () => data };
      } }) });
  assert.equal(result.status, 'complete');
  assert.deepEqual(db.journal.filter(([name]) => name.endsWith('_start_write')).map(([, args]) => args.p_kind),
    ['invoice', 'payment']);
});