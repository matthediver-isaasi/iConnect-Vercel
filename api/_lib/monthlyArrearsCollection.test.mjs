import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  allocateOldestFirst,
  collectionPolicyForAgreement,
  projectNextCollection,
  resolveMonthlyPostGraceCollectionPolicy,
  completeMonthlyCollectionIntent,
  executePostGraceCollection,
  failMonthlyCollectionIntent,
} from './monthlyArrearsCollection.js';

const periods = [
  { due_period: '2026-02-01', amount_minor: 1000 },
  { due_period: '2026-01-01', amount_minor: 1000 },
];

test('oldest-first settlement allocates whole monthly periods', () => {
  const result = allocateOldestFirst({ amountMinor: 2000, openPeriods: periods });
  assert.deepEqual(result.settled.map((p) => p.due_period), ['2026-01-01', '2026-02-01']);
  assert.equal(result.remainingAmountMinor, 0);
});

test('partial catch-up never silently settles a period', () => {
  const result = allocateOldestFirst({ amountMinor: 1500, openPeriods: periods });
  assert.equal(result.settled.length, 1);
  assert.equal(result.remainingAmountMinor, 500);
});

test('continue policy projects normal month plus every open period', () => {
  assert.deepEqual(projectNextCollection({
    monthlyAmountMinor: 1000, openPeriods: periods, nextDate: '2026-03-01', policy: 'continue_catch_up',
  }), {
    arrearsCount: 2, arrearsAmountMinor: 2000, nextCollectionAmountMinor: 3000,
    nextCollectionDate: '2026-03-01', collectionStopped: false,
  });
});

test('stop policy has no next collection and snapshot policy is isolated', () => {
  const projection = projectNextCollection({ monthlyAmountMinor: 1000, openPeriods: periods, nextDate: '2026-03-01', policy: 'stop_collecting' });
  assert.equal(projection.nextCollectionAmountMinor, null);
  assert.equal(collectionPolicyForAgreement({ metadata: { card: { monthly_post_grace_collection_policy: 'continue_catch_up' } } }), 'continue_catch_up');
  assert.equal(resolveMonthlyPostGraceCollectionPolicy('bad'), 'stop_collecting');
});

test('migration provides durable intent leases, immutable uniqueness, and locked settlement replay', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20260921_monthly_post_grace_collection.sql', import.meta.url), 'utf8');
  assert.match(sql, /membership_monthly_collection_intent/);
  assert.match(sql, /lease_owner UUID/);
  assert.match(sql, /lease_expires_at TIMESTAMPTZ/);
  assert.match(sql, /attempt_count INTEGER/);
  assert.match(sql, /UNIQUE \(tenant_id, plan_id, intent_key\)/);
  const lockAt = sql.indexOf('WHERE id=p_plan_id AND tenant_id=p_tenant_id FOR UPDATE');
  const replayAt = sql.lastIndexOf('SELECT * INTO v_prior');
  assert.ok(lockAt >= 0 && replayAt > lockAt, 'settlement replay check must follow plan lock');
  assert.match(sql, /REVOKE ALL ON FUNCTION claim_membership_monthly_collection_intent[\s\S]*PUBLIC,\s*anon,\s*authenticated/);
  assert.match(sql, /recover_membership_monthly_collection_provider_ref/);
  assert.match(sql, /status='creating' FOR UPDATE/);
  assert.match(sql, /REVOKE ALL ON FUNCTION recover_membership_monthly_collection_provider_ref[\s\S]*PUBLIC,anon,authenticated/);
  assert.match(sql, /membership_monthly_collection_intent_provider_ref_uidx/);
});

function completionDb(plan) {
  const writes = [];
  return { writes, from(table) {
    const q = {
      update(patch) { writes.push({ table, patch }); return q; },
      select() { return q; }, eq() { return q; }, in() { return q; }, filter() { return q; },
      maybeSingle: async () => ({ data: plan, error: null }),
      then(resolve) { return Promise.resolve({ error: null }).then(resolve); },
    };
    return q;
  } };
}
const oldIntent = { tenant_id: 't1', plan_id: 'p1', intent_key: 'old-key', provider_reference: 'pay-old', status: 'created' };

test('immutable old intent completion never overwrites an advanced pointer', async () => {
  const plan = { id: 'p1', tenant_id: 't1', metadata: { catch_up_intent: { key: 'new-key', provider_reference: 'pay-new' } } };
  const db = completionDb(plan);
  await completeMonthlyCollectionIntent({ plan, intent: oldIntent, providerReference: 'pay-old', db });
  assert.equal(db.writes.filter((w) => w.table === 'membership_monthly_collection_intent').length, 1);
  assert.equal(db.writes.filter((w) => w.table === 'membership_payment_plans').length, 0);
});

test('immutable intent duplicate completion replay is idempotent', async () => {
  const plan = { id: 'p1', tenant_id: 't1', metadata: { catch_up_intent: { key: 'old-key', provider_reference: 'pay-old', status: 'completed' } } };
  const db = completionDb(plan);
  await completeMonthlyCollectionIntent({ plan, intent: { ...oldIntent, status: 'completed' }, providerReference: 'pay-old', db });
  assert.equal(db.writes.filter((w) => w.table === 'membership_monthly_collection_intent').length, 1);
});

test('immutable intent completion rejects validation mismatch', async () => {
  const plan = { id: 'p1', tenant_id: 't1', metadata: {} };
  await assert.rejects(completeMonthlyCollectionIntent({
    plan, intent: { ...oldIntent, plan_id: 'other' }, providerReference: 'pay-old', db: completionDb(plan),
  }), /does not match/);
});

test('immutable intent completion updates matching current pointer', async () => {
  const plan = { id: 'p1', tenant_id: 't1', metadata: { catch_up_intent: { key: 'old-key', provider_reference: 'pay-old', status: 'created' } } };
  const db = completionDb(plan);
  await completeMonthlyCollectionIntent({ plan, intent: oldIntent, providerReference: 'pay-old', db });
  const write = db.writes.find((w) => w.table === 'membership_payment_plans');
  assert.equal(write.patch.metadata.catch_up_intent.status, 'completed');
});

test('immutable intent pointer CAS prevents overwrite when newer pointer wins between read and update', async () => {
  const staleRead = { id: 'p1', tenant_id: 't1', metadata: { catch_up_intent: { key: 'old-key', provider_reference: 'pay-old' } } };
  const predicates = [];
  let persistedPointer = { key: 'new-key', provider_reference: 'pay-new' };
  const db = {
    from(table) {
      const q = {
        patch: null,
        update(patch) { q.patch = patch; return q; },
        select() { return q; }, eq() { return q; }, in() { return q; },
        filter(path, op, value) {
          predicates.push([path, op, value]);
          // Simulate Postgres evaluating the CAS after another transaction
          // has advanced the pointer: predicate mismatch means no write.
          if (table === 'membership_payment_plans' && persistedPointer.key !== value && path.endsWith('>>key')) q.blocked = true;
          return q;
        },
        maybeSingle: async () => ({ data: staleRead, error: null }),
        then(resolve) {
          if (table === 'membership_payment_plans' && q.patch && !q.blocked) persistedPointer = q.patch.metadata.catch_up_intent;
          return Promise.resolve({ error: null }).then(resolve);
        },
      };
      return q;
    },
  };
  await completeMonthlyCollectionIntent({ plan: staleRead, intent: oldIntent, providerReference: 'pay-old', db });
  assert.deepEqual(persistedPointer, { key: 'new-key', provider_reference: 'pay-new' });
  assert.deepEqual(predicates.map((p) => p[0]), [
    'metadata->catch_up_intent->>key',
    'metadata->catch_up_intent->>provider_reference',
  ]);
});

function stopExecutionDb(plan, { loseClaim = false, revalidateError = null } = {}) {
  const intents = [];
  return {
    intents,
    rpc: async () => loseClaim
      ? ({ data: [], error: null })
      : ({ data: [{ id: `intent-${intents.length + 1}`, lease_owner: 'leased' }], error: null }),
    from(table) {
      const q = {
        patch: null,
        select() { return q; }, eq() { return q; }, is() { return q; }, order() { return q; }, filter() { return q; },
        update(patch) {
          q.patch = patch;
          if (table === 'membership_monthly_collection_intent') intents.push(patch);
          if (table === 'membership_payment_plans' && patch.collection_stopped_at) Object.assign(plan, patch);
          return q;
        },
        maybeSingle: async () => ({
          data: table === 'membership_payment_plans' && !revalidateError ? plan : null,
          error: table === 'membership_payment_plans' ? revalidateError : null,
        }),
        then(resolve) {
          return Promise.resolve({
            data: table === 'membership_monthly_arrears_period' ? [{ id: 'period-1', amount_minor: 1000, due_period: '2026-01-01' }] : null,
            error: null,
          }).then(resolve);
        },
      };
      return q;
    },
  };
}

function stopPlan(provider) {
  return {
    id: `plan-${provider}`, tenant_id: 't1', provider, status: 'payment_overdue',
    interval_unit: 'monthly', amount_minor: 1000, currency: 'GBP',
    gocardless_subscription_id: provider === 'gocardless' ? 'SB-GC' : null,
    stripe_subscription_id: provider === 'stripe' ? 'sub_stripe' : null,
    metadata: {},
  };
}
const stopAgreement = { metadata: { dd: { monthly_post_grace_collection_policy: 'stop_collecting' } } };

test('GC durable stop failure releases intent and retry succeeds; already-cancelled concludes locally', async () => {
  const plan = stopPlan('gocardless');
  const db = stopExecutionDb(plan);
  await assert.rejects(executePostGraceCollection({
    plan, agreement: stopAgreement, db,
    gc: { getSubscription: async () => ({ status: 'active' }), cancelSubscription: async () => { throw new Error('temporary'); } },
  }), /temporary/);
  assert.equal(plan.collection_stopped_at, undefined);
  assert.equal(db.intents.at(-1).status, 'failed');
  const retried = await executePostGraceCollection({
    plan, agreement: stopAgreement, db,
    gc: { getSubscription: async () => ({ status: 'cancelled' }), cancelSubscription: async () => assert.fail('must not cancel again') },
  });
  assert.equal(retried.stopped, true);
  assert.ok(plan.collection_stopped_at);
  assert.equal(db.intents.at(-1).status, 'manual_resolution');
});

test('Stripe durable stop failure retries, while concurrent claim loser makes no provider call', async () => {
  const plan = stopPlan('stripe');
  const db = stopExecutionDb(plan);
  await assert.rejects(executePostGraceCollection({
    plan, agreement: stopAgreement, db,
    stripe: { subscriptions: { retrieve: async () => ({ status: 'active' }), cancel: async () => { throw new Error('stripe temporary'); } } },
  }), /stripe temporary/);
  assert.equal(db.intents.at(-1).status, 'failed');
  const retry = await executePostGraceCollection({
    plan, agreement: stopAgreement, db,
    stripe: { subscriptions: { retrieve: async () => ({ status: 'canceled' }), cancel: async () => assert.fail('already canceled') } },
  });
  assert.equal(retry.stopped, true);
  let calls = 0;
  const loserPlan = stopPlan('stripe');
  const loser = await executePostGraceCollection({
    plan: loserPlan, agreement: stopAgreement, db: stopExecutionDb(loserPlan, { loseClaim: true }),
    stripe: { subscriptions: { retrieve: async () => { calls++; } } },
  });
  assert.equal(loser.skipped, 'already-claimed');
  assert.equal(calls, 0);
});

test('stopped plan never creates a continue catch-up', async () => {
  const plan = { ...stopPlan('stripe'), collection_stopped_at: '2026-01-02' };
  const agreement = { metadata: { card: { monthly_post_grace_collection_policy: 'continue_catch_up' } } };
  const out = await executePostGraceCollection({ plan, agreement, db: stopExecutionDb(plan), stripe: {} });
  assert.equal(out.skipped, 'plan-not-collectible');
});

test('reclaimed stop intent terminalizes when crash already persisted collection_stopped_at', async () => {
  const plan = { ...stopPlan('gocardless'), collection_stopped_at: '2026-02-01', metadata: { catch_up_intent: { key: 'monthly-stop:plan-gocardless', status: 'stopping' } } };
  const db = stopExecutionDb(plan);
  const out = await executePostGraceCollection({ plan, agreement: stopAgreement, db, gc: {} });
  assert.equal(out.stopped, true);
  assert.equal(out.idempotent, true);
  assert.equal(db.intents.at(-1).status, 'manual_resolution');
  assert.equal(db.intents.at(-1).lease_owner, null);
});

test('stop plan revalidation DB error marks exact claimed intent failed and releases lease', async () => {
  const plan = stopPlan('stripe');
  const db = stopExecutionDb(plan, { revalidateError: { message: 'database unavailable' } });
  await assert.rejects(executePostGraceCollection({ plan, agreement: stopAgreement, db, stripe: {} }), /database unavailable/);
  assert.equal(db.intents.at(-1).status, 'failed');
  assert.equal(db.intents.at(-1).lease_owner, null);
});

test('GC catch-up omits stale next charge date and persists authoritative provider charge date', async () => {
  const plan = {
    ...stopPlan('gocardless'), collection_stopped_at: null,
    gocardless_mandate_id: 'MD-GC',
    next_charge_date: '2025-01-01',
  };
  const db = stopExecutionDb(plan);
  let createArgs;
  const agreement = { metadata: { dd: { monthly_post_grace_collection_policy: 'continue_catch_up' } } };
  const out = await executePostGraceCollection({
    plan, agreement, db,
    gc: {
      getSubscription: async () => ({ status: 'active' }),
      createPayment: async (args) => {
        createArgs = args;
        return { id: 'PM-FUTURE', charge_date: '2026-04-03' };
      },
    },
  });
  assert.equal('chargeDate' in createArgs, false);
  assert.equal(out.intent.provider_reference, 'PM-FUTURE');
  assert.equal(out.intent.provider_charge_date, '2026-04-03');
});

for (const provider of ['gocardless', 'stripe']) {
  test(`${provider} continue claim supplies complete typed RPC signature and planned current-plus-arrears amount`, async () => {
    const periodId = '11111111-1111-4111-8111-111111111111';
    const plan = {
      ...stopPlan(provider), amount_minor: 1200, collection_stopped_at: null,
      gocardless_mandate_id: provider === 'gocardless' ? 'MD1' : null,
    };
    const db = stopExecutionDb(plan);
    let claim;
    db.rpc = async (name, args) => {
      if (name === 'record_membership_monthly_collection_provider_ref') {
        assert.equal(args.p_provider_reference, provider === 'stripe' ? 'ii1' : 'PM1');
        assert.notEqual(args.p_lease_owner, undefined);
        return { data: [], error: null };
      }
      assert.equal(name, 'claim_membership_monthly_collection_intent');
      for (const required of [
        'p_tenant_id', 'p_plan_id', 'p_intent_key', 'p_policy', 'p_period_ids',
        'p_arrears_amount_minor', 'p_planned_amount_minor', 'p_lease_owner',
      ]) assert.notEqual(args[required], undefined, `${required} must be defined`);
      claim = args;
      return { data: [{ id: 'intent-claim' }], error: null };
    };
    // Replace the period returned by the fake query with a UUID and 800 debt.
    const originalFrom = db.from.bind(db);
    db.from = (table) => {
      const q = originalFrom(table);
      if (table === 'membership_monthly_arrears_period') {
        q.then = (resolve) => Promise.resolve({
          data: [{ id: periodId, amount_minor: 800, due_period: '2026-01-01' }], error: null,
        }).then(resolve);
      }
      return q;
    };
    const agreement = { metadata: { [provider === 'stripe' ? 'card' : 'dd']: {
      monthly_post_grace_collection_policy: 'continue_catch_up',
    } } };
    const providerDeps = provider === 'stripe'
      ? { stripe: {
        subscriptions: { retrieve: async () => ({ status: 'active', customer: 'cus1' }) },
        invoiceItems: { create: async () => ({ id: 'ii1' }) },
      } }
      : { gc: {
        getSubscription: async () => ({ status: 'active' }),
        createPayment: async () => ({ id: 'PM1', charge_date: '2026-04-01' }),
      } };
    await executePostGraceCollection({ plan, agreement, db, ...providerDeps });
    assert.equal(claim.p_tenant_id, plan.tenant_id);
    assert.equal(claim.p_plan_id, plan.id);
    assert.equal(claim.p_policy, 'continue_catch_up');
    assert.deepEqual(claim.p_period_ids, [periodId]);
    assert.equal(claim.p_arrears_amount_minor, 800);
    assert.equal(claim.p_planned_amount_minor, 2000);
    assert.equal(typeof claim.p_intent_key, 'string');
    assert.match(claim.p_intent_key, new RegExp(periodId));
    assert.equal(typeof claim.p_lease_owner, 'string');
    assert.match(claim.p_lease_owner, /^[0-9a-f-]{36}$/i);
  });
}

for (const provider of ['gocardless', 'stripe']) {
  test(`${provider} provider success plus atomic record outage stays creating and stale reclaim reuses idempotency`, async () => {
    const plan = {
      ...stopPlan(provider), collection_stopped_at: null, gocardless_mandate_id: provider === 'gocardless' ? 'MD1' : null,
    };
    const db = stopExecutionDb(plan);
    let recordAttempts = 0;
    db.rpc = async (name, args) => {
      if (name === 'claim_membership_monthly_collection_intent') return { data: [{ id: 'intent-1' }], error: null };
      recordAttempts++;
      return recordAttempts === 1
        ? { data: null, error: { message: 'atomic persistence outage' } }
        : { data: [{ id: 'intent-1', status: 'created', provider_reference: provider === 'stripe' ? 'ii-stable' : 'PM-stable' }], error: null };
    };
    const keys = [];
    const agreement = { metadata: { [provider === 'stripe' ? 'card' : 'dd']: { monthly_post_grace_collection_policy: 'continue_catch_up' } } };
    const providerDeps = provider === 'stripe' ? { stripe: {
      subscriptions: { retrieve: async () => ({ status: 'active', customer: 'cus' }) },
      invoiceItems: { create: async (_args, opts) => { keys.push(opts.idempotencyKey); return { id: 'ii-stable' }; } },
    } } : { gc: {
      getSubscription: async () => ({ status: 'active' }),
      createPayment: async (args) => { keys.push(args.idempotencyKey); return { id: 'PM-stable', charge_date: '2026-04-01' }; },
    } };
    await assert.rejects(executePostGraceCollection({ plan, agreement, db, ...providerDeps }), /record catch-up provider reference failed/);
    assert.equal(db.intents.some((patch) => patch.status === 'failed'), false);
    await executePostGraceCollection({ plan, agreement, db, ...providerDeps });
    assert.deepEqual(keys, [keys[0], keys[0]]);
    assert.equal(new Set(keys).size, 1);
    assert.equal(recordAttempts, 2);
  });
}

function failureDb(intentStatus) {
  const writes = [];
  return { writes, from(table) {
    const q = {
      patch: null, filters: {},
      update(patch) { q.patch = patch; return q; },
      eq(k, v) { q.filters[k] = v; return q; }, filter() { return q; }, select() { return q; },
      maybeSingle: async () => {
        if (table === 'membership_monthly_collection_intent') {
          if (intentStatus !== 'created') return { data: null, error: null };
          intentStatus = 'failed'; writes.push({ table, patch: q.patch }); return { data: { id: 'i1' }, error: null };
        }
        return { data: null, error: null };
      },
      then(resolve) { writes.push({ table, patch: q.patch }); return Promise.resolve({ error: null }).then(resolve); },
    };
    return q;
  } };
}

test('completed intent then late failure is no-op and completed pointer remains unchanged', async () => {
  const pointer = { key: 'k1', provider_reference: 'PM1', status: 'completed' };
  const plan = { id: 'p1', tenant_id: 't1', metadata: { catch_up_intent: pointer } };
  const intent = { intent_key: 'k1', provider_reference: 'PM1', tenant_id: 't1', plan_id: 'p1', status: 'completed' };
  const db = failureDb('completed');
  assert.deepEqual(await failMonthlyCollectionIntent({ plan, intent, providerReference: 'PM1', db }), { updated: false });
  assert.equal(db.writes.some((w) => w.table === 'membership_payment_plans'), false);
  assert.equal(pointer.status, 'completed');
});

test('duplicate collection failure is idempotent and does not rewrite pointer twice', async () => {
  const plan = { id: 'p1', tenant_id: 't1', metadata: { catch_up_intent: { key: 'k1', provider_reference: 'PM1', status: 'created' } } };
  const intent = { intent_key: 'k1', provider_reference: 'PM1', tenant_id: 't1', plan_id: 'p1', status: 'created' };
  const db = failureDb('created');
  assert.equal((await failMonthlyCollectionIntent({ plan, intent, providerReference: 'PM1', db })).updated, true);
  assert.equal((await failMonthlyCollectionIntent({ plan, intent, providerReference: 'PM1', db })).updated, false);
  assert.equal(db.writes.filter((w) => w.table === 'membership_payment_plans').length, 1);
});