import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueEventInvoiceRecovery, processEventInvoiceRecovery, providerCooldown,
  recoveryIdentity, validRecoverySnapshot } from './eventInvoiceRecovery.js';
import { createEventInvoiceRecoveryXero } from './eventInvoiceRecoveryXero.js';
import { eventRecoveryCronHandler, validEventRecoveryCronSecret } from '../cron/reconcile-event-invoices.js';
import { eventInvoiceRecoveryHealthHandler } from '../health/event-invoice-recovery.js';

const snapshot = () => ({
  version: 1, provider: { connectionId: 'connection', xeroTenantId: 'org' },
  invoice: { Type: 'ACCREC', Status: 'AUTHORISED', CurrencyCode: 'GBP', LineAmountTypes: 'Exclusive',
    Contact: { ContactID: 'contact' }, Date: '2026-01-01', DueDate: '2026-01-31',
    LineItems: [{ Description: 'Event ticket', Quantity: 1, UnitAmount: 20, AccountCode: '200', TaxType: 'NONE', TaxAmount: 0 }] },
  contact: { email: 'buyer@example.test' }, currency: 'GBP', amount: 20, paymentMethod: 'stripe',
  settlement: { paymentIntentId: 'pi_123', status: 'succeeded', amount: 20, currency: 'GBP',
    paidAt: '2026-01-01T10:00:00Z', accountCode: '090' },
});
const row = () => ({ id: 'job', tenant_id: 'tenant', source: 'booking', booking_group_reference: 'group',
  lease_token: 'lease', attempts: 1, snapshot: snapshot() });

function mockDb(job = row()) {
  const calls = [];
  return { calls, async rpc(name, args) {
    calls.push([name, args]);
    if (name.endsWith('_claim')) return { data: job };
    return { data: true };
  } };
}
const invoice = () => ({ InvoiceID: 'invoice', InvoiceNumber: 'INV-1', Status: 'AUTHORISED', AmountPaid: 0, AmountDue: 20 });
const provider = overrides => ({
  findInvoices: async () => [], findPayments: async () => [],
  createInvoice: async () => invoice(), validateInvoice() {},
  createPayment: async () => ({ PaymentID: 'payment' }), validatePayment() {}, ...overrides,
});
const response = () => ({
  headers: {}, setHeader(key, value) { this.headers[key] = value; },
  status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; },
});

test('snapshot fail-closed; separate stable tenant/source operation identities', async () => {
  assert.equal(validRecoverySnapshot(snapshot()), true);
  for (const changed of [
    { settlement: null }, { amount: 0 }, { currency: 'USD' }, { paymentMethod: 'public_invoice_po' },
    { provider: null }, { invoice: { ...snapshot().invoice, Status: 'DRAFT' } },
  ]) assert.equal(validRecoverySnapshot({ ...snapshot(), ...changed }), false);
  const db = mockDb();
  await enqueueEventInvoiceRecovery({ db, tenantId: 't', source: 'booking', bookingGroupReference: 'g', snapshot: null });
  assert.equal(db.calls[0][1].p_valid, false);
  assert.equal(recoveryIdentity('t', 'booking', 'g'), recoveryIdentity('t', 'booking', 'g'));
  assert.notEqual(recoveryIdentity('t', 'booking', 'g'), recoveryIdentity('u', 'booking', 'g'));
  assert.notEqual(recoveryIdentity('t', 'booking', 'g'), recoveryIdentity('t', 'complex_event_booking', 'g'));
});

test('remote exact invoice and settlement reconciliation precedes creates', async () => {
  const order = [];
  const db = mockDb();
  const result = await processEventInvoiceRecovery({ db, providerFactory: async () => provider({
    findInvoices: async () => { order.push('findInvoice'); return []; },
    findPayments: async () => { order.push('findPayment'); return []; },
    createInvoice: async () => { order.push('createInvoice'); return invoice(); },
    createPayment: async () => { order.push('createPayment'); return { PaymentID: 'payment' }; },
  }) });
  assert.deepEqual(order, ['findInvoice', 'findPayment', 'createInvoice', 'createPayment']);
  assert.equal(result.status, 'complete');
  assert.equal(db.calls.at(-1)[1].p_payment_id, 'payment');
});

test('timeout after invoice success is safely reconciled; no duplicate create on next claim', async () => {
  let savedInvoice;
  let creates = 0;
  const db = mockDb();
  const factory = async () => provider({
    findInvoices: async () => savedInvoice ? [savedInvoice] : [],
    createInvoice: async () => { creates++; savedInvoice = invoice(); throw new Error('lost response'); },
  });
  assert.equal((await processEventInvoiceRecovery({ db, providerFactory: factory })).status, 'retry');
  assert.equal((await processEventInvoiceRecovery({ db, providerFactory: factory })).status, 'complete');
  assert.equal(creates, 1);
});

test('timeout after payment success is reconciled even when invoice now PAID', async () => {
  let savedPayment;
  let creates = 0;
  const factory = async () => provider({
    findInvoices: async () => [{ ...invoice(), ...(savedPayment ? { Status: 'PAID', AmountPaid: 20, AmountDue: 0 } : {}) }],
    findPayments: async () => savedPayment ? [savedPayment] : [],
    createPayment: async () => { creates++; savedPayment = { PaymentID: 'payment' }; throw new Error('lost response'); },
    createInvoice: async () => assert.fail('must not create invoice'),
  });
  assert.equal((await processEventInvoiceRecovery({ db: mockDb(), providerFactory: factory })).status, 'retry');
  assert.equal((await processEventInvoiceRecovery({ db: mockDb(), providerFactory: factory })).status, 'complete');
  assert.equal(creates, 1);
});

test('already paid without exact settlement and ambiguous identities require review without writes', async () => {
  for (const found of [[{ ...invoice(), Status: 'PAID', AmountPaid: 20 }], [invoice(), invoice()]]) {
    const result = await processEventInvoiceRecovery({ db: mockDb(), providerFactory: async () => provider({
      findInvoices: async () => found,
      createInvoice: async () => assert.fail('duplicate'), createPayment: async () => assert.fail('double settlement'),
    }) });
    assert.equal(result.status, 'needs_review');
  }
});

test('missing snapshot and lost financial guard never call provider', async () => {
  const missing = mockDb({ ...row(), snapshot: null });
  assert.equal((await processEventInvoiceRecovery({ db: missing,
    providerFactory: async () => assert.fail('missing snapshot') })).status, 'needs_review');
  const db = mockDb();
  const original = db.rpc;
  db.rpc = async (name, args) => name.endsWith('_guard') ? { data: false } : original(name, args);
  assert.equal((await processEventInvoiceRecovery({ db,
    providerFactory: async () => assert.fail('lost guard') })).status, 'needs_review');
});

test('Retry-After seconds/date get minimum extra five minutes and bounded jitter', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(Date.parse(providerCooldown('60', now, () => 0)) - now, 360_000);
  assert.equal(Date.parse(providerCooldown('Thu, 01 Jan 2026 00:01:00 GMT', now, () => 0.5)) - now, 375_000);
  assert.equal(Date.parse(providerCooldown(null, now, () => 0)) - now, 300_000);
});

function tokenDb() {
  const db = { from(name) {
    if (name === 'tenant_accounting_settings' || name === 'tenant_integrations') {
      return { select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: name === 'tenant_integrations'
          ? { is_enabled: true } : { active_provider: 'xero' } }; } };
    }
    assert.equal(name, 'xero_token');
    return { select() { return this; }, eq() { return this; },
      async maybeSingle() { return { data: { id: 'connection', tenant_id: 'org', access_token: 'fake-token',
        expires_at: new Date(Date.now() + 3600_000).toISOString() } }; } };
  } };
  return db;
}
test('actual adapter pins organization, bounds transport, uses exact where and separate idempotency keys', async () => {
  const calls = [];
  const job = row();
  const identity = recoveryIdentity(job.tenant_id, job.source, job.booking_group_reference);
  const adapter = await createEventInvoiceRecoveryXero({
    db: tokenDb(), row: job, identity, guard: async () => {}, deadlineAt: Date.now() + 30_000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.headers['xero-tenant-id'], 'org');
      assert.ok(init.signal);
      return { ok: true, status: 200, json: async () => url.includes('Accounts?')
        ? { Accounts: [{ Code: '090', Status: 'ACTIVE', Type: 'BANK', CurrencyCode: 'GBP' }] }
        : url.includes('Payments') ? { Payments: [{ PaymentID: 'p' }] } : { Invoices: [invoice()] } };
    },
  });
  await adapter.findInvoices();
  await adapter.findPayments();
  await adapter.createInvoice();
  await adapter.createPayment(invoice());
  assert.match(decodeURIComponent(calls[0].url), new RegExp(`InvoiceNumber=="${identity}"`));
  assert.equal(calls[2].init.headers['Idempotency-Key'], `${identity}-invoice`);
  assert.equal(calls[4].init.headers['Idempotency-Key'], `${identity}-payment`);
  assert.notEqual(calls[2].init.headers['Idempotency-Key'], calls[4].init.headers['Idempotency-Key']);
});

test('provider 429 is persisted once and stops further requests in that attempt', async () => {
  const db = mockDb();
  Object.assign(db, tokenDb());
  let requests = 0;
  const result = await processEventInvoiceRecovery({ db, random: () => 0,
    providerFactory: options => createEventInvoiceRecoveryXero({ ...options, fetchImpl: async () => {
      requests++;
      return { ok: false, status: 429, headers: new Headers({ 'retry-after': '90' }) };
    } }),
  });
  assert.equal(result.status, 'retry');
  assert.equal(requests, 1);
  assert.equal(db.calls.at(-1)[1].p_next, db.calls.at(-1)[1].p_cooldown);
  assert.equal(db.calls.at(-1)[1].p_reason, 'provider_rate_limited');
});

test('adapter rejects changed provider binding before network and mismatched remote evidence', async () => {
  const job = row();
  job.snapshot.provider.xeroTenantId = 'different-org';
  await assert.rejects(() => createEventInvoiceRecoveryXero({
    db: tokenDb(), row: job, identity: 'operation', guard: async () => {}, deadlineAt: Date.now() + 10000,
    fetchImpl: async () => assert.fail('changed binding must never reach provider'),
  }), /provider_binding_changed/);
  job.snapshot.provider.xeroTenantId = 'org';
  const adapter = await createEventInvoiceRecoveryXero({
    db: tokenDb(), row: job, identity: 'operation', guard: async () => {}, deadlineAt: Date.now() + 10000,
    fetchImpl: async () => assert.fail('validation needs no network'),
  });
  const remote = { ...invoice(), Type: 'ACCREC', InvoiceNumber: 'operation',
    Total: 20, CurrencyCode: 'GBP', Contact: { ContactID: 'contact' },
    Date: '2026-01-01', DueDate: '2026-01-31', LineAmountTypes: 'Exclusive',
    LineItems: [{ ...snapshot().invoice.LineItems[0], LineAmount: 20 }] };
  assert.doesNotThrow(() => adapter.validateInvoice(remote));
  for (const change of [{ CurrencyCode: 'USD' }, { Total: 21 }, { InvoiceNumber: 'other' }, { Status: 'VOIDED' }]) {
    assert.throws(() => adapter.validateInvoice({ ...remote, ...change }), /invoice_evidence_mismatch/);
  }
  assert.throws(() => adapter.validatePayment({ PaymentID: 'other', Amount: 20 }, remote), /payment_evidence_mismatch/);
  for (const changed of [{ AccountCode: '201' }, { TaxType: 'OUTPUT' }, { TaxAmount: 1 },
    { Tracking: [{ Name: 'Project', Option: 'different' }] }, { UnitAmount: 10, Quantity: 2 }]) {
    assert.throws(() => adapter.validateInvoice({ ...remote, LineItems: [{ ...remote.LineItems[0], ...changed }] }),
      /invoice_evidence_mismatch/);
  }
  assert.throws(() => adapter.validateInvoice({ ...remote, Date: '2026-02-01' }), /invoice_evidence_mismatch/);
  assert.throws(() => adapter.validateInvoice({ ...remote, DueDate: '2026-02-01' }), /invoice_evidence_mismatch/);
  const settlement = { PaymentID: 'payment', Invoice: { InvoiceID: 'invoice', CurrencyCode: 'GBP' },
    Reference: 'operation:pi_123', Amount: 20, Status: 'AUTHORISED', Account: { Code: '090' }, Date: '2026-01-01' };
  assert.doesNotThrow(() => adapter.validatePayment(settlement, remote));
  assert.throws(() => adapter.validatePayment({ ...settlement, Date: '2026-01-02' }, remote), /payment_evidence_mismatch/);
});

test('persisted invoice ID wins over renamed visible number; never search/create another invoice', async () => {
  const job = { ...row(), invoice_id: 'known-id' };
  const calls = [];
  const remote = { ...invoice(), InvoiceID: 'known-id', InvoiceNumber: 'renamed', Type: 'ACCREC',
    Total: 20, CurrencyCode: 'GBP', Contact: { ContactID: 'contact' },
    Date: '2026-01-01', DueDate: '2026-01-31', LineAmountTypes: 'Exclusive',
    LineItems: [{ ...snapshot().invoice.LineItems[0], LineAmount: 20 }] };
  const adapter = await createEventInvoiceRecoveryXero({
    db: tokenDb(), row: job, identity: 'original', guard: async () => {}, deadlineAt: Date.now() + 10000,
    fetchImpl: async (url, init) => {
      calls.push([url, init.method]);
      return { ok: true, json: async () => ({ Invoices: [remote] }) };
    },
  });
  assert.deepEqual(await adapter.findInvoices(), [remote]);
  assert.doesNotThrow(() => adapter.validateInvoice(remote));
  assert.deepEqual(calls, [['https://api.xero.com/api.xro/2.0/Invoices/known-id', 'GET']]);
});

test('unknown success remains fail-closed after idempotency expiry for invoice and payment', async () => {
  for (const kind of ['invoice', 'payment']) {
    const job = { ...row(), [`${kind}_write_started_at`]: '2020-01-01T00:00:00Z' };
    const result = await processEventInvoiceRecovery({ db: mockDb(job), providerFactory: async () => provider({
      findInvoices: async () => kind === 'payment' ? [invoice()] : [],
      createInvoice: async () => assert.fail('must never recreate ambiguous invoice'),
      createPayment: async () => assert.fail('must never recreate ambiguous payment'),
    }) });
    assert.equal(result.status, 'needs_review');
  }
});

test('known deleted invoice cannot trigger a new invoice, even with an empty exact lookup', async () => {
  const result = await processEventInvoiceRecovery({
    db: mockDb({ ...row(), invoice_id: 'deleted-id' }),
    providerFactory: async () => provider({
      findInvoices: async () => [],
      createInvoice: async () => assert.fail('durable invoice id must never be replaced'),
    }),
  });
  assert.equal(result.status, 'needs_review');
});

test('expired wall budget fails before claim/provider requests, and provider request count is bounded', async () => {
  let called = false;
  const db = mockDb();
  await assert.rejects(() => processEventInvoiceRecovery({
    db, deadlineAt: Date.now() - 1, providerFactory: async () => { called = true; },
  }), /budget exhausted/);
  assert.equal(called, false);
  let requests = 0;
  const adapter = await createEventInvoiceRecoveryXero({
    db: tokenDb(), row: row(), identity: 'operation', guard: async () => {}, deadlineAt: Date.now() + 10000,
    fetchImpl: async () => {
      requests++;
      return { ok: true, json: async () => ({ Invoices: [] }) };
    },
  });
  for (let i = 0; i < 8; i++) await adapter.findInvoices();
  await assert.rejects(() => adapter.findInvoices(), /request_budget/);
  assert.equal(requests, 8);
});

test('public health is aggregate only and never calls a provider; failures fail closed', async () => {
  for (const [status, healthy, code] of [
    ['healthy', true, 200], ['waiting_provider', true, 200],
    ['never_succeeded', false, 503], ['stale', false, 503], ['overdue', false, 503], ['stuck', false, 503],
  ]) {
    const res = response();
    await eventInvoiceRecoveryHealthHandler({ db: { rpc: async name => {
      assert.equal(name, 'event_invoice_recovery_health');
      return { data: { status, healthy, secret: 'must not leak' } };
    } } })({ method: 'GET' }, res);
    assert.equal(res.code, code);
    assert.deepEqual(res.body, { status });
  }
  const res = response();
  await eventInvoiceRecoveryHealthHandler({ db: { rpc: async () => ({ error: new Error('sensitive') }) } })({ method: 'GET' }, res);
  assert.equal(res.code, 503);
  assert.deepEqual(res.body, { status: 'unavailable' });
});

test('cron secret is mandatory; no query/header fallback or missing-secret open access', async () => {
  assert.equal(validEventRecoveryCronSecret({ headers: {} }, ''), false);
  assert.equal(validEventRecoveryCronSecret({ headers: { authorization: 'Bearer secret' } }, 'secret'), true);
  assert.equal(validEventRecoveryCronSecret({ headers: { authorization: 'Bearer wrong' } }, 'secret'), false);
  const res = response();
  await eventRecoveryCronHandler({ secret: '', reconcile: async () => assert.fail('unauthorized') })(
    { method: 'GET', headers: {}, query: { secret: 'secret' } }, res);
  assert.equal(res.code, 401);
});