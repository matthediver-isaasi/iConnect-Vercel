import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runArrearsAccess, runArrearsMonthly, runArrearsPolicy } from './gocardlessArrearsPipeline.js';
import { recordingEffects, readonlyTenantDatabase } from './directDebitDryRunRuntime.js';

const now = new Date('2026-02-01T00:00:00Z');
const plan = { id: 'p', tenant_id: 't', provider: 'gocardless', billing_agreement_id: 'a',
  status: 'payment_overdue', interval_unit: 'monthly', grace_expires_at: '2026-01-01',
  failed_due_period: '2026-01-01', last_payment_id: 'PM1', amount_minor: 1200, currency: 'GBP' };
const agreement = { id: 'a', tenant_id: 't', member_id: 'm', metadata: { dd: { config_id: 'c' } } };
function db(tables = {}) {
  return {
    from(table) {
      const query = {
        select() { return this; }, eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: tables[table]?.[0] || null }); },
        then(resolve) { return Promise.resolve({ data: tables[table] || [] }).then(resolve); },
        update() { assert.fail('raw update'); }, insert() { assert.fail('raw insert'); },
      };
      return query;
    },
    rpc() { assert.fail('raw RPC'); },
  };
}

test('access policy recording and fake live share identical first operation and reads', async () => {
  const database = readonlyTenantDatabase(db({ membership_tier_config: [{ id: 'c', dd_arrears_policy: 'suspend' }] }), 't');
  const recording = [], live = [], trace = [];
  const args = { db: database, plan, agreement, now, trace: entry => trace.push(entry) };
  await assert.rejects(runArrearsAccess({ ...args, effects: recordingEffects(recording) }),
    { code: 'DD_DRY_RUN_EFFECT_BOUNDARY' });
  const outcome = await runArrearsAccess({ ...args, effects: { async perform(op) {
    live.push(op);
    return op.type === 'arrears_transition' ? { applied: true } : {};
  } } });
  assert.deepEqual(recording, live.slice(0, 1));
  assert.equal(outcome.applied, true);
  assert.equal(live[1].payload.values.metadata.dd.arrears_state, 'suspend');
  assert.match(recording[0].continuation, /compare-and-set/);
});

test('real failed claim result stops agreement/access changes', async () => {
  const operations = [];
  const outcome = await runArrearsPolicy({ db: db(), plan, agreement, now,
    tierConfig: { dd_arrears_policy: 'suspend' },
    effects: { async perform(op) {
      operations.push(op);
      return op.type === 'arrears_transition' ? { applied: false } : null;
    } },
  });
  assert.equal(outcome.applied, false);
  assert.equal(operations.length, 2);
  assert.deepEqual(operations[1].payload.filters.at(-1), ['is', 'arrears_policy_applied', null]);
});

test('monthly recording stops before credential access, leases, collections and cleanup', async () => {
  const operations = [];
  await assert.rejects(runArrearsMonthly({
    db: readonlyTenantDatabase(db(), 't'), plan, agreement, now,
    effects: recordingEffects(operations),
    getGc() { assert.fail('credentials/provider must not be reached before accrual'); },
  }), { code: 'DD_DRY_RUN_EFFECT_BOUNDARY' });
  assert.equal(operations.length, 1);
  assert.equal(operations[0].payload.name, 'accrue_membership_monthly_arrears_period');
  assert.deepEqual(operations[0].payload.args, {
    p_tenant_id: 't', p_plan_id: 'p', p_due_period: '2026-01-01',
    p_amount_minor: 1200, p_currency: 'GBP', p_payment_reference: 'PM1',
  });
});

test('monthly live and recording agree at accrual; failure never reaches provider continuation', async () => {
  const recorded = [], live = [];
  const base = { db: db(), plan, agreement, now, getGc: async () => ({}) };
  await assert.rejects(runArrearsMonthly({ ...base, effects: recordingEffects(recorded) }));
  await assert.rejects(runArrearsMonthly({ ...base, effects: { async perform(op) {
    live.push(op); throw new Error('ledger down');
  } } }), /ledger down/);
  assert.deepEqual(recorded, live);
  const succeeded = [];
  const outcome = await runArrearsMonthly({ ...base, effects: { async perform(op) {
    succeeded.push(op);
    return op.type === 'arrears_accrual' ? { created: true } : { created: false, stopped: true };
  } } });
  assert.equal(outcome.stopped, true);
  assert.deepEqual(succeeded[0], recorded[0]);
});

test('grace not expired and already applied policy are true no-action outcomes', async () => {
  const effects = { perform() { assert.fail('not due'); } };
  const traces = [];
  const base = { db: db(), agreement, now, effects, trace: value => traces.push(value) };
  await runArrearsAccess({ ...base, plan: { ...plan, arrears_policy_applied: 'suspend' } });
  await runArrearsMonthly({ ...base, plan: { ...plan, grace_expires_at: '2026-03-01' } });
  await runArrearsMonthly({ ...base, plan: { ...plan, provider: 'stripe' } });
  assert.equal(traces.length, 3);
  assert.ok(traces.every(t => t.status === 'skipped'));
});

test('restriction repair validates tenant fallback role before concrete atomic role operation', async () => {
  const operations = [];
  await assert.rejects(runArrearsAccess({
    plan: { ...plan, arrears_policy_applied: 'restrict' }, agreement, now,
    db: readonlyTenantDatabase(db({
      membership_tier_config: [{ id: 'c', dd_arrears_policy: 'restrict', dd_arrears_fallback_role_id: 'r' }],
      role: [{ id: 'r', name: 'Restricted', is_tenant_admin: false }], member: [{ id: 'm' }],
    }), 't'),
    effects: recordingEffects(operations),
  }), { code: 'DD_DRY_RUN_EFFECT_BOUNDARY' });
  assert.equal(operations[0].payload.name, 'apply_membership_arrears_fallback_role');
  assert.equal(operations[0].payload.args.p_member_id, 'm');
});

test('pure pipeline has no imports or ambient mutation/network clients; actual cron uses shared entries', async () => {
  const source = await readFile(new URL('./gocardlessArrearsPipeline.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bimport\s|\bfetch\s*\(|\bsupabase\b|\bprocess\.env\b/);
  const cron = await readFile(new URL('../cron/gocardless-arrears.js', import.meta.url), 'utf8');
  assert.match(cron, /await runArrearsAccess\(/);
  assert.match(cron, /await runArrearsMonthly\(/);
  assert.match(cron, /await selectArrearsMonthly\(/);
  assert.match(cron, /await selectArrearsAccess\(/);
});