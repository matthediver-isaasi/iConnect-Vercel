import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './member-affiliation-settings.js';
import { emptyProfileFormPolicy, profileFormMetadata } from './_lib/profileAffiliationForms.js';
import { allAffiliationRows } from './_lib/formAffiliationReview.js';

const tenant = '00000000-0000-4000-8000-000000000001';
const formId = '00000000-0000-4000-8000-000000000002';
function fixture() {
  const state = { policy: { version: 0, config: emptyProfileFormPolicy() }, writes: 0, failure: null };
  const logs = [];
  const rows = {
    preference_field: [{ id: 'country', label: 'Country', options: ['UK'], entity_scope: 'member', is_active: true },
      { id: 'org', entity_scope: 'organization' }, { id: 'object', custom_object_id: 'object' }],
    form: [{ id: formId, name: 'Update affiliations', form_type: 'standard', is_active: true,
      require_authentication: true, mutation_access_policy: { mode: 'authenticated_owner' },
      member_affiliation_enabled: true, fields: [] }],
    form_member_affiliation_config: [{ form_id: formId, config: { purpose: 'profile', enabled: true } }],
  };
  const db = {
    from(table) {
      let order;
      const q = {
        select(projection, options) {
          if (rows[table]) assert.equal(options.count, 'exact');
          if (table === 'preference_field') assert.equal(projection, 'id,label,options,entity_scope,custom_object_id,is_active');
          return q;
        },
        eq(key, value) { assert.equal(key, 'tenant_id'); assert.equal(value, tenant); return q; },
        order(key) { order = key; return q; },
        async range(start, end) {
          if (state.failure === table) return { error: { code: '42501', message: 'SECRET private form content', details: 'SECRET' } };
          if (table === 'form_member_affiliation_config' && order !== 'form_id') {
            return { error: { code: '42703', message: 'column form_member_affiliation_config.id does not exist' } };
          }
          assert.equal(order, table === 'form_member_affiliation_config' ? 'form_id' : 'id');
          return { data: rows[table].slice(start, end + 1), count: rows[table].length };
        },
        async maybeSingle() { return { data: structuredClone(state.policy) }; },
      };
      return q;
    },
    async rpc(name, args) {
      assert.equal(name, 'profile_affiliation_form_policy_save');
      assert.equal(args.p_tenant, tenant);
      if (args.p_version !== state.policy.version) return { error: { code: '40001' } };
      state.writes++;
      state.policy = { version: state.policy.version + 1, config: args.p_config };
      return { data: structuredClone(state.policy) };
    },
  };
  const deps = { db, getTenantContext: async () => ({ isAuthenticated: true, tenantId: tenant }),
    hasAdminAccess: async () => true, logger: { error: (...args) => logs.push(args) } };
  async function request(method = 'GET', body) {
    const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method, query: { mode: 'forms' }, body }, res, deps);
    return res;
  }
  return { state, rows, db, deps, logs, request };
}
test('real configuration key contract loads populated metadata and saves/reloads isolated routing', async () => {
  const f = fixture();
  const loaded = await f.request();
  assert.equal(loaded.code, 200);
  assert.deepEqual(loaded.body.metadata.fields.at(-1), { id: 'custom:country', label: 'Country', options: ['UK'] });
  assert.equal(loaded.body.metadata.fields.length, 4);
  assert.equal(loaded.body.metadata.forms[0].eligible, true);
  for (const enabled of [false, true, false]) {
    const saved = await f.request('PUT', { version: f.state.policy.version,
      config: { ...emptyProfileFormPolicy(), enabled, fallbackFormId: formId } });
    assert.equal(saved.code, 200);
    assert.deepEqual((await f.request()).body.config, saved.body.config);
  }
  assert.equal((await f.request('PUT', { version: 0, config: emptyProfileFormPolicy() })).code, 409);
  assert.equal(f.state.writes, 3);
});
test('discovery failures stay closed with safe operation and cause code; retry recovers', async () => {
  const f = fixture();
  f.state.failure = 'form_member_affiliation_config';
  const failed = await f.request();
  assert.equal(failed.code, 503);
  assert.equal(failed.body.metadata, undefined);
  assert.deepEqual(f.logs[0][1], { operation: 'forms.affiliation_configs', method: 'GET', code: '42501' });
  assert.ok(!JSON.stringify([failed.body, f.logs]).includes('SECRET'));
  f.state.failure = null;
  assert.equal((await f.request()).code, 200);
});
test('unavailable forms remain visible with reasons and cannot be saved', async () => {
  const f = fixture();
  f.rows.form[0].is_active = false;
  assert.match((await f.request()).body.metadata.forms[0].reason, /activate/);
  assert.equal((await f.request('PUT', { version: 0,
    config: { ...emptyProfileFormPolicy(), enabled: true, fallbackFormId: formId } })).code, 400);
  assert.equal(f.state.writes, 0);
});
test('unauthenticated, mismatched and non-admin requests never read metadata or save', async () => {
  for (const method of ['GET', 'PUT']) for (const kind of ['guest', 'tenant', 'member']) {
    const f = fixture();
    f.deps.db = { from() { assert.fail('unauthorized read'); } };
    f.deps.getTenantContext = async () => ({ tenantId: tenant, isAuthenticated: kind !== 'guest', tenantMismatch: kind === 'tenant' });
    f.deps.hasAdminAccess = async () => kind !== 'member';
    assert.equal((await f.request(method)).code, 403);
  }
});
test('configuration pagination uses form_id on every page and retains complete counts', async () => {
  const f = fixture();
  f.rows.form_member_affiliation_config = Array.from({ length: 1001 }, (_, i) => ({ form_id: String(i), config: {} }));
  assert.equal((await profileFormMetadata(f.db, tenant)).forms.length, 1);
  await assert.rejects(allAffiliationRows(() => ({
    order() { return this; }, range: async () => ({ data: [], count: 1 }),
  })), /changed while loading/);
  const cause = { code: '42703', message: 'private' };
  await assert.rejects(allAffiliationRows(() => ({
    order() { return this; }, range: async () => ({ error: cause }),
  })), error => error.cause === cause && !error.message.includes('private'));
});
