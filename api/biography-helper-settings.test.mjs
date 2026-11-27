import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import handler from './biography-helper-settings.js';
import { rejectGenericBiographyHelperWrite } from './_lib/biographyHelperEntityBoundary.js';
import { BIOGRAPHY_HELPER_SETTING_KEY as key, DEFAULT_BIOGRAPHY_HELPER_TEXT as defaultText } from '../shared/biographyHelperText.js';

function response() {
  return { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
function fixture() {
  const rows = new Map();
  const state = { tenantId: 'a', isAuthenticated: true, admin: true, writes: 0, fail: null };
  const db = { from(table) {
    assert.equal(table, 'system_settings');
    const filters = {};
    let pending;
    const q = {
      eq(k, v) { filters[k] = v; return q; },
      select() { return q; },
      insert(row) { pending = row; return q; },
      update(row) { pending = row; return q; },
      async single() {
        if (state.fail === 'write') return { error: { code: '42501', message: 'private provider detail' } };
        if (state.fail === 'unconfirmed') return { data: null };
        if (state.fail === 'conflict') return { error: { code: '23505' } };
        state.writes++;
        const tenantId = pending.tenant_id || filters.tenant_id;
        assert.ok(tenantId);
        rows.set(tenantId, { ...rows.get(tenantId), id: tenantId, ...pending });
        return { data: { setting_value: pending.setting_value } };
      },
      async maybeSingle() {
        assert.ok(filters.tenant_id, 'every read is tenant-scoped');
        if (state.fail === 'read') return { error: { code: '42501', message: 'private provider detail' } };
        const row = rows.get(filters.tenant_id);
        return { data: row && (!filters.id || filters.id === row.id) ? row : null };
      },
    };
    return q;
  } };
  const deps = { db, getTenantContext: async () => ({ ...state }), hasAdminAccess: async () => state.admin };
  async function request(method = 'GET', helperText, extra = {}) {
    const res = response();
    await handler({ method, body: { helperText, ...extra } }, res, deps);
    return res;
  }
  return { rows, state, db, deps, request };
}

test('default, custom, blank, reset and literal plain text persist only in the session tenant', async () => {
  const f = fixture();
  assert.equal((await f.request()).body.helperText, defaultText);
  assert.match((await f.request()).headers['Cache-Control'], /no-store/);
  const literal = '<b>Biography</b> & <script>alert(1)</script>';
  assert.equal((await f.request('PUT', `  ${literal}  `, { tenantId: 'b' })).body.helperText, literal);
  assert.equal((await f.request()).body.helperText, literal);
  f.state.tenantId = 'b';
  assert.equal((await f.request()).body.helperText, defaultText);
  await f.request('PUT', 'Tenant B');
  f.state.tenantId = 'a';
  assert.equal((await f.request()).body.helperText, literal);
  for (const blank of [' ', '\n\t', '']) {
    assert.equal((await f.request('PUT', blank)).body.helperText, defaultText);
    assert.equal((await f.request()).body.helperText, defaultText);
  }
  assert.equal(f.rows.get('b').setting_value, 'Tenant B');
});
test('members can read but cannot write; guest, missing and mismatched tenant requests fail closed', async () => {
  const f = fixture();
  f.state.admin = false;
  assert.equal((await f.request()).body.helperText, defaultText);
  assert.equal((await f.request('PUT', 'No')).code, 403);
  assert.equal(f.state.writes, 0);
  f.state.isAuthenticated = false;
  assert.equal((await f.request()).code, 401);
  f.state.isAuthenticated = true;
  f.state.tenantMismatch = true;
  assert.equal((await f.request()).code, 403);
  f.state.tenantMismatch = false;
  f.state.tenantId = null;
  assert.equal((await f.request('PUT', 'No')).code, 403);
});
test('invalid types/length, read errors, failed and unconfirmed writes never report success', async () => {
  const f = fixture();
  for (const invalid of [null, undefined, 42, {}, ['text'], 'a'.repeat(1001)]) {
    assert.equal((await f.request('PUT', invalid)).code, 400);
  }
  await f.request('PUT', 'Saved');
  for (const failure of ['write', 'unconfirmed', 'read']) {
    f.state.fail = failure;
    const result = await f.request(failure === 'read' ? 'GET' : 'PUT', 'Unsaved');
    assert.equal(result.code, 503);
    assert.ok(!JSON.stringify(result.body).includes('private provider'));
  }
  f.state.fail = null;
  assert.equal((await f.request()).body.helperText, 'Saved');
  f.state.fail = 'conflict';
  assert.equal((await f.request('PUT', 'Unsaved')).code, 409);
  f.state.fail = 'read';
  assert.equal((await f.request('PUT', 'Unsaved')).code, 503);
  assert.equal((await f.request('DELETE')).code, 405);
});
test('generic create, rename, value update and deletion cannot bypass the dedicated boundary', async () => {
  const f = fixture();
  await f.request('PUT', 'Protected');
  const call = async (method, body, id) => {
    const res = response();
    const blocked = await rejectGenericBiographyHelperWrite({
      entity: 'system_settings', req: { method, body }, id, res, db: f.db, context: f.state,
    });
    return { res, blocked };
  };
  for (const admin of [true, false]) {
    f.state.admin = admin;
    for (const body of [{ setting_key: key }, [{ setting_key: key }], { records: [{ setting_key: key }] }]) {
      assert.equal((await call('POST', body)).res.code, 403);
    }
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      assert.equal((await call(method, { setting_key: 'renamed', setting_value: 'bypass' }, 'a')).res.code, 403);
    }
  }
  f.state.fail = 'read';
  assert.equal((await call('DELETE', {}, 'a')).res.code, 503);
  f.state.fail = null;
  f.state.tenantId = 'b';
  assert.equal((await call('PATCH', { setting_value: 'Other' }, 'a')).blocked, false, 'cannot read another tenant’s protected row');
  for (const file of ['index.js', '[id].js']) {
    assert.match(readFileSync(new URL(`./entities/[entity]/${file}`, import.meta.url), 'utf8'), /await rejectGenericBiographyHelperWrite\(/);
  }
});
