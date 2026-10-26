import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverAnnualExpiryRoleEvents as deliver } from './annualExpiryRoleDelivery.js';
import { triggerWorkflows } from './workflows.js';
import { supabase } from './database.js';

const event = (id = 'a', tenant = 'tenant') => ({
  id, tenant_id: tenant, member_id: `m-${id}`, role_event_state: 'pending',
  role_event_before: { id: `m-${id}`, tenant_id: tenant, role_id: 'paid', first_name: 'Fixture' },
  role_event_after: { id: `m-${id}`, tenant_id: tenant, role_id: 'former', first_name: 'Fixture' },
});
const key = id => `annual-expiry-role:tenant:${id}`;
function database(events, claims = [], workflows = []) {
  const tables = { membership_expiry_action: events, workflow_delivery_claim: claims, workflow: workflows, workflow_log: [] };
  const db = { tables, failSave: false, from(table) {
    assert.ok(table in tables, `Unexpected database access: ${table}`);
    const filters = []; let op, values, max = 100;
    const q = {
      select() { return q; }, eq(k,v) { filters.push(r => r[k] === v); return q; },
      in(k,v) { filters.push(r => v.includes(r[k])); return q; },
      gt(k,v) { filters.push(r => r[k] > v); return q; },
      order() { return q; }, limit(n) { max = Math.min(2, n); return q; },
      insert(v) { op = 'insert'; values = v; return q; },
      update(v) { op = 'update'; values = v; return q; },
      delete() { op = 'delete'; return q; },
      async run(single = false) {
        if (op === 'update' && table === 'membership_expiry_action' && db.failSave) return { error: { message: 'interrupted save' } };
        let rows = tables[table].filter(r => filters.every(f => f(r)));
        if (op === 'insert') {
          if (table === 'workflow_delivery_claim' && tables[table].some(r => r.delivery_key === values.delivery_key)) return { error: { code: '23505' } };
          rows = [structuredClone(values)]; tables[table].push(...rows);
        }
        if (op === 'update') rows.forEach(r => Object.assign(r, values));
        if (op === 'delete') tables[table] = tables[table].filter(r => !rows.includes(r));
        return { data: structuredClone(single ? rows[0] || null : rows.slice(0, max)), error: null };
      },
      maybeSingle() { return q.run(true); },
      then(resolve,reject) { return q.run().then(resolve,reject); },
    }; return q;
  } }; return db;
}
const options = () => ({ tenantId: 'tenant', results: { details: [] } });
const baseUrl = async () => 'https://tenant.example.test';

test('actual dispatcher matches role change and conditions using full before/after values, with tenant isolation', async () => {
  const workflow = { id: 'w', tenant_id: 'tenant', name: 'Former', is_active: true, entity_type: 'member',
    trigger_type: 'field_change', trigger_config: { field_type: 'core', field_id: 'role_id', operator: 'changed_to', value: 'former' },
    conditions: [], trigger_mode: 'every_time' };
  const db = database([event(), event('foreign','other')], [], [
    workflow, { ...workflow, id: 'disabled', is_active: false }, { ...workflow, id: 'foreign', tenant_id: 'other' },
    { ...workflow, id: 'mismatch', trigger_config: { ...workflow.trigger_config, value: 'paid' } },
  ]);
  const original = supabase.from; supabase.from = db.from;
  const calls = [];
  try {
    const dispatch = (...args) => {
      assert.deepEqual(args.slice(0,6), ['member','m-a',event().role_event_before,event().role_event_after,'field_change','https://tenant.example.test']);
      assert.equal(args[6].systemInitiated, true);
      return triggerWorkflows(...args.slice(0,6), { ...args[6], executeWorkflowActions: async (w) => {
        calls.push(w.id); return [{ action_type: 'fixture', status: 'success' }];
      } });
    };
    await deliver(db, options(), { dispatch, baseUrl });
    await deliver(db, options(), { dispatch, baseUrl });
    assert.deepEqual(calls,['w']);
    assert.equal(db.tables.workflow_log[0].trigger_data.before.role_id,'paid');
    assert.equal(db.tables.workflow_log[0].trigger_data.after.role_id,'former');
    assert.equal(db.tables.membership_expiry_action[1].role_event_state,'pending');
  } finally { supabase.from = original; }
});

test('interruption after dispatcher completion recovers without repeating actions', async () => {
  const db = database([event()]); let calls = 0;
  const dispatch = async () => {
    calls++; db.tables.workflow_delivery_claim.push({ tenant_id: 'tenant', delivery_key: key('a'), status: 'completed' });
    db.failSave = true; return { delivery: { status: 'completed' } };
  };
  await assert.rejects(deliver(db, options(), { dispatch, baseUrl }), /interrupted save/);
  db.failSave = false;
  await deliver(db, options(), { dispatch, baseUrl });
  assert.equal(calls,1); assert.equal(db.tables.membership_expiry_action[0].role_event_state,'completed');
});

test('uncertain processing and failed claims are retained without blocking unrelated events', async () => {
  const db = database([event('a'),event('b'),event('c')], ['a','b'].map((id,i) => ({
    tenant_id: 'tenant', delivery_key: key(id), status: i ? 'failed' : 'processing',
  })));
  let calls = 0; const opts = options();
  const outcome = await deliver(db, opts, { baseUrl, dispatch: async () => { calls++; return { delivery: { status: 'completed' } }; } });
  assert.equal(outcome.unresolvedRoleEvents, 2);
  assert.equal(calls,1); assert.equal(opts.results.errors,2);
  assert.deepEqual(db.tables.membership_expiry_action.map(e=>e.role_event_state), ['review','review','completed']);
});

test('safe pre-dispatch failure retries, while an ambiguous dispatch does not', async () => {
  for (const ambiguous of [false,true]) {
    const db = database([event()]); let calls = 0;
    const dispatch = async () => {
      calls++;
      if (calls === 1) {
        if (ambiguous) db.tables.workflow_delivery_claim.push({ tenant_id: 'tenant', delivery_key: key('a'), status: 'processing' });
        throw new Error('interrupted');
      }
      return { delivery: { status: 'completed' } };
    };
    await deliver(db, options(), { dispatch, baseUrl });
    await deliver(db, options(), { dispatch, baseUrl });
    assert.equal(calls, ambiguous ? 1 : 2);
    assert.equal(db.tables.membership_expiry_action[0].role_event_state, ambiguous ? 'review' : 'completed');
  }
});
