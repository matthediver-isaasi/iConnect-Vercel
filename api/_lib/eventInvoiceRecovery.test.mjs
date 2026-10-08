import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueEventInvoiceRecovery, processEventInvoiceRecovery, providerCooldown,
  recoveryIdentity, validRecoverySnapshot } from './eventInvoiceRecovery.js';
import { createEventInvoiceRecoveryXero, recoveryInvoiceMarker } from './eventInvoiceRecoveryXero.js';
import { eventRecoveryCronHandler, validEventRecoveryCronSecret } from '../cron/reconcile-event-invoices.js';
import { eventInvoiceRecoveryHealthHandler } from '../health/event-invoice-recovery.js';

const snapshot = () => ({
  version: 1, provider: { connectionId: 'connection', xeroTenantId: 'org' },
  invoice: { Type: 'ACCREC', Status: 'AUTHORISED', CurrencyCode: 'GBP', LineAmountTypes: 'Exclusive',
    Contact: { ContactID: 'contact' }, Date: '2026-01-01', DueDate: '2026-01-31',
    LineItems: [{ Description: 'Event ticket', Quantity: 1, UnitAmount: 20, AccountCode: '200', TaxType: 'NONE', TaxAmount: 0 }] },
  contact: { email: 'buyer@example.test' }, currency: 'GBP', amount: 20, paymentMethod: 'stripe',
  settlement: { paymentIntentId: 'pi_123', status: 'succeeded', livemode: true, amount: 20, currency: 'GBP',
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

test('old or test Stripe evidence cannot reach the accounting provider without live-mode proof', async () => {
  for (const livemode of [undefined, false]) {
    const s = snapshot();
    s.settlement.livemode = livemode;
    assert.equal(validRecoverySnapshot(s), false);
    const db = mockDb({ id: 'mode-operation', tenant_id: 't', source: 'booking',
      booking_group_reference: 'g', lease_token: 'lease', snapshot: s });
    const result = await processEventInvoiceRecovery({ db,
      providerFactory: async () => assert.fail('unverified mode must not invoke Xero') });
    assert.equal(result.status, 'needs_review');
    assert.equal(db.calls.at(-1)[1].p_reason, 'settlement_live_mode_unverified');
  }
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
         : url.includes('Payments') ? { Payments: [{ PaymentID: 'p' }] }
           : { Invoices: init.method === 'POST' ? [invoice()] : [] } };
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
  const payload = JSON.parse(calls[2].init.body).Invoices[0];
  assert.equal(Object.hasOwn(payload, 'InvoiceNumber'), false);
  assert.equal(payload.LineItems[0].Description, 'Event ticket' + recoveryInvoiceMarker(identity));
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

function numberedXeroFixture({ method = 'invoice', failure = null, throttle = null } = {}) {
  const job = row();
  job.snapshot.invoice.Reference = 'CUSTOMER-PO-123';
  if (method === 'invoice') {
    job.snapshot.paymentMethod = 'invoice';
    job.snapshot.settlement = null;
  }
  const identity = recoveryIdentity(job.tenant_id, job.source, job.booking_group_reference);
  const db = Object.assign(mockDb(job), tokenDb());
  const rpc = db.rpc;
  let failed = false;
  db.rpc = async (name, args) => {
    const result = await rpc(name, args);
    if (name.endsWith('_start_write')) job[`${args.p_kind}_write_started_at`] = '2026-01-01T00:00:00Z';
    if (name.endsWith('_record_invoice')) {
      if (failure === 'record' && !failed) { failed = true; return { error: new Error('local journal lost') }; }
      job.invoice_id = args.p_invoice_id;
    }
    if (name.endsWith('_finish') && args.p_status === 'complete') {
      if (failure === 'link' && !failed) { failed = true; return { data: false }; }
      job.payment_id = args.p_payment_id;
    }
    return result;
  };
  const calls = [];
  const remote = { invoice: null, payment: null };
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ url: decodeURIComponent(url), init });
    if (!failed && ((throttle === 'invoice' && init.method === 'POST')
      || (throttle === 'payment' && init.method === 'PUT')
      || (throttle === 'bank' && parsed.pathname.endsWith('/Accounts')))) {
      failed = true;
      return { ok: false, status: 429, headers: new Headers({ 'retry-after': '600' }) };
    }
    let data;
    if (init.method === 'POST') {
      const payload = JSON.parse(init.body).Invoices[0];
      assert.equal(Object.hasOwn(payload, 'InvoiceNumber'), false);
      assert.equal(payload.Reference, 'CUSTOMER-PO-123');
      remote.invoice = { ...payload, InvoiceID: 'sequential-id', InvoiceNumber: 'INV-0099',
        Total: 20, AmountPaid: 0, AmountDue: 20,
        LineItems: payload.LineItems.map(line => ({ ...line, LineAmount: 20 })) };
      if (failure === 'response' && !failed) { failed = true; throw new Error('response lost after success'); }
      data = { Invoices: [remote.invoice] };
    } else if (init.method === 'PUT') {
      remote.payment = { ...JSON.parse(init.body).Payments[0], PaymentID: 'settlement-id', Status: 'AUTHORISED' };
      remote.invoice = { ...remote.invoice, Status: 'PAID', AmountPaid: 20, AmountDue: 0 };
      data = { Payments: [remote.payment] };
    } else if (parsed.pathname.endsWith('/Accounts')) {
      data = { Accounts: [{ Code: '090', Status: 'ACTIVE', Type: 'BANK', CurrencyCode: 'GBP' }] };
    } else if (parsed.pathname.includes('/Payments')) {
      data = { Payments: remote.payment ? [remote.payment] : [] };
    } else {
      data = { Invoices: parsed.searchParams.get('page') === '2' ? []
        : remote.invoice ? [remote.invoice] : [] };
    }
    return { ok: true, status: 200, json: async () => data };
  };
  const run = () => processEventInvoiceRecovery({ db,
    providerFactory: options => createEventInvoiceRecoveryXero({ ...options, fetchImpl }) });
  return { job, identity, db, calls, remote, run };
}

for (const throttle of ['invoice', 'payment', 'bank']) {
  test(`Xero ${throttle} throttle retains invoice authority and original settlement date on retry`, async () => {
    const f = numberedXeroFixture({ method: 'stripe', throttle });
    const original = structuredClone(f.job.snapshot);
    assert.equal((await f.run()).status, 'retry');
    const retained = f.db.calls.at(-1)[1];
    assert.equal(retained.p_reason, 'provider_rate_limited');
    assert.ok(Date.parse(retained.p_cooldown) >= Date.now() + 899000);
    assert.equal(retained.p_rejected_write, throttle === 'invoice' ? 'invoice' : 'payment');
    // Model the existing SQL finish transition, which releases only the
    // definitely rejected stage, retaining a successfully recorded invoice.
    f.job[`${retained.p_rejected_write}_write_started_at`] = null;
    if (throttle !== 'invoice') assert.equal(f.job.invoice_id, 'sequential-id');
    assert.equal((await f.run()).status, 'complete');
    assert.deepEqual(f.job.snapshot, original);
    assert.equal(f.remote.payment.Date, original.settlement.paidAt.slice(0, 10));
    assert.equal(f.remote.payment.Amount, original.settlement.amount);
    assert.deepEqual(f.remote.payment.Account, { Code: original.settlement.accountCode });
    assert.equal(f.calls.filter(call => call.init.method === 'POST').length, throttle === 'invoice' ? 2 : 1);
    assert.equal(f.calls.filter(call => call.init.method === 'PUT').length, throttle === 'payment' ? 2 : 1);
    for (const method of ['POST', 'PUT']) {
      assert.equal(new Set(f.calls.filter(call => call.init.method === method)
        .map(call => call.init.headers['Idempotency-Key'])).size, 1);
    }
  });
}

test('Stripe settlement survives failed booking linkage without another invoice or payment', async () => {
  const f = numberedXeroFixture({ method: 'stripe', failure: 'link' });
  const original = structuredClone(f.job.snapshot);
  assert.equal((await f.run()).status, 'retry');
  assert.equal(f.remote.invoice.Status, 'PAID');
  assert.equal((await f.run()).status, 'complete');
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
  assert.equal(f.calls.filter(call => call.init.method === 'PUT').length, 1);
  assert.deepEqual(f.job.snapshot, original);
  assert.equal(f.db.calls.at(-1)[1].p_payment_id, 'settlement-id');
});

test('normal Xero auto-numbered creation journals INV number and links on retry without rewriting PO', async () => {
  const f = numberedXeroFixture({ failure: 'link' });
  assert.equal((await f.run()).status, 'retry');
  assert.equal(f.job.invoice_id, 'sequential-id');
  assert.equal((await f.run()).status, 'complete');
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
  assert.equal(f.db.calls.at(-1)[1].p_invoice_number, 'INV-0099');
  assert.equal(f.remote.invoice.Reference, 'CUSTOMER-PO-123');
  assert.ok(f.calls.at(-1).url.endsWith('/Invoices/sequential-id'));
});

test('exact description marker recovers auto-numbered remote success after response or local record loss', async () => {
  for (const failure of ['response', 'record']) {
    const f = numberedXeroFixture({ failure });
    assert.equal((await f.run()).status, 'retry');
    assert.equal(f.job.invoice_id, undefined);
    // Customer-visible PO and number can change; neither is our operation identity.
    f.remote.invoice.Reference = 'UPDATED-PO';
    f.remote.invoice.InvoiceNumber = 'INV-0100';
    assert.equal((await f.run()).status, 'complete');
    assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
    assert.equal(f.db.calls.at(-1)[1].p_invoice_id, 'sequential-id');
    assert.equal(f.db.calls.at(-1)[1].p_invoice_number, 'INV-0100');
    assert.equal(f.remote.invoice.Reference, 'UPDATED-PO');
    assert.equal(f.remote.invoice.LineItems[0].Description, 'Event ticket' + recoveryInvoiceMarker(f.identity));
  }
});

test('missing or merely similar operation marker after an ambiguous write stops without duplicates', async () => {
  for (const description of ['Event ticket', 'Event ticket\n[Event invoice recovery: event-unrelated]',
    'Event ticket\n[Event invoice recovery: event-prefix] extra']) {
    const f = numberedXeroFixture({ failure: 'response' });
    assert.equal((await f.run()).status, 'retry');
    f.remote.invoice.LineItems[0].Description = description;
    assert.equal((await f.run()).status, 'needs_review');
    assert.equal(f.db.calls.at(-1)[1].p_reason, 'invoice_creation_ambiguous');
    assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
  }
});

test('pre-marker event-hash numbered operation is discovered without creating another invoice', async () => {
  const f = numberedXeroFixture();
  f.remote.invoice = { ...f.job.snapshot.invoice, InvoiceID: 'legacy-event-id', InvoiceNumber: f.identity,
    Total: 20, AmountDue: 20, AmountPaid: 0,
    LineItems: [{ ...f.job.snapshot.invoice.LineItems[0], LineAmount: 20 }] };
  assert.equal((await f.run()).status, 'complete');
  assert.equal(f.calls.every(call => call.init.method === 'GET'), true);
  assert.equal(f.db.calls.at(-1)[1].p_invoice_id, 'legacy-event-id');
});

test('auto-numbered paid invoice renamed in place retains its exact settlement and uses known IDs first', async () => {
  const f = numberedXeroFixture({ method: 'stripe' });
  assert.equal((await f.run()).status, 'complete');
  assert.equal(f.remote.invoice.Status, 'PAID');
  const originalPayment = structuredClone(f.remote.payment);
  f.remote.invoice.InvoiceNumber = 'INV-RENAMED';
  f.remote.invoice.Reference = 'NEW-CUSTOMER-PO';
  const prior = f.calls.length;
  assert.equal((await f.run()).status, 'complete');
  assert.deepEqual(f.calls.slice(prior).map(call => new URL(call.url).pathname.split('/').at(-1)),
    ['sequential-id', 'settlement-id']);
  assert.deepEqual(f.remote.payment, originalPayment);
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
  assert.equal(f.calls.filter(call => call.init.method === 'PUT').length, 1);
  assert.equal(f.db.calls.at(-1)[1].p_invoice_number, 'INV-RENAMED');
  f.job.invoice_id = null;
  const paymentOnlyPrior = f.calls.length;
  assert.equal((await f.run()).status, 'complete');
  assert.deepEqual(f.calls.slice(paymentOnlyPrior).map(call => new URL(call.url).pathname.split('/').at(-1)),
    ['settlement-id', 'sequential-id']);
  assert.deepEqual(f.remote.payment, originalPayment);
});

test('paid pre-marker invoice renamed from event-hash keeps invoice/payment IDs and settlement unchanged', async () => {
  const f = numberedXeroFixture({ method: 'stripe' });
  f.job.invoice_id = 'paid-legacy-id';
  f.job.payment_id = 'paid-legacy-settlement';
  f.remote.invoice = { ...f.job.snapshot.invoice, InvoiceID: f.job.invoice_id, InvoiceNumber: 'INV-0123',
    Status: 'PAID', Total: 20, AmountPaid: 20, AmountDue: 0,
    LineItems: [{ ...f.job.snapshot.invoice.LineItems[0], LineAmount: 20 }] };
  f.remote.payment = { PaymentID: f.job.payment_id, Invoice: { InvoiceID: f.job.invoice_id },
    Reference: `${f.identity}:pi_123`, Amount: 20, Date: '2026-01-01',
    Account: { Code: '090' }, Status: 'AUTHORISED' };
  const before = structuredClone(f.remote);
  assert.equal((await f.run()).status, 'complete');
  assert.deepEqual(f.remote, before);
  assert.deepEqual(f.calls.map(call => new URL(call.url).pathname.split('/').at(-1)),
    ['paid-legacy-id', 'paid-legacy-settlement']);
  assert.equal(f.calls.every(call => call.init.method === 'GET'), true);
  assert.equal(f.db.calls.at(-1)[1].p_invoice_number, 'INV-0123');
});

test('multiple invoices with our exact operation marker fail closed before writes', async () => {
  const f = numberedXeroFixture({ failure: 'response' });
  assert.equal((await f.run()).status, 'retry');
  const originalFactory = await createEventInvoiceRecoveryXero({
    db: tokenDb(), row: f.job, identity: f.identity, guard: async () => {}, deadlineAt: Date.now() + 10000,
    fetchImpl: async url => ({ ok: true, json: async () => ({
      Invoices: new URL(url).searchParams.get('page') === '2' ? [] : [
        f.remote.invoice, { ...f.remote.invoice, InvoiceID: 'duplicate-id', InvoiceNumber: 'INV-OTHER' },
      ],
    }) }),
  });
  assert.equal((await processEventInvoiceRecovery({ db: f.db, providerFactory: async () => originalFactory })).status,
    'needs_review');
  assert.equal(f.db.calls.at(-1)[1].p_reason, 'invoice_identity_ambiguous');
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
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