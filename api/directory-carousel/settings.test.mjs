import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler } from './settings.js';

function fixture({ rows = [], admin = true, context, fail = false } = {}) {
  const calls = [];
  const db = { from(table) {
    assert.equal(table, 'system_settings');
    const query = {
      select() { return query; },
      eq(key, value) { calls.push([key, value]); return query; },
      limit() { return Promise.resolve({ data: rows, error: fail ? {} : null }); },
      update(value) { calls.push(['update', value]); return query; },
      insert(value) { calls.push(['insert', value]); return query; },
      then(resolve) { return Promise.resolve({ error: fail ? {} : null }).then(resolve); },
    };
    return query;
  } };
  const handler = createHandler({
    db, getTenantContext: async () => context || { isAuthenticated: true, tenantId: 'tenant-a' },
    hasAdminAccess: async () => admin,
  });
  return { calls, async request({ method = 'GET', source = 'primary-member', body } = {}) {
    const res = {
      code: 200, setHeader() {}, status(code) { this.code = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await handler({ method, query: { source }, body }, res);
    return res;
  } };
}

test('primary permissions load default-off and only exact true grants consent', async () => {
  for (const value of [undefined, null, 'false', true, 'TRUE', '1', '{}']) {
    assert.deepEqual((await fixture({ rows: value === undefined ? [] : [{ setting_value: value }] }).request()).body, { enabled: false });
  }
  assert.deepEqual((await fixture({ rows: [{ setting_value: 'true' }] }).request()).body, { enabled: true });
  assert.equal((await fixture({ rows: [{}, {}] }).request()).code, 409);
});

test('only admins with an unambiguous tenant may read/write permission', async () => {
  assert.equal((await fixture({ admin: false }).request()).code, 403);
  assert.equal((await fixture({ context: { isAuthenticated: false } }).request()).code, 401);
  assert.equal((await fixture({ context: { isAuthenticated: true, tenantId: 't', tenantMismatch: true } }).request()).code, 403);
  assert.equal((await fixture().request({ source: 'dynamic' })).code, 400);
  assert.equal((await fixture().request({ source: '__proto__' })).code, 400);
  assert.equal((await fixture().request({ method: 'DELETE' })).code, 405);
});

test('primary writes persist strict consent to the session tenant and selected source', async () => {
  for (const enabled of [true, false]) {
    const f = fixture();
    const res = await f.request({ method: 'PUT', source: 'primary-organization', body: { enabled, tenant_id: 'attacker' } });
    assert.deepEqual(res.body, { enabled });
    const insert = f.calls.find(call => call[0] === 'insert')[1];
    assert.equal(insert.tenant_id, 'tenant-a');
    assert.equal(insert.setting_key, 'org_directory_public_carousel_enabled');
    assert.equal(insert.setting_value, String(enabled));
  }
  for (const enabled of [undefined, null, 'true', 1]) {
    assert.equal((await fixture().request({ method: 'PUT', body: { enabled } })).code, 400);
  }
  assert.equal((await fixture({ fail: true }).request()).code, 503);
});
