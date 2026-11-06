import test from 'node:test';
import assert from 'node:assert/strict';
import { formBundlesHandler } from './form-bundles.js';
const id = '20000000-0000-4000-8000-000000000001';
const baseForm = { id: 'f', tenant_id: 't', is_active: true, fields: [
  { id: 'b', type: 'sales_bundle', allowed_bundle_ids: [id] },
] };
async function request(form, { member = null, access = true, rows = [] } = {}) {
  const queries = [];
  const db = { from(table) {
    const q = { select() { return this; }, eq(k,v) { queries.push([table,k,v]); return this; },
      in() { return this; }, maybeSingle() { return this; },
      then(resolve) { resolve({ data: table === 'form' ? form : rows }); } };
    return q;
  } };
  const res = { setHeader() {}, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
  await formBundlesHandler({ method: 'GET', query: { form_id: 'f', field_id: 'b' } }, res, {
    db, resolveTenant: async () => ({ id: 't' }), resolveAccess: async () => ({ allowed: access }),
    getSessionMember: async () => member, getTenantContext: async () => ({}),
  });
  return { res, queries };
}
test('form bundle options require persisted form and tenant context', async () => {
  const { res, queries } = await request(baseForm);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { items: [] });
  assert.ok(queries.some(([table,k,v]) => table === 'form' && k === 'tenant_id' && v === 't'));
  assert.equal((await request(null)).res.statusCode, 404);
});
test('private form options deny guests and cross-tenant members', async () => {
  const form = { ...baseForm, require_authentication: true };
  assert.equal((await request(form)).res.statusCode, 403);
  assert.equal((await request(form, { member: { tenant_id: 'other' } })).res.statusCode, 403);
  assert.equal((await request(form, { member: { tenant_id: 't' } })).res.statusCode, 200);
});
test('surveys and unavailable forms never expose catalogue options', async () => {
  assert.equal((await request({ ...baseForm, form_type: 'survey' })).res.statusCode, 404);
  assert.equal((await request({ ...baseForm, deactivate_at: '2000-01-01' })).res.statusCode, 404);
});
