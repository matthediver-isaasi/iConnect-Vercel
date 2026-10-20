import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAccountingEventSource, reconcileQuickBooksEventInvoices } from './accountingEventSource.js';

function fixture({ stripe = true, missing = false, throttle = null } = {}) {
  const calls = [];
  const row = { id: 'q', tenant_id: 'tenant', source_type: 'booking', source_id: 'group', provider: 'quickbooks',
    company_id: 'realm', snapshot: { version: 1, preparation: true, environment: 'production',
      invoice: { amount: 20, currency: 'GBP', paymentMethod: stripe ? 'stripe' : 'invoice',
        contact: { name: 'Buyer', email: 'buyer@example.test', provenance: { kind: 'guest_purchaser' } },
        date: '2026-10-08', dueDate: '2026-11-07', reference: 'PO1',
        settings: missing ? {} : { quickbooks_event_item_id: 'item', quickbooks_event_tax_code_id: 'tax', quickbooks_event_stripe_bank_account_id: 'bank' },
        lines: [{ Description: 'Ticket', Quantity: 1, UnitAmount: 20, TaxType: 'NONE', TaxAmount: 0, _checkoutTaxPercentage: 0, _invoiceLineAmountType: 'Exclusive' }] },
      payment: stripe ? { paymentIntentId: 'pi_original', status: 'succeeded', livemode: true, amount: 20, currency: 'GBP', paidAt: '2026-10-01T12:00:00Z' } : null,
      linkage: { source: 'booking', group: 'group' } } };
  const db = { from() { return { select() { return this; }, eq() { return this; }, async in() { return { data: [] }; } }; } };
  const transport = { async fetch(url, init) {
    calls.push([url, init]);
    if (url.includes(throttle || 'never-match')) throw Object.assign(new Error('throttle'), { status: 429, retryAfter: '600' });
    if (url.includes('/item/')) return Response.json({ Item: { Id: 'item', Type: 'Service' } });
    if (url.includes('/taxcode/')) return Response.json({ TaxCode: { Id: 'tax', Taxable: false } });
    if (url.includes('/account/')) return Response.json({ Account: { Id: 'bank', AccountType: 'Bank', CurrencyRef: { value: 'GBP' } } });
    if (url.includes('/query?')) return Response.json({ QueryResponse: { Customer: [{ Id: 'customer', PrimaryEmailAddr: { Address: 'buyer@example.test' } }] } });
    throw new Error('Unexpected request');
  } };
  return { row, db, transport, calls };
}

for (const stripe of [false, true]) test(`QBO event preparation freezes exact economics and original receipt: ${stripe}`, async () => {
  const f = fixture({ stripe });
  const original = structuredClone(f.row.snapshot);
  const resolved = await prepareAccountingEventSource(f);
  assert.deepEqual(f.row.snapshot, original);
  assert.equal(resolved.invoice.envelope.expected.totalMinor, 2000);
  assert.equal(resolved.invoice.envelope.payload.Line[0].SalesItemLineDetail.ItemRef.value, 'item');
  assert.equal(resolved.preparation, undefined);
  if (stripe) {
    assert.equal(resolved.payment.envelope.payload.TxnDate, '2026-10-01');
    assert.equal(resolved.payment.envelope.payload.DepositToAccountRef.value, 'bank');
    assert.equal(resolved.payment.envelope.expected.invoiceId, '$invoice');
  } else assert.equal(resolved.payment, null);
  assert.ok(f.calls.every(([, init]) => init.method === 'GET'));
});

for (const throttle of ['/item/', '/taxcode/', '/account/', '/query?']) test(`QBO preparation preserves throttle at ${throttle}`, async () => {
  const f = fixture({ throttle });
  await assert.rejects(prepareAccountingEventSource(f), error => error.status === 429 && error.retryAfter === '600');
  assert.ok(f.calls.at(-1)[0].includes(throttle));
});

test('missing mappings are retryable without provider requests or membership fallbacks', async () => {
  const f = fixture({ missing: true });
  await assert.rejects(prepareAccountingEventSource(f), error => error.retry && error.code === 'ACCOUNTING_EVENT_MAPPING_REQUIRED');
  assert.equal(f.calls.length, 0);
});

test('test payments and changed checkout totals never reach financial writes', async () => {
  for (const mutate of [f => { f.row.snapshot.payment.livemode = false; }, f => { f.row.snapshot.invoice.amount = 21; }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(prepareAccountingEventSource(f), error => error.permanent);
    assert.ok(f.calls.every(([, init]) => init.method === 'GET'));
  }
});

test('event schedule processes accepted QBO requests independently of rollout flags', async () => {
  const calls = [];
  await reconcileQuickBooksEventInvoices({ db: { async rpc(name) { assert.equal(name, 'accounting_event_due'); return { data: ['q'] }; } },
    process: async args => calls.push(args.requestId) });
  assert.deepEqual(calls, ['q']);
});

test('new QBO customer and invoice retain captured address lines, folding overflow without guessing locality', async () => {
  const f = fixture();
  f.row.snapshot.invoice.contact.address = ' 1 Personal Road \n\nFlat 2\nTown\nCounty\nAA1 1AA\nUnited Kingdom';
  const original = structuredClone(f.row.snapshot);
  const expected = { Line1: '1 Personal Road', Line2: 'Flat 2', Line3: 'Town', Line4: 'County', Line5: 'AA1 1AA, United Kingdom' };
  const fetch = f.transport.fetch;
  let customerPayload;
  f.transport.fetch = async (url, init) => {
    if (url.includes('/query?')) return Response.json({ QueryResponse: { Customer: [] } });
    if (url.includes('/customer?')) {
      customerPayload = JSON.parse(init.body);
      return Response.json({ Customer: { Id: 'new-customer', ...customerPayload } });
    }
    return fetch(url, init);
  };
  const s = await prepareAccountingEventSource(f);
  assert.deepEqual(customerPayload.BillAddr, expected);
  assert.deepEqual(s.invoice.envelope.payload.BillAddr, expected);
  assert.deepEqual(s.invoice.envelope.expected.fields.BillAddr, expected);
  assert.deepEqual(f.row.snapshot, original);
});

test('existing QBO customer billing address is preserved without customer writes', async () => {
  const f = fixture();
  f.row.snapshot.invoice.contact.address = 'Different captured road\nTown';
  const providerAddress = { Id: 'address-id', Line1: 'Provider-held road', City: 'Existing town', PostalCode: 'AA1 1AA' };
  const fetch = f.transport.fetch;
  f.transport.fetch = async (url, init) => url.includes('/query?')
    ? Response.json({ QueryResponse: { Customer: [{ Id: 'customer', PrimaryEmailAddr: { Address: 'buyer@example.test' }, BillAddr: providerAddress }] } })
    : fetch(url, init);
  const s = await prepareAccountingEventSource(f);
  const { Id, ...expected } = providerAddress;
  assert.deepEqual(s.invoice.envelope.payload.BillAddr, expected);
  assert.ok(f.calls.every(([, init]) => init.method === 'GET'));
});

test('existing QBO customer without a billing address uses captured address on invoice only', async () => {
  const f = fixture();
  f.row.snapshot.invoice.contact.address = 'Captured road\nTown\nAA1 1AA';
  const s = await prepareAccountingEventSource(f);
  assert.deepEqual(s.invoice.envelope.payload.BillAddr, { Line1: 'Captured road', Line2: 'Town', Line3: 'AA1 1AA' });
  assert.ok(f.calls.every(([, init]) => init.method === 'GET'));
});

for (const address of [undefined, ' \n\t ', { line1: 'Unsupported structured address' }]) {
  test(`QBO does not invent billing address for ${JSON.stringify(address)}`, async () => {
    const f = fixture();
    f.row.snapshot.invoice.contact.address = address;
    const s = await prepareAccountingEventSource(f);
    assert.equal(s.invoice.envelope.payload.BillAddr, undefined);
    assert.equal(s.invoice.envelope.expected.fields.BillAddr, undefined);
    assert.ok(f.calls.every(([, init]) => init.method === 'GET'));
  });
}
