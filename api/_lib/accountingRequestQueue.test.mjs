import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueAccountingRequest, processAccountingRequest, reconcileAccountingRequests, validAccountingRequestSnapshot,
  accountingRetryAfterSeconds } from './accountingRequestQueue.js';

const snapshot = { version: 1, invoice: { amount: 100 }, payment: { amount: 100 }, linkage: { sourceId: 's1' } };
function fixture(overrides = {}) {
  let row = { id: 'request', tenant_id: 'tenant', provider: 'xero', connection_id: 'connection',
    company_id: 'company', source_type: 'booking', source_id: 'source', snapshot: structuredClone(snapshot),
    invoice_status: 'pending', payment_status: 'pending', link_status: 'pending',
    lease_token: 'lease', attempts: 1, ...overrides };
  const calls = [];
  const db = { async rpc(name, args) {
    calls.push([name, args]);
    if (name.endsWith('_guard')) return { data: true };
    if (name.endsWith('_prepare')) {
      row.preparation_status = 'done';
      row.resolved_snapshot = structuredClone(args.p_snapshot);
      if (row.operation === 'payment') row.invoice_result = structuredClone(args.p_snapshot.existingInvoice);
    }
    if (name.endsWith('_checkpoint')) {
      row[`${args.p_stage}_status`] = args.p_status;
      if (args.p_status === 'done') row[`${args.p_stage}_result`] = args.p_result;
    }
    if (name.endsWith('_finish')) row.state = args.p_state;
    return { data: structuredClone(row) };
  } };
  const writes = [];
  const adapter = {
    assertBinding: async () => {},
    createInvoice: async r => { writes.push('invoice'); assert.equal(r.snapshot.invoice.amount, 100); return { id: 'inv' }; },
    createPayment: async r => { writes.push('payment'); assert.equal(r.invoice_result.id, 'inv'); return { id: 'pay' }; },
    linkSource: async r => { writes.push('link'); assert.equal(r.payment_result.id, 'pay'); return { linked: true }; },
  };
  return { db, calls, writes, adapter, run: () => processAccountingRequest({ db, requestId: 'request', adapters: async () => adapter }) };
}
test('independent stages persist write intent before calls and evidence before subsequent stages', async () => {
  const f = fixture();
  assert.equal((await f.run()).state, 'complete');
  assert.deepEqual(f.writes, ['invoice', 'payment', 'link']);
  assert.deepEqual(f.calls.filter(([name]) => name.endsWith('checkpoint')).map(([, a]) => [a.p_stage, a.p_status]),
    [['invoice', 'writing'], ['invoice', 'done'], ['payment', 'writing'], ['payment', 'done'], ['link', 'writing'], ['link', 'done']]);
});
test('unknown POST including 429 is never blindly repeated; cooldown forwarded', async () => {
  const f = fixture();
  f.adapter.createInvoice = async () => { throw Object.assign(new Error('private provider response'), { status: 429, retryAfter: '120' }); };
  assert.equal((await f.run()).state, 'unknown');
  const finish = f.calls.at(-1)[1];
  assert.equal(finish.p_cooldown_seconds, 120);
  assert.equal(finish.p_error.includes('private'), false);
  await f.run();
  assert.deepEqual(f.writes, []);
});
test('unknown discovery uniquely proves invoice then resumes payment, not invoice creation', async () => {
  const f = fixture({ invoice_status: 'unknown' });
  f.adapter.discoverInvoice = async () => ({ outcome: 'found', result: { id: 'inv' } });
  assert.equal((await f.run()).state, 'complete');
  assert.deepEqual(f.writes, ['payment', 'link']);
});
test('link failure retries link only; completed financial stages remain durable', async () => {
  const f = fixture({ invoice_status: 'done', invoice_result: { id: 'inv' },
    payment_status: 'done', payment_result: { id: 'pay' } });
  f.adapter.linkSource = async () => { throw new Error('DB down'); };
  assert.equal((await f.run()).state, 'retry');
  assert.deepEqual(f.writes, []);
  assert.equal(f.calls.find(([, a]) => a?.p_stage === 'link' && a?.p_status === 'pending') != null, true);
});
test('binding mismatch quarantines before write; positive no-write errors can retry', async () => {
  const f = fixture();
  f.adapter.assertBinding = async () => { throw new Error('switched'); };
  assert.equal((await f.run()).state, 'review');
  assert.deepEqual(f.writes, []);
  f.adapter.assertBinding = async () => {};
  f.adapter.createInvoice = async () => { throw Object.assign(new Error(), { definitelyNotWritten: true }); };
  assert.equal((await f.run()).state, 'retry');
});
test('post-success checkpoint failure propagates, never converted to safe provider retry', async () => {
  const f = fixture();
  const original = f.db.rpc;
  f.db.rpc = async (name, args) => args?.p_status === 'done' ? { error: { code: 'down' } } : original(name, args);
  await assert.rejects(f.run(), /PERSISTENCE_CHECKPOINT/);
  assert.deepEqual(f.writes, ['invoice']);
  assert.equal(f.calls.some(([name]) => name.endsWith('finish')), false);
});
test('core beforeRequest guard rejects mutated identity and limits request budget', async () => {
  const f = fixture();
  let control;
  await processAccountingRequest({ db: f.db, requestId: 'request', adapters: async (row, controls) => {
    control = controls;
    await assert.rejects(controls.beforeRequest({ ...row, company_id: 'other' }), /BINDING_CHANGED/);
    await assert.rejects(controls.beforeRequest({ ...row, snapshot: { ...row.snapshot, invoice: { amount: 1 } } }), /AUTHORITY_CHANGED/);
    for (let i = 0; i < 38; i++) await controls.beforeRequest(row, { kind: 'binding', method: 'GET' });
    await assert.rejects(controls.beforeRequest(row), /BUDGET_EXHAUSTED/);
    return f.adapter;
  } });
  assert.ok(control.deadlineAt);
});
test('enqueue validates authority and migration missing fails closed', async () => {
  assert.equal(validAccountingRequestSnapshot(snapshot), true);
  assert.equal(validAccountingRequestSnapshot({ ...snapshot, payment: undefined }), false);
  assert.equal(validAccountingRequestSnapshot({ ...snapshot, linkage: {} }), false);
  await assert.rejects(enqueueAccountingRequest({
    db: { rpc: async () => ({ error: { code: 'PGRST202' } }) },
    tenantId: '00000000-0000-4000-8000-000000000001', provider: 'quickbooks',
    connectionId: 'c', companyId: 'qbo', sourceType: 'membership', sourceId: 's', snapshot,
  }), /PERSISTENCE_ENQUEUE/);
});
test('Retry-After supports HTTP date and bounded seconds', () => {
  assert.equal(accountingRetryAfterSeconds('120'), 120);
  assert.equal(accountingRetryAfterSeconds('Wed, 01 Jan 2025 00:02:00 GMT', Date.parse('2025-01-01T00:00:00Z')), 120);
  assert.equal(accountingRetryAfterSeconds('bad'), 60);
  assert.equal(accountingRetryAfterSeconds('99999999'), 99999999);
  assert.equal(accountingRetryAfterSeconds('999999999999999999999'), -1);
  assert.equal(accountingRetryAfterSeconds('9'.repeat(500)), -1);
});
test('long provider embargo is preserved independently from bounded retry scheduling', async () => {
  for (const [header, cooldown] of [['99999999', 99999999], ['999999999999999999999', -1]]) {
    const f = fixture();
    f.adapter.createInvoice = async () => { throw Object.assign(new Error(), { status: 429, retryAfter: header }); };
    await f.run();
    const finish = f.calls.at(-1)[1];
    assert.equal(finish.p_cooldown_seconds, cooldown);
    assert.ok(finish.p_retry_seconds <= 604800);
  }
});
test('batch rows share one absolute deadline and guard returns only remaining timeout', async () => {
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  try {
    const f = fixture();
    const deadlines = [];
    await reconcileAccountingRequests({ db: f.db, limit: 2, adapters: async (row, controls) => {
      deadlines.push(controls.deadlineAt);
      now += 10000;
      const budget = await controls.beforeRequest(row, { kind: 'binding', method: 'GET' });
      assert.equal(budget.deadlineAt, 140000);
      assert.equal(budget.timeoutMs, Math.min(30000, 140000 - now));
      return f.adapter;
    } });
    assert.deepEqual(deadlines, [140000, 140000]);
  } finally { Date.now = originalNow; }
});
test('expired standalone budget cannot start another financial stage', async () => {
  const f = fixture();
  const row = await processAccountingRequest({ db: f.db, requestId: 'request', deadlineAt: Date.now() - 1,
    adapters: async () => f.adapter });
  assert.equal(row.state, 'retry');
  assert.deepEqual(f.writes, []);
});
test('rate limits during binding/auth preserve company cooldown and existing unknown state', async () => {
  const f = fixture({ invoice_status: 'unknown' });
  f.adapter.assertBinding = async () => { throw Object.assign(new Error(), { status: 429, retryAfter: '90' }); };
  assert.equal((await f.run()).state, 'unknown');
  assert.equal(f.calls.at(-1)[1].p_cooldown_seconds, 90);
  assert.deepEqual(f.writes, []);
});

test('both providers preserve original preparation evidence and skip prelinked invoice on retry', async () => {
  for (const provider of ['xero', 'quickbooks']) {
    const original = { ...snapshot, preparation: true, existingInvoice: { id: 'inv' } };
    const resolved = { ...original, preparation: false, payment: { envelope: { payload: { Total: 100 } } },
      existingInvoice: { id: 'inv', verified: true } };
    const f = fixture({ provider, operation: 'payment', snapshot: original, preparation_status: 'pending',
      invoice_status: 'done', invoice_result: { id: 'inv' } });
    delete f.adapter.createInvoice;
    let preparations = 0;
    f.adapter.prepare = async row => {
      assert.deepEqual(row.snapshot, original);
      if (++preparations === 1) throw Object.assign(new Error('tax/contact limited'), { status: 429, retryAfter: 95 });
      return resolved;
    };
    assert.equal((await f.run()).state, 'retry');
    assert.equal(f.calls.at(-1)[1].p_cooldown_seconds, 95);
    assert.deepEqual(f.writes, []);
    const payment = f.adapter.createPayment;
    let payments = 0;
    f.adapter.createPayment = async row => {
      assert.deepEqual(row.snapshot, original);
      assert.deepEqual(row.resolved_snapshot, resolved);
      assert.equal(row.invoice_result.verified, true);
      if (++payments === 1) throw Object.assign(new Error('payment limited'), {
        status: 429, retryAfter: 120, definitelyNotWritten: true,
      });
      return payment(row);
    };
    assert.equal((await f.run()).state, 'retry');
    assert.equal((await f.run()).state, 'complete');
    assert.equal(preparations, 2, 'prepared snapshot is not rebuilt on payment retry');
    assert.deepEqual(f.writes, ['payment', 'link']);
    assert.equal(f.calls.some(([, args]) => args?.p_stage === 'invoice'), false);
  }
});

test('prepared authority is guarded independently of immutable original evidence', async () => {
  const resolved = { ...snapshot, invoice: { amount: 100, resolved: true } };
  const f = fixture({ resolved_snapshot: resolved, preparation_status: 'done' });
  await processAccountingRequest({ db: f.db, requestId: 'request', adapters: async (row, controls) => {
    await assert.rejects(controls.beforeRequest({ ...row, resolved_snapshot: snapshot }), /AUTHORITY_CHANGED/);
    await assert.rejects(controls.beforeRequest({ ...row, snapshot: resolved }), /AUTHORITY_CHANGED/);
    return f.adapter;
  } });
});

test('preparation persistence failure never starts a financial write', async () => {
  const f = fixture({ snapshot: { ...snapshot, preparation: true }, preparation_status: 'pending' });
  f.adapter.prepare = async () => snapshot;
  const rpc = f.db.rpc;
  f.db.rpc = async (name, args) => name.endsWith('_prepare') ? { error: { code: 'down' } } : rpc(name, args);
  await assert.rejects(f.run(), /PERSISTENCE_PREPARE/);
  assert.deepEqual(f.writes, []);
});

test('Xero and QBO retry exact resolved financial stages after direct throttle rejection only', async () => {
  for (const provider of ['xero', 'quickbooks']) {
    for (const stage of ['invoice', 'payment']) {
      const f = fixture({ provider, preparation_status: 'pending', snapshot: { ...snapshot, preparation: true } });
      const resolved = { ...snapshot, invoice: { amount: 100, operationKey: 'original-invoice-key' },
        payment: { amount: 100, operationKey: 'original-payment-key' } };
      let preparations = 0, throttles = 0;
      f.adapter.prepare = async () => { preparations++; return structuredClone(resolved); };
      const method = stage === 'invoice' ? 'createInvoice' : 'createPayment';
      const originalMethod = f.adapter[method];
      f.adapter[method] = async row => {
        assert.deepEqual(row.resolved_snapshot, resolved);
        if (++throttles === 1) throw Object.assign(new Error(), {
          status: 429, retryAfter: 60, definitelyNotWritten: true,
        });
        return originalMethod(row);
      };
      assert.equal((await f.run()).state, 'retry');
      assert.equal((await f.run()).state, 'complete');
      assert.equal(preparations, 1);
      assert.deepEqual(f.writes, ['invoice', 'payment', 'link']);
    }
  }
});