import assert from 'node:assert/strict';
import test from 'node:test';
import issueHandler from './applicant-continuation.js';
import verifyHandler from '../public/form-applicant-continuation.js';

function database(rows) {
  const writes = [];
  return {
    writes,
    from(table) {
      const filters = [];
      let payload;
      const query = {
        select() { return query; },
        eq(k, v) { filters.push(r => r[k] === v); return query; },
        order() { return query; },
        range() { return query; },
        insert(value) { payload = value; return query; },
        async maybeSingle() {
          return { data: (rows[table] || []).find(r => filters.every(f => f(r))) || null, error: null };
        },
        then(resolve, reject) {
          if (payload) {
            writes.push({ table, payload });
            (rows[table] ||= []).push({ id: 'grant-1', ...payload });
            return Promise.resolve({ data: null, error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: (rows[table] || []).filter(r => filters.every(f => f(r))), error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}
async function invoke(handler, body, dependencies) {
  const res = { statusCode: 200, headers: {}, setHeader(k,v) { this.headers[k]=v; },
    status(v) { this.statusCode=v; return this; }, json(v) { this.body=v; return this; } };
  await handler({ method: 'POST', body, headers: {} }, res, dependencies);
  return res;
}
function fixture() {
  const form = { id: 'form', tenant_id: 'tenant', is_active: true,
    mutation_access_policy: { version: 1, mode: 'applicant_continuation' },
    entity_pipelines: { organisations: [{ mappings: [{ source_type:'static', static_value:'changed',
      target_type:'core', target_field:'phone' }] }], members: [] } };
  const rows = { form: [form], organization: [{ id: 'org', tenant_id: 'tenant' },
    { id: 'foreign-org', tenant_id: 'other' }], member: [{ id: 'member', tenant_id:'tenant', organization_id:'org' },
    { id:'foreign-member',tenant_id:'other',organization_id:'org' }] };
  const db = database(rows);
  return { rows, db, dependencies: { supabase: db,
    getTenantContext: async () => ({ tenantId:'tenant' }), hasAdminAccess: async () => true } };
}
test('client administrator/identity claims cannot mint applicant authority', async () => {
  const { db, dependencies } = fixture();
  const res = await invoke(issueHandler, { form_id:'form', organization_id:'org', is_admin:true,
    verified_admin_access:true, verified_organization_id:'org' },
  { ...dependencies, hasAdminAccess: async () => false });
  assert.equal(res.statusCode,403);
  assert.equal(db.writes.length,0);
});
test('issuance is tenant scoped and stores a hash, never a raw bearer', async () => {
  const { db, rows, dependencies } = fixture();
  const denied = await invoke(issueHandler, { form_id:'form',organization_id:'foreign-org' }, dependencies);
  assert.equal(denied.statusCode,403);
  assert.equal(db.writes.length,0);
  const res = await invoke(issueHandler, { form_id:'form',organization_id:'org' }, dependencies);
  assert.equal(res.statusCode,201);
  assert.equal(res.headers['Cache-Control'],'no-store');
  assert.match(res.body.applicant_continuation_token,/^[A-Za-z0-9_-]{43}$/);
  const stored = rows.form_applicant_continuation[0];
  assert.equal(JSON.stringify(stored).includes(res.body.applicant_continuation_token),false);
  assert.deepEqual(stored.member_ids,['member']);
  const verified = await invoke(verifyHandler, {
    form_id:'form',applicant_continuation_token:res.body.applicant_continuation_token,
  }, { supabase:db, tenantData:{id:'tenant'} });
  assert.equal(verified.statusCode,200);
  assert.equal(verified.body.organization_id,'org');
  assert.equal(verified.body.applicant_continuation_token,undefined);
  stored.revoked_at = new Date().toISOString();
  assert.equal((await invoke(verifyHandler, {
    form_id:'form',applicant_continuation_token:res.body.applicant_continuation_token,
  }, { supabase:db,tenantData:{id:'tenant'} })).statusCode,403);
});