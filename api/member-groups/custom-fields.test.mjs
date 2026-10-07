import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import handler from './custom-fields.js';
import { validateGroupValueWrite, projectGroupCustomFields } from '../_lib/memberGroupCustomFields.js';
import { PUBLIC_DIRECTORY_GROUP_SELECT, PUBLIC_SELECTED_GROUP_SELECT } from '../public/member-groups.js';

const id = '00000000-0000-0000-0000-000000000001';
const field = { id, name: 'Count', type: 'number', choices: [], show_on_detail: false };
function fixture(fields = [field], schemaError = null) {
  const calls = [];
  const db = {
    from(table) {
      const filters = {};
      return { select() { return this; }, eq(k, v) { filters[k] = v; return this; }, async limit() { return { error: schemaError }; },
        async maybeSingle() {
          calls.push({ table, filters });
          return { data: filters.tenant_id === 'tenant-a' ? { setting_value: JSON.stringify({ fields, revision: 1 }) } : null };
        } };
    },
    async rpc(name, args) { calls.push({ name, args }); return {}; },
  };
  return { db, calls };
}
async function request(body, { method = 'PUT', ctx = { tenantId: 'tenant-a', isAuthenticated: true }, admin = true, fields, schemaError } = {}) {
  const { db, calls } = fixture(fields, schemaError);
  const res = { statusCode: 200, setHeader() {}, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } };
  await handler({ method, body }, res, { supabase: db, getTenantContext: async () => ctx, hasAdminAccess: async () => admin });
  return { res, calls };
}
test('unmigrated schema explicitly disables custom fields without breaking legacy empty-value saves', async () => {
  const schemaError = { code: '42703', message: 'column custom_field_values does not exist' };
  const read = await request(null, { method: 'GET', schemaError });
  assert.deepEqual(read.res.body, { available: false, fields: [], revision: 0 });
  assert.equal((await request({ fields: [], revision: 0 }, { schemaError })).res.statusCode, 503);
  const { db } = fixture([], schemaError);
  const ctx = { tenantId: 'tenant-a', isAuthenticated: true };
  const body = { name: 'Legacy', custom_field_values: {} };
  await validateGroupValueWrite(db, ctx, body, async () => true);
  assert.deepEqual(body, { name: 'Legacy' });
  await assert.rejects(validateGroupValueWrite(db, ctx, { custom_field_values: { [id]: 1 } }, async () => true), { status: 503 });
  assert.equal((await request(null, { method: 'GET', schemaError: { code: '08006', message: 'Disconnected' } })).res.statusCode, 500, 'outages never count as an unmigrated schema');
});
test('definitions discovery is admin-only and tenant-bound', async () => {
  assert.equal((await request(null, { method: 'GET' })).res.body.fields[0].id, id);
  assert.equal((await request(null, { method: 'GET', admin: false })).res.statusCode, 403);
  assert.equal((await request(null, { ctx: {} })).res.statusCode, 401);
  assert.equal((await request(null, { ctx: { tenantId: 'a', isAuthenticated: true, tenantMismatch: true } })).res.statusCode, 409);
});
test('rename and visibility retain IDs, new fields get server-owned IDs', async () => {
  const { res, calls } = await request({ revision: 1, fields: [{ ...field, name: 'New name', show_on_detail: true }, { name: 'New field', type: 'text' }] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.fields[0].id, id);
  assert.match(res.body.fields[1].id, /^[0-9a-f-]{36}$/);
  assert.equal(res.body.fields[1].show_on_detail, false);
  assert.equal(calls.at(-1).args.p_tenant, 'tenant-a');
});
test('reject foreign IDs, destructive changes, stale saves and unconfirmed deletion', async () => {
  for (const body of [
    { revision: 1, fields: [{ ...field, id: '00000000-0000-0000-0000-000000000002' }] },
    { revision: 1, fields: [{ ...field, type: 'text' }] },
    { revision: 1, fields: [] },
  ]) {
    const result = await request(body);
    assert.equal(result.res.statusCode, 400);
    assert.ok(!result.calls.some(c => c.name));
  }
  assert.equal((await request({ revision: 0, fields: [field] })).res.statusCode, 409);
  assert.equal((await request({ revision: 1, fields: [], confirmedDeletedIds: [id] })).res.statusCode, 200);
  const select = { ...field, type: 'select', choices: ['A','B'] };
  assert.equal((await request({ revision: 1, fields: [{ ...select, choices: ['A'] }] }, { fields: [select] })).res.statusCode, 400);
  assert.equal((await request({ revision: 1, fields: [{ ...select, choices: ['A','B','C'] }] }, { fields: [select] })).res.statusCode, 200);
});
test('group values preserve omission, explicit clearing and private read boundaries', async () => {
  const { db, calls } = fixture();
  const ctx = { tenantId: 'tenant-a', isAuthenticated: true };
  const body = { description: 'Unrelated' };
  await validateGroupValueWrite(db, ctx, body, async () => true);
  assert.equal(calls.length, 0);
  await assert.rejects(validateGroupValueWrite(db, ctx, { custom_field_values: {} }, async () => false), /administrator/);
  await assert.rejects(validateGroupValueWrite(db, { ...ctx, tenantId: 'tenant-b' }, { custom_field_values: { [id]: 0 } }, async () => true), /Unknown/);
  const clear = { custom_field_values: {} };
  await validateGroupValueWrite(db, ctx, clear, async () => true);
  assert.deepEqual(clear.custom_field_values, {});
  const row = { id: 'group', custom_field_values: { [id]: 0 } };
  const [safe] = await projectGroupCustomFields(db, ctx, [row], async () => false);
  assert.equal(Object.hasOwn(safe, 'custom_field_values'), false);
  assert.deepEqual(safe.custom_fields_display, []);
  assert.deepEqual((await projectGroupCustomFields(db, ctx, [row], async () => true))[0].custom_field_values, { [id]: 0 });
  const publicDb = fixture([{ ...field, show_on_detail: true }]).db;
  assert.equal((await projectGroupCustomFields(publicDb, ctx, [row], async () => false))[0].custom_fields_display[0].value, 0);
});
test('generic routes close definition CRUD/rename and alias projection bypasses; public lists remain allowlisted', () => {
  for (const file of ['index.js','[id].js']) {
    const source = readFileSync(new URL(`../entities/[entity]/${file}`, import.meta.url), 'utf8');
    assert.match(source, /DEDICATED_ORGANISATION_DIRECTORY_SETTINGS = new Set\(\[\s*GROUP_FIELDS_KEY/);
    assert.match(source, /validateGroupValueWrite/);
    assert.match(source, /projectGroupCustomFields/);
    assert.match(source, /delete req.query.expand/);
  }
  const byId = readFileSync(new URL('../entities/[entity]/[id].js', import.meta.url), 'utf8');
  assert.match(byId, /DEDICATED_ORGANISATION_DIRECTORY_SETTINGS.has\(directorySetting/);
  for (const select of [PUBLIC_DIRECTORY_GROUP_SELECT, PUBLIC_SELECTED_GROUP_SELECT]) assert.doesNotMatch(select, /custom_field_values|\*/);
  assert.doesNotMatch(readFileSync(new URL('../public/system-settings.js', import.meta.url), 'utf8'), /['"]member_group_custom_fields['"]/);
});
