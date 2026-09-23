import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  reconcileAgreement, reconcileMissingSubscription, reconcileSubscription,
  reconcilePayment, reconcileAccounting, reconciliationSelection,
} from './directDebitReconciliationPipeline.js';
import { recordingEffects, isDryRunEffectBoundary } from './directDebitDryRunRuntime.js';

const now = new Date('2026-10-01T00:00:00Z');
const plan = { id: 'plan', tenant_id: 'tenant', billing_agreement_id: 'agreement',
  gocardless_mandate_id: 'MD1', gocardless_subscription_id: 'SB1', status: 'active' };
const agreement = { id: 'agreement', tenant_id: 'tenant', updated_at: '2026-01-01',
  gocardless_billing_request_id: 'BR1', metadata: { dd: { kind: 'monthly_direct_debit', invoicing_mode: 'per_instalment' } } };
const payment = { id: 'payment', plan_id: 'plan', tenant_id: 'tenant', gocardless_payment_id: 'PM1',
  status: 'submitted', amount_minor: 1234, currency: 'GBP', charge_date: '2026-09-01' };
function database(tables = {}) {
  return { from(table) {
    const filters = [];
    const q = { select() { return q; }, eq(k, v) { filters.push(r => r[k] === v); return q; },
      maybeSingle() { return Promise.resolve({ data: (tables[table] || []).find(r => filters.every(f => f(r))) || null }); },
      then(resolve) { resolve({ data: (tables[table] || []).filter(r => filters.every(f => f(r))) }); },
      update() { assert.fail('Shared pipeline cannot mutate database'); },
    };
    return q;
  } };
}
const gc = {
  getBillingRequest: async () => ({ status: 'fulfilled', links: { mandate_request_mandate: 'MD1' } }),
  getMandate: async () => ({ status: 'active' }),
  getSubscription: async () => ({ status: 'cancelled' }),
  getPayment: async () => ({ status: 'confirmed' }),
};

test('all five actual row entries construct identical first operations for live and recording capabilities', async () => {
  for (const [run, row] of [
    [reconcileAgreement, agreement], [reconcileMissingSubscription, plan],
    [reconcileSubscription, plan], [reconcilePayment, payment], [reconcileAccounting, payment],
  ]) {
    const db = database({ membership_payment_plans: [plan], membership_billing_agreements: [agreement] });
    const recorded = [], live = [];
    const base = { db, now, getGc: async () => gc };
    await assert.rejects(run({ ...base, effects: recordingEffects(recorded) }, row), isDryRunEffectBoundary);
    await run({ ...base, effects: { async perform(operation) {
      live.push(operation); return { handled: true, applied: true, status: 'posted' };
    } } }, row);
    assert.deepEqual(recorded[0], live[0]);
    assert.ok(recorded[0].payload);
  }
});

test('provider errors never become permission for mutations', async () => {
  let effects = 0;
  await assert.rejects(reconcilePayment({
    now, db: database(), getGc: async () => ({ getPayment: async () => { throw new Error('unavailable'); } }),
    effects: { perform() { effects++; } },
  }, payment), /unavailable/);
  assert.equal(effects, 0);
});

test('failed lifecycle response cannot proceed to freshness write', async () => {
  const ops = [];
  await assert.rejects(reconcilePayment({ now, db: database(), getGc: async () => gc,
    effects: { async perform(op) { ops.push(op); return { handled: false, retryable: true }; } },
  }, payment), /not handled/);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, 'reconciliation.replay');
});

test('dynamic plans and annual accounting have explicit no-action reasons', async () => {
  const stages = [];
  const ctx = { now, db: database(), trace: s => stages.push(s),
    getGc: () => assert.fail('No provider read'), effects: { perform: () => assert.fail('No effect') } };
  await reconcileMissingSubscription(ctx, { ...plan, metadata: { collection_mode: 'dynamic' } });
  await reconcileAccounting(ctx, payment);
  assert.equal(stages.length, 2);
  assert.ok(stages.every(s => s.status === 'skipped'));
});

test('selection predicates are shared SQL builders, with exact distinct stale windows', () => {
  for (const [stage, expected] of [['stale-agreements', 3], ['missing-subscription', 2], ['subscription-drift', 1],
    ['pending-payments', 10], ['confirmed-payments', 15 / 1440]]) {
    const calls = [];
    const q = new Proxy({}, { get: (_t, key) => (...args) => { calls.push([key, ...args]); return q; } });
    reconciliationSelection({ from: () => q }, stage, now);
    assert.ok(calls.some(([key, field, value]) => key === 'lt' && field === 'updated_at'
      && value === new Date(now.getTime() - expected * 86400000).toISOString()));
  }
});

test('shared module cannot import production clients; cron calls the same entries and selectors', async () => {
  const source = await readFile(new URL('./directDebitReconciliationPipeline.js', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/from ['"]([^'"]+)/g)].map(m => m[1]), ['./directDebitDryRunRuntime.js']);
  assert.doesNotMatch(source, /\bfetch\s*\(|\.rpc\s*\(|\.update\s*\(/);
  const cron = await readFile(new URL('../cron/reconcile-gocardless.js', import.meta.url), 'utf8');
  assert.match(cron, /reconciliationSelection\(db, selector, now\)/);
  assert.match(cron, /stage\.run\(ctx, row\)/);
});