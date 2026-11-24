import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memberBalancesVisible } from '../shared/memberBalancesVisibility.js';
import { memberCpdPresentation, validateMemberCpdPresentation, MEMBER_CPD_LABEL_MAX_LENGTH } from '../shared/memberCpdPresentation.js';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace('export default async function handler', 'async function handler');
const response = () => ({
  statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});
function fixture() {
  const state = { tenantId: 'a', role: 'admin', rows: { a: { unrelated: 123 }, b: { show_member_balances_tab: false } } };
  const db = { from(table) {
    assert.equal(table, 'tenant');
    let id, update;
    return {
      select() { return this; }, eq(key, value) { assert.equal(key, 'id'); id = value; return this; },
      update(value) { update = value; return this; },
      async single() {
        if (state.fail) return { error: new Error('offline') };
        if (update) state.rows[id] = update.settings;
        return { data: { id, settings: state.rows[id] } };
      },
    };
  } };
  const getUser = async () => state.tenantId ? { tenant_id: state.tenantId, role: state.role } : null;
  const patch = new Function('getSessionTenantUser', 'supabase', 'clearTenantCache', 'clearTenantEmailCache', 'validateMemberAiAssistant', 'validateMemberCpdPresentation',
    `${source('./admin/tenant.js')}; return handler;`)(getUser, db, () => {}, () => {}, () => {}, validateMemberCpdPresentation);
  const read = new Function('supabase', 'getTenantContext', 'memberBalancesVisible', 'memberCpdPresentation',
    `${source('./member-record-preferences.js')}; return handler;`)(
    db, async () => ({ isAuthenticated: !!state.tenantId, tenantId: state.tenantId, tenantMismatch: state.mismatch }), memberBalancesVisible, memberCpdPresentation);
  async function call(handler, body, headers = {}) {
    const res = response();
    await handler({ method: handler === patch ? 'PATCH' : 'GET', headers, body }, res);
    return res;
  }
  return { state, patch: (value, headers) => call(patch, { settings: value }, headers), read: headers => call(read, null, headers) };
}
test('visible only for a loaded absent or true preference', () => {
  assert.equal(memberBalancesVisible(undefined), false);
  assert.equal(memberBalancesVisible({}), true);
  for (const value of [false, null, 'true', 1]) assert.equal(memberBalancesVisible({ show_member_balances_tab: value }), false);
  assert.equal(memberBalancesVisible({ show_member_balances_tab: true }), true);
});
test('save and reload false/true, preserve unrelated settings and isolate tenants', async () => {
  const f = fixture();
  assert.deepEqual((await f.read()).body, { tenantId: 'a', show_member_balances_tab: true, ...memberCpdPresentation({}) });
  for (const value of [false, true]) {
    assert.equal((await f.patch({ show_member_balances_tab: value })).statusCode, 200);
    assert.equal((await f.read()).body.show_member_balances_tab, value);
    assert.equal(f.state.rows.a.unrelated, 123);
    assert.equal(f.state.rows.b.show_member_balances_tab, false);
  }
  f.state.tenantId = 'b';
  assert.equal((await f.read()).body.show_member_balances_tab, false);
});
test('CPD preferences default, normalize, save/reload and remain tenant scoped without changing balances', async () => {
  const f = fixture();
  assert.deepEqual(memberCpdPresentation(null), { show_member_cpd_points: true, member_cpd_tab_label: 'CPD points' });
  for (const role of ['owner', 'admin', 'super_admin']) {
    f.state.role = role;
    for (const visible of [false, true]) {
      const saved = await f.patch({ show_member_cpd_points: visible, member_cpd_tab_label: '  Learning & awards  ' });
      assert.equal(saved.statusCode, 200);
      const loaded = (await f.read()).body;
      assert.equal(loaded.show_member_cpd_points, visible);
      assert.equal(loaded.member_cpd_tab_label, 'Learning & awards');
      assert.equal(loaded.show_member_balances_tab, true);
      assert.equal(f.state.rows.a.unrelated, 123);
    }
  }
  for (const blank of ['', ' \t\n ']) {
    assert.equal((await f.patch({ member_cpd_tab_label: blank })).statusCode, 200);
    assert.equal((await f.read()).body.member_cpd_tab_label, 'CPD points');
  }
  assert.equal((await f.patch({ member_cpd_tab_label: '<b>Awards</b>' })).statusCode, 200);
  assert.equal((await f.read()).body.member_cpd_tab_label, '<b>Awards</b>');
  f.state.tenantId = 'b';
  assert.deepEqual((await f.read()).body, { tenantId: 'b', show_member_balances_tab: false, ...memberCpdPresentation({}) });
  assert.equal(f.state.rows.a.member_cpd_tab_label, '<b>Awards</b>');
});
test('CPD writes reject invalid types, long labels, non-admins and cross-tenant headers without changing settings', async () => {
  const f = fixture();
  for (const key of ['show_member_cpd_points', 'member_cpd_tab_label']) {
    const invalid = key === 'show_member_cpd_points' ? [null, 0, 'false', {}, []] : [null, false, 42, {}, [], 'x'.repeat(MEMBER_CPD_LABEL_MAX_LENGTH + 1)];
    for (const value of invalid) {
      assert.equal((await f.patch({ [key]: value })).statusCode, 400);
      assert.deepEqual(f.state.rows.a, { unrelated: 123 });
    }
    f.state.role = 'viewer';
    assert.equal((await f.patch({ [key]: key === 'show_member_cpd_points' ? false : 'Awards' })).statusCode, 403);
    f.state.role = 'admin';
    assert.equal((await f.patch({ [key]: key === 'show_member_cpd_points' ? false : 'Awards' }, { 'x-tenant-id': 'b' })).statusCode, 409);
    assert.deepEqual(f.state.rows.a, { unrelated: 123 });
  }
  assert.equal((await f.patch({ member_cpd_tab_label: 'x'.repeat(MEMBER_CPD_LABEL_MAX_LENGTH) })).statusCode, 200);
});
test('invalid values, non-admin writes, unauthenticated reads and stale tenants fail closed', async () => {
  const f = fixture();
  for (const value of [null, 'false', 0, {}, []]) assert.equal((await f.patch({ show_member_balances_tab: value })).statusCode, 400);
  f.state.role = 'viewer';
  assert.equal((await f.patch({ show_member_balances_tab: false })).statusCode, 403);
  assert.equal((await f.read({ 'x-tenant-id': 'b' })).statusCode, 409);
  assert.equal((await f.patch({ show_member_balances_tab: false }, { 'x-tenant-id': 'b' })).statusCode, 409);
  f.state.fail = true;
  assert.equal((await f.read()).statusCode, 503);
  f.state.fail = false;
  f.state.mismatch = true;
  assert.equal((await f.read()).statusCode, 401);
  f.state.tenantId = null;
  assert.equal((await f.read()).statusCode, 401);
});
