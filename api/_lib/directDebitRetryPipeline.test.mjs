import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runRetries, selectDueRetries, isRetryDue } from './directDebitRetryPipeline.js';
import { createLiveRetryEffects } from './gocardlessAutoRetry.js';

const now = new Date('2026-03-01T12:00:00Z');
const plan = {
  id: 'plan', tenant_id: 'tenant', status: 'payment_grace_period',
  auto_retry_next_at: '2026-03-01T11:00:00Z', auto_retry_payment_id: 'PM1',
  grace_expires_at: '2026-03-20T00:00:00Z', gocardless_mandate_id: 'MD1',
  amount_minor: 1200, currency: 'GBP', auto_retry_attempts: 0,
};
function fixture(overrides = {}, { missingMirror = false } = {}) {
  const current = { ...plan, ...overrides }, calls = [];
  const tables = {
    membership_payment_plans: [current],
    tenant_integrations: [{ tenant_id: 'tenant', integration_type: 'gocardless', is_enabled: true,
      credentials: { access_token: 'fixture-only', auto_retry_enabled: true, auto_retry_max_attempts: 3 } }],
    gocardless_payments: missingMirror ? [] : [{ tenant_id: 'tenant', plan_id: 'plan',
      gocardless_payment_id: 'PM1', amount_minor: 1200, currency: 'GBP' }],
    gocardless_payment_retry_attempts: [],
  };
  const db = { from(table) {
    const filters = [];
    return {
      select() { return this; },
      eq(k, v) { filters.push(r => r[k] === v); return this; },
      order() { return this; }, limit() { return this; },
      async maybeSingle() {
        calls.push(table);
        return { data: tables[table]?.find(r => filters.every(f => f(r))) || null };
      },
      update() { assert.fail('read-only pipeline attempted update'); },
      insert() { assert.fail('read-only pipeline attempted insert'); },
    };
  }, rpc() { assert.fail('read-only pipeline attempted RPC'); } };
  return { db, current, calls };
}
const stop = new Error('recording boundary');
function recording(operations) {
  return { async perform(op) { operations.push(op); throw stop; } };
}

test('production and recording use identical operation construction until the actual claim result', async () => {
  const a = fixture(), b = fixture(), recorded = [], live = [], reads = [];
  const getGc = async () => ({ async getMandate(id) { reads.push(id); return { status: 'active' }; },
    retryPayment() { assert.fail('provider mutation cannot precede claim'); },
    getPayment() { assert.fail('payment validation is claim-dependent'); } });
  await assert.rejects(runRetries({ db: a.db, plan: a.current, now, getGc,
    effects: recording(recorded) }), err => err === stop);
  const outcome = await runRetries({ db: b.db, plan: b.current, now, getGc,
    effects: { async perform(op) { live.push(op); return { ok: false, reason: 'retry_in_progress' }; } } });
  assert.deepEqual(recorded, live);
  assert.equal(outcome.reason, 'retry_in_progress');
  assert.equal(recorded[0].type, 'retry.claim');
  assert.equal(recorded[0].amountMinor, 1200);
  assert.equal(recorded[0].conditional, true);
  assert.deepEqual(a.calls, b.calls);
  assert.deepEqual(reads, ['MD1', 'MD1']);
});

test('due selection and per-plan eligibility share status and deadline constraints', () => {
  const calls = [], q = {};
  for (const name of ['eq', 'not', 'lte']) q[name] = (...args) => { calls.push([name, ...args]); return q; };
  assert.equal(selectDueRetries(q, now), q);
  assert.deepEqual(calls, [['eq', 'status', 'payment_grace_period'], ['not', 'auto_retry_next_at', 'is', null],
    ['lte', 'auto_retry_next_at', now.toISOString()]]);
  assert.equal(isRetryDue(plan, now), true);
  for (const p of [{ ...plan, status: 'active' }, { ...plan, auto_retry_next_at: null },
    { ...plan, auto_retry_next_at: '2099-01-01' }]) assert.equal(isRetryDue(p, now), false);
});

test('missing mirror, missing linkage, expired grace and stale claim stop at their exact first write', async () => {
  for (const [overrides, options, expected] of [
    [{}, { missingMirror: true }, 'retry.create_payment_mirror'],
    [{ auto_retry_payment_id: null }, {}, 'retry.close_schedule'],
    [{ grace_expires_at: '2026-02-28' }, {}, 'retry.close_schedule'],
    [{ auto_retry_claimed_at: '2026-02-01', auto_retry_claim_token: 'stale' }, {}, 'retry.release_stale_claim'],
  ]) {
    const { db, current } = fixture(overrides, options), operations = [];
    await assert.rejects(runRetries({ db, plan: current, now, getGc: async () => ({
      getMandate: async () => ({ status: 'active' }),
    }), effects: recording(operations) }), err => err === stop);
    assert.equal(operations.length, 1);
    assert.equal(operations[0].type, expected);
  }
});

test('in-flight and cancellation claims are checked without reservations; provider failures stay errors', async () => {
  for (const [token, reason] of [['cancel:token', 'cancellation_in_progress'], ['token', 'retry_in_progress']]) {
    const { db, current } = fixture({ auto_retry_claimed_at: now.toISOString(), auto_retry_claim_token: token });
    const result = await runRetries({ db, plan: current, now,
      getGc: async () => ({ getMandate: async () => ({ status: 'active' }) }),
      effects: { perform() { assert.fail('no claim permitted'); } } });
    assert.equal(result.reason, reason);
  }
  const { db, current } = fixture();
  await assert.rejects(runRetries({ db, plan: current, now,
    getGc: async () => ({ getMandate: async () => { throw Error('provider unavailable'); } }),
    effects: { perform() { assert.fail('no write on read error'); } } }), /provider unavailable/);
});

test('the concrete live claim adapter preserves lost-claim behavior and never calls provider', async () => {
  const { db, current } = fixture(), operations = [];
  await assert.rejects(runRetries({ db, plan: current, now, effects: recording(operations),
    getGc: async () => ({ getMandate: async () => ({ status: 'active' }) }) }), err => err === stop);
  const filters = [], updates = [];
  const liveDb = { from(table) {
    assert.equal(table, 'membership_payment_plans');
    return { update(payload) { updates.push(payload); return this; },
      eq(...args) { filters.push(args); return this; },
      is(...args) { filters.push(args); return this; },
      async select() { return { data: [] }; } };
  } };
  const result = await createLiveRetryEffects({ db: liveDb, gc: {} }).perform(operations[0]);
  assert.equal(result.reason, 'retry_in_progress');
  assert.deepEqual(updates, [operations[0].payload.update]);
  assert.ok(filters.some(([k, v]) => k === 'auto_retry_claimed_at' && v === null));
});

test('shared retry module has no production-client, network or mutation escape', async () => {
  const source = await readFile(new URL('./directDebitRetryPipeline.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.deepEqual(imports, ['node:crypto']);
  assert.doesNotMatch(source.replace(/^const key =.*$/m, ''),
    /\bfetch\s*\(|\.rpc\s*\(|\.update\s*\(|\.insert\s*\(|\.retryPayment\s*\(/);
});