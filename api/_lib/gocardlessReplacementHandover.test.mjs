import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplacementSchedule, readReplacementInventory, runReplacementHandover,
  assertSuccessorSubscription } from './gocardlessReplacementHandover.js';

const oldMandate = { id: 'old', status: 'active', scheme: 'bacs', links: { creditor: 'creditor' } };
const newMandate = { ...oldMandate, links: { ...oldMandate.links }, id: 'new', next_possible_charge_date: '2099-01-01' };
const agreement = { id: 'agreement', member_id: 'member', tenant_id: 'tenant',
  agreement_type: 'member', environment: 'sandbox', gocardless_mandate_id: 'old',
  gocardless_billing_request_id: 'br', metadata: { dd: { kind: 'monthly_direct_debit', instalment_count: 3 } } };
const history = { member_id: 'member', tenant_id: 'tenant', term_end_date: '2099-12-31' };
const plan = { id: 'plan', billing_agreement_id: 'agreement', member_id: 'member', tenant_id: 'tenant',
  environment: 'sandbox', gocardless_mandate_id: 'old', gocardless_subscription_id: 'old-sub',
  status: 'active', instalments_total: 3, instalments_paid: 0, amount_minor: 1000, currency: 'GBP' };
const remaining = [{ amount: 1000, charge_date: '2099-02-01' }, { amount: 1000, charge_date: '2099-03-01' }];
const subscription = { id: 'old-sub', status: 'active', interval_unit: 'monthly', count: 3,
  amount: 1000, currency: 'GBP', links: { mandate: 'old' }, upcoming_payments: remaining,
  metadata: { plan_id: 'plan', agreement_id: 'agreement', tenant_id: 'tenant' } };
const payment = { id: 'paid', status: 'paid_out', amount: 1000, currency: 'GBP',
  links: { mandate: 'old', subscription: 'old-sub' } };
const input = () => structuredClone({ agreement, history, plan, oldMandate, newMandate,
  inventory: { payments: [payment], subscriptions: [subscription] }, today: '2099-01-01' });

test('preserves entire known monthly remainder and purchase evidence', () => {
  const snapshot = buildReplacementSchedule(input());
  assert.deepEqual(snapshot.remaining, remaining);
  assert.deepEqual(snapshot.agreement, agreement);
  assert.deepEqual(snapshot.plan, plan);
});
for (const [name, change] of [
  ['pending collection', i => { i.inventory.payments[0].status = 'pending_submission'; }],
  ['failed collection', i => { i.inventory.payments[0].status = 'failed'; }],
  ['partial ten-item preview', i => { i.inventory.subscriptions[0].count = 12; }],
  ['unknown scheduler', i => { delete i.agreement.gocardless_billing_request_id; }],
  ['shared organisation', i => { i.agreement.organization_id = 'org'; }],
  ['different creditor', i => { i.newMandate.links.creditor = 'other'; }],
  ['notice window', i => { i.newMandate.next_possible_charge_date = '2099-04-01'; }],
  ['claimed retry', i => { i.plan.auto_retry_claim_token = 'claimed'; }],
  ['unbounded subscription', i => { i.inventory.subscriptions[0].count = null; }],
  ['disagreed purchased count', i => { i.plan.instalments_total = 4; }],
]) test(`requires assistance for ${name}`, () => {
  const i = input(); change(i);
  assert.throws(() => buildReplacementSchedule(i), { name: 'ReplacementReviewRequired' });
});
test('annual path creates no payment or subscription; dynamic path retains dates', () => {
  const i = input(); i.plan = null; i.inventory.subscriptions = [];
  i.agreement.metadata.dd.kind = 'annual'; i.history.payment_status = 'paid';
  assert.equal(buildReplacementSchedule(i).mode, 'annual');
  i.plan = { ...plan, gocardless_subscription_id: null, metadata: { collection_mode: 'dynamic' },
    dynamic_next_collection_date: '2099-02-01' };
  assert.equal(buildReplacementSchedule(i).mode, 'dynamic');
  i.plan.dynamic_next_collection_date = '2098-12-01';
  assert.throws(() => buildReplacementSchedule(i), /notice_window/);
});
test('partially paid GoCardless plan ignores absent or stale Stripe paid counter', () => {
  for (const count of [undefined, null, 0, 99]) {
    const i = input(); i.plan.instalments_paid = count;
    assert.deepEqual(buildReplacementSchedule(i).remaining, remaining);
  }
});
test('legacy initial Billing Request payment counts once alongside subscription inventory', () => {
  const i = input();
  i.agreement.metadata.dd.instalment_count = 4; i.plan.instalments_total = 4;
  i.agreement.metadata.dd.billing_request_payment = { included: true, amount_minor: 800 };
  i.agreement.metadata.gocardless_initial_payment = { id: 'initial' };
  i.inventory.payments.push({ id: 'initial', status: 'paid_out', amount: 800,
    currency: 'GBP', links: { mandate: 'old' } });
  assert.deepEqual(buildReplacementSchedule(i).remaining, remaining);
  i.inventory.payments.pop();
  assert.throws(() => buildReplacementSchedule(i), /initial_payment_not_verified/);
});
test('initial-only paid evidence works before the subscription makes its first payment', () => {
  const i = input();
  i.agreement.metadata.dd.billing_request_payment = { included: true, amount_minor: 1000 };
  i.agreement.metadata.gocardless_initial_payment = { id: 'initial' };
  i.inventory.subscriptions[0].count = 2;
  i.inventory.payments = [{ id: 'initial', status: 'paid_out', amount: 1000,
    currency: 'GBP', links: { mandate: 'old' } }];
  assert.deepEqual(buildReplacementSchedule(i).remaining, remaining);
});
test('inventory rejects absent cursors, repeated cursors and foreign rows', async () => {
  const base = { listSubscriptionsPage: async () => ({ subscriptions: [], after: null }) };
  await assert.rejects(readReplacementInventory({ ...base,
    listReplacementPaymentsPage: async () => ({ payments: [] }) }, 'old'), /incomplete/);
  await assert.rejects(readReplacementInventory({ ...base,
    listReplacementPaymentsPage: async () => ({ payments: [], after: 'same' }) }, 'old'), /repeated/);
  await assert.rejects(readReplacementInventory({ ...base,
    listReplacementPaymentsPage: async () => ({ payments: [{ id: 'foreign', links: { mandate: 'other' } }], after: null }) }, 'old'), /ambiguous/);
});
function harness() {
  const snapshot = buildReplacementSchedule(input());
  let op = { id: 'op', tenant_id: 'tenant', old_mandate_id: 'old', new_mandate_id: 'new',
    status: 'switching', phase: 'prepared', snapshot, version: 0 };
  const calls = []; let stopped = false, retired = false, created;
  const advance = async (expected, patch) => {
    assert.equal(expected.version, op.version);
    op = { ...op, ...patch, version: op.version + 1 }; return op;
  };
  const gc = {
    getMandate: async id => id === 'old' ? { ...oldMandate, status: retired ? 'cancelled' : 'active' } : newMandate,
    listReplacementPaymentsPage: async () => ({ payments: [payment], after: null }),
    listSubscriptionsPage: async () => ({ subscriptions: [{ ...subscription, status: stopped ? 'cancelled' : 'active' }], after: null }),
    getSubscription: async id => id === 'old-sub' ? { ...subscription, status: stopped ? 'cancelled' : 'active' } : created,
    cancelSubscription: async () => { calls.push('stop'); stopped = true; },
    createSubscription: async args => {
      calls.push(['create', args.idempotencyKey]);
      created ||= { ...subscription, id: 'new-sub', count: 2, links: { mandate: 'new' },
        metadata: { replacement_id: 'op' } };
      return created;
    },
    cancelMandate: async () => { calls.push('retire'); retired = true; },
  };
  const store = { advance,
    commit: async expected => { calls.push('commit'); return advance(expected, { phase: 'retire_intent' }); },
    complete: async expected => { assert.equal(retired, true); return advance(expected, { phase: 'complete', status: 'completed' }); },
  };
  return { gc, store, calls, operation: () => op };
}
test('ordered verified handover retires only after successor and commit', async () => {
  const h = harness();
  const result = await runReplacementHandover({ ...h, operation: h.operation() });
  assert.equal(result.status, 'completed');
  assert.deepEqual(h.calls.map(c => Array.isArray(c) ? c[0] : c), ['stop', 'create', 'commit', 'retire']);
});
test('ambiguous create replays same idempotency key, not a fresh subscription', async () => {
  const h = harness(); const create = h.gc.createSubscription; let first = true;
  h.gc.createSubscription = async args => {
    const result = await create(args);
    if (first) { first = false; throw new Error('lost response'); }
    return result;
  };
  await assert.rejects(runReplacementHandover({ ...h, operation: h.operation() }), /lost response/);
  assert.equal(h.operation().phase, 'create_intent');
  const result = await runReplacementHandover({ ...h, operation: h.operation() });
  assert.equal(result.status, 'completed');
  assert.equal(h.calls[1][1], h.calls[2][1]);
});
test('retirement timeout is not success and is reconciled by GET', async () => {
  const h = harness(); const cancel = h.gc.cancelMandate;
  h.gc.cancelMandate = async () => { await cancel(); throw new Error('lost response'); };
  await assert.rejects(runReplacementHandover({ ...h, operation: h.operation() }), /lost response/);
  assert.equal(h.operation().phase, 'retire_intent');
  assert.equal((await runReplacementHandover({ ...h, operation: h.operation() })).status, 'completed');
  assert.equal(h.calls.filter(c => c === 'retire').length, 1);
});
test('provider-created payment during stop blocks successor and retirement', async () => {
  const h = harness(); const stop = h.gc.cancelSubscription;
  h.gc.cancelSubscription = async () => {
    await stop();
    h.gc.listReplacementPaymentsPage = async () => ({ payments: [payment,
      { id: 'raced', status: 'pending_submission', links: { mandate: 'old' } }], after: null });
  };
  await assert.rejects(runReplacementHandover({ ...h, operation: h.operation() }), /collection_created/);
  assert.deepEqual(h.calls, ['stop']);
});
test('successor mismatched schedule is never verified', () => {
  const h = harness();
  assert.throws(() => assertSuccessorSubscription({ ...subscription, id: 'new-sub',
    links: { mandate: 'new' }, metadata: { replacement_id: 'op' }, count: 2,
    upcoming_payments: [{ amount: 1000, charge_date: '2099-04-01' }] }, h.operation()), /schedule_not_verified/);
});
