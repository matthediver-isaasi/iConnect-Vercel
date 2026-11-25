import assert from 'node:assert/strict';
import test from 'node:test';
import { supabase } from './database.js';
import { executeWorkflowActions, runScheduledWorkflow, triggerWorkflows } from './workflows.js';
import { executeWorkflowCommunicationSubscriptions as execute } from './workflowCommunicationSubscriptions.js';
import {
  normalizeWorkflowCommunicationConfig, workflowUpdateFieldSelection,
  clearIncompatibleCommunicationActions,
} from '../../shared/workflowCommunicationSubscriptions.js';

const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
const c = '00000000-0000-4000-8000-000000000003';
const config = (ids = [a], state = true) => ({
  ...workflowUpdateFieldSelection('communication_categories'),
  communication_subscription: { category_ids: ids, is_subscribed: state },
});

export function fixture(options = {}) {
  const tables = {
    member: [{ id: 'member', tenant_id: 'tenant', email: 'member@example.test', role_id: 'role', ...options.member }],
    communication_category: options.categories || [a, b, c].map(id => ({ id, tenant_id: 'tenant', name: id, is_active: true })),
    communication_category_role: options.roles || [],
    email_unsubscribe: options.globalLedger ? [{ id: 'global', tenant_id: 'tenant', email: 'member@example.test', unsubscribe_type: 'all' }] : [],
    workflow: options.workflows || [],
  };
  const calls = [];
  const preferences = new Map([[c, true]]);
  const logs = [];
  const writes = [];
  const database = {
    calls, preferences, logs, writes,
    from(table) {
      const filters = [];
      let single = false;
      const query = {
        select() { return query; },
        eq(key, value) { filters.push(row => row[key] === value); return query; },
        neq(key, value) { filters.push(row => row[key] !== value); return query; },
        in(key, values) { filters.push(row => values.includes(row[key])); return query; },
        order() { return query; },
        limit() { return query; },
        range() { return query; },
        maybeSingle() { single = true; return query; },
        single() { single = true; return query; },
        update(row) { writes.push({ table, row }); return query; },
        upsert(row) { writes.push({ table, row }); return query; },
        insert(row) {
          if (table === 'workflow_log') logs.push(row);
          else writes.push({ table, row });
          return query;
        },
        then(resolve) {
          const rows = (tables[table] || []).filter(row => filters.every(fn => fn(row)));
          return Promise.resolve({ data: single ? rows[0] || null : rows,
            error: options.readFailure === table ? { message: 'read failed' } : null }).then(resolve);
        },
      };
      return query;
    },
    async rpc(name, args) {
      assert.equal(name, 'set_email_preference_category_state');
      assert.equal(args.p_member_id, 'member');
      assert.equal(args.p_tenant_id, 'tenant');
      assert.equal(args.p_campaign_id, null);
      calls.push(args);
      if (options.failCategory === args.p_category_id) return { error: { message: 'write failed' } };
      if (options.racingGlobalOptOut) return { error: { message: 'global email opt-out is active' } };
      preferences.set(args.p_category_id, args.p_is_subscribed);
      return { error: null };
    },
  };
  return database;
}
const run = (database, actionConfig = config(), overrides = {}) => execute({
  database, tenantId: 'tenant', memberId: 'member', entityType: 'member', config: actionConfig, ...overrides,
});

test('normalizes IDs, persists explicit states, and preserves independent mixed actions', () => {
  const actions = [config([a, a, b]), config([c], false)].map(value =>
    normalizeWorkflowCommunicationConfig(value, 'member'));
  assert.deepEqual(actions[0].communication_subscription.category_ids, [a, b]);
  assert.deepEqual(JSON.parse(JSON.stringify(actions)), actions);
  for (const type of ['organization', 'job_posting']) {
    assert.throws(() => normalizeWorkflowCommunicationConfig(actions[0], type), /member workflow/);
    const cleared = clearIncompatibleCommunicationActions(actions.map(config => ({ type: 'update_field', config })), type);
    assert.ok(cleared.every(action => !action.config.communication_subscription));
  }
  assert.equal(workflowUpdateFieldSelection('core', 'status').communication_subscription, undefined);
});

test('single/multi selection is idempotent and never replaces unselected preferences', async () => {
  const db = fixture();
  assert.equal((await run(db)).status, 'success');
  assert.equal((await run(db, config([a, a, b]))).status, 'success');
  await run(db, config([a, b]));
  assert.equal(db.calls.length, 5);
  await run(db, config([b], false));
  assert.deepEqual([...db.preferences], [[c, true], [a, true], [b, false]]);
});

test('global member flag and global suppression ledger prevent writes; racing opt-out is a skip', async () => {
  for (const options of [{ member: { communications_opted_out_all: true } }, { globalLedger: true }]) {
    const db = fixture(options);
    const result = await run(db, config([a, b]));
    assert.equal(result.status, 'skipped');
    assert.ok(result.result.categories.every(row => row.reason === 'global_opt_out'));
    assert.equal(db.calls.length, 0);
  }
  const db = fixture({ racingGlobalOptOut: true });
  assert.equal((await run(db)).result.categories[0].reason, 'global_opt_out');
});

test('subscribe respects role and member audience; unsubscribe works after either is removed', async () => {
  const db = fixture({
    categories: [
      { id: a, tenant_id: 'tenant', is_active: true, member_enabled: false, is_public: true },
      { id: b, tenant_id: 'tenant', is_active: true },
      { id: c, tenant_id: 'tenant', is_active: true },
    ],
    roles: [{ category_id: b, role_id: 'different', tenant_id: 'tenant' }],
  });
  const result = await run(db, config([a, b, c]));
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.result.categories.map(row => row.status), ['skipped', 'skipped', 'success']);
  assert.equal((await run(db, config([a, b], false))).status, 'success');
  assert.equal(db.preferences.get(a), false);
  assert.equal(db.preferences.get(b), false);
});

test('deleted, inactive, foreign categories and unsupported system selections never write', async () => {
  const db = fixture({ categories: [
    { id: a, tenant_id: 'foreign', is_active: true },
    { id: b, tenant_id: 'tenant', is_active: false },
    { id: c, tenant_id: 'tenant', is_active: true, system_key: 'job_postings', member_enabled: false },
  ] });
  const result = await run(db, config([a, b, c]));
  assert.deepEqual(result.result.categories.map(row => row.reason), ['category_unavailable', 'category_unavailable', 'unsupported_system_category']);
  assert.equal(db.calls.length, 0);
});

test('missing/foreign member and malformed configurations fail closed before writes', async () => {
  for (const invalid of [null, {}, config([], true), config([a], 'true'), config(['bad']), { ...config(), field_type: 'core' }]) {
    const db = fixture();
    assert.equal((await run(db, invalid)).status, 'failed');
    assert.equal(db.calls.length, 0);
  }
  const db = fixture({ member: { tenant_id: 'foreign' } });
  assert.equal((await run(db)).status, 'failed');
  assert.equal(db.calls.length, 0);
});

test('partial database failures preserve applied outcomes and continue remaining categories', async () => {
  const db = fixture({ failCategory: b });
  const result = await run(db, config([a, b, c]));
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.result.categories.map(row => row.status), ['success', 'failed', 'success']);
  assert.equal(db.preferences.has(b), false);
  assert.match(result.error, /write failed/);
  const failed = await run(fixture({ readFailure: 'communication_category' }));
  assert.equal(failed.status, 'failed');
});

test('shared immediate executor dispatches multiple states and blocks guest/organisation targets', async () => {
  const db = fixture();
  const originals = { from: supabase.from, rpc: supabase.rpc };
  Object.assign(supabase, { from: db.from, rpc: db.rpc });
  const workflow = { id: 'workflow', tenant_id: 'tenant', entity_type: 'member', actions: [
    { type: 'update_field', config: config([a, b]) },
    { type: 'update_field', config: config([b], false) },
  ] };
  try {
    const results = await executeWorkflowActions(workflow, 'member', 'member', {}, '');
    assert.deepEqual(results.map(row => row.status), ['success', 'success']);
    assert.equal(db.preferences.get(b), false);
    assert.equal(db.writes.length, 0);
    const guest = await executeWorkflowActions(workflow, 'member', 'guest-booking', {}, '', { attendance: {}, actionEntityId: null });
    assert.ok(guest.every(row => row.status === 'skipped'));
    const foreign = await executeWorkflowActions(workflow, 'organization', 'member', {}, '');
    assert.ok(foreign.every(row => row.status === 'failed'));
    assert.equal(db.calls.length, 3);
  } finally { Object.assign(supabase, originals); }
});

test('scheduled and backfill paths log per-category partial results; dry run writes nothing', async () => {
  for (const trigger of ['scheduled', 'manual_backfill']) {
    const db = fixture({ failCategory: b });
    const originals = { from: supabase.from, rpc: supabase.rpc };
    Object.assign(supabase, { from: db.from, rpc: db.rpc });
    const workflow = { id: 'workflow', tenant_id: 'tenant', entity_type: 'member', conditions: [],
      actions: [{ type: 'update_field', config: config([a, b]) }] };
    try {
      await runScheduledWorkflow(workflow, '', { dryRun: true, logTriggerType: trigger });
      assert.equal(db.calls.length, 0);
      assert.equal(db.logs.length, 0);
      const summary = await runScheduledWorkflow(workflow, '', { logTriggerType: trigger });
      assert.equal(summary.executed, 1);
      assert.equal(summary.errors, 1);
      assert.equal(db.logs[0].status, 'partial');
      assert.equal(db.logs[0].trigger_data.trigger_type, trigger);
      assert.deepEqual(db.logs[0].actions_executed[0].result.categories.map(row => row.status), ['success', 'failed']);
    } finally { Object.assign(supabase, originals); }
  }
});

test('legacy core/custom field updates still use their existing write paths', async () => {
  const db = fixture();
  const originals = { from: supabase.from, rpc: supabase.rpc };
  Object.assign(supabase, { from: db.from, rpc: db.rpc });
  try {
    const results = await executeWorkflowActions({ id: 'workflow', tenant_id: 'tenant',
      actions: [
        { type: 'update_field', config: { field_type: 'core', field_id: 'status', value: 'active' } },
        { type: 'update_field', config: { field_type: 'custom', field_id: a, value: 'custom value' } },
      ],
    }, 'member', 'member', {}, '', { chain: { depth: 99, visited: [] } });
    assert.equal(results[0].status, 'success');
    assert.ok(db.writes.some(write => write.table === 'member' && write.row.status === 'active'));
    assert.equal(results[1].status, 'success');
    assert.ok(db.writes.some(write => write.table === 'member_preference_value' && write.row.value === 'custom value'));
    assert.equal(db.calls.length, 0);
  } finally { Object.assign(supabase, originals); }
});

test('record-update event entry point executes and logs selected subscriptions only', async () => {
  const workflow = { id: 'workflow', name: 'Subscriptions', tenant_id: 'tenant', entity_type: 'member',
    trigger_type: 'record_update', is_active: true, trigger_config: {}, conditions: [],
    actions: [{ type: 'update_field', config: config([a, b]) }] };
  const db = fixture({ workflows: [workflow] });
  const originals = { from: supabase.from, rpc: supabase.rpc };
  Object.assign(supabase, { from: db.from, rpc: db.rpc });
  try {
    await triggerWorkflows('member', 'member', { tenant_id: 'tenant' }, { tenant_id: 'tenant' }, 'field_change', 'https://fixture.invalid');
    assert.equal(db.calls.length, 2);
    assert.equal(db.preferences.get(c), true);
    assert.equal(db.logs[0].status, 'success');
    assert.equal(db.logs[0].actions_executed[0].result.categories.length, 2);
  } finally { Object.assign(supabase, originals); }
});
