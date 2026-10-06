import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeMemberLanding } from '../shared/memberLanding.js';
import { resolveMemberLanding } from '../api/_lib/memberLanding.js';
import { normalizeInternalReturnTo } from '../shared/safeReturnTo.js';
import { authenticatedMemberProjection } from '../api/_lib/authenticatedMemberProjection.js';

test('password auth response projects organisation-resolved session tenant without changing the CRM record', () => {
  const member = { id: 'legacy', tenant_id: null, organization_id: 'org', role_id: 'member-role' };
  for (const file of ['login.js', 'set-password.js']) {
    const source = readFileSync(`api/auth/${file}`, 'utf8');
    const expression = source.slice(source.lastIndexOf('res.json({'), source.indexOf(';', source.lastIndexOf('res.json({')) + 1);
    let result;
    vm.runInNewContext(expression, {
      member, fullMember: member, sessionTenantId: 'tenant', credentials: {},
      authenticatedMemberProjection, res: { json(value) { result = value; } },
    });
    assert.equal(result.member.tenant_id, 'tenant');
    assert.equal(member.tenant_id, null);
  }
  assert.equal(authenticatedMemberProjection({ ...member, tenant_id: 'foreign' }, 'tenant').tenant_id, 'foreign');
});

test('MemberDetail initial navigation uses server member destination, not root', async () => {
  const source = readFileSync('client/src/pages/MemberDetail.jsx', 'utf8');
  const action = source.slice(source.indexOf('const handleMasquerade ='), source.indexOf('// Handler for copying reset link'));
  const location = { pathname: '/members/target', search: '?tab=overview', hash: '', href: null };
  const context = {
    member: { id: 'target', first_name: 'Target', last_name: 'Member' },
    window: { location }, normalizeMemberLanding, setIsMasquerading() {}, toast: { success() {}, error() {} }, console,
    fetch: async () => ({ ok: true, json: async () => ({ landingUrl: '/member-portal' }) }),
  };
  await vm.runInNewContext(`${action}; handleMasquerade()`, context);
  assert.equal(location.href, '/member-portal');
});

test('normalization preserves internal portal, custom, query and hash destinations', () => {
  for (const [value, expected] of [
    ['Member Portal', '/Member-Portal'], ['/portal/welcome?tab=One#Two', '/portal/welcome?tab=One#Two'],
    ['custom-page', '/custom-page'], [null, '/Preferences'], ['', '/Preferences'],
    ['https://evil.invalid', '/Preferences'], ['//evil.invalid', '/Preferences'],
    ['/\\evil.invalid', '/Preferences'], ['/bad\npath', '/Preferences'],
  ]) assert.equal(normalizeMemberLanding(value), expected);
});

function dbFixture({ landing = 'member-portal', roleError = false, crossRole = false, crossMember = false, denied = false } = {}) {
  const calls = [];
  return { calls, from(table) {
    const filters = {};
    const q = {
      select() { return q; }, eq(key, value) { filters[key] = value; return q; },
      async single() { return q.maybeSingle(); },
      async maybeSingle() {
        calls.push({ table, filters });
        if (table === 'member') return { data: { id: 'target', tenant_id: crossMember ? 'other' : 'tenant', role_id: 'member-role', login_enabled: true } };
        if (table === 'tenant_user') return { data: { role: denied ? 'viewer' : 'owner', first_name: 'Admin' } };
        if (table === 'role') return { data: roleError ? null : { id: 'member-role', tenant_id: crossRole ? 'other' : 'tenant', default_landing_page: landing }, error: roleError ? { message: 'offline' } : null };
        throw new Error(table);
      },
    };
    return q;
  } };
}

test('role lookup distinguishes absence of configuration from failed or foreign role authority', async () => {
  const member = { role_id: 'member-role', tenant_id: 'tenant' };
  assert.equal(await resolveMemberLanding(dbFixture({ landing: null }), member), '/Preferences');
  assert.equal(await resolveMemberLanding(dbFixture(), { tenant_id: 'tenant' }), '/Preferences');
  await assert.rejects(resolveMemberLanding(dbFixture({ roleError: true }), member));
  await assert.rejects(resolveMemberLanding(dbFixture({ crossRole: true }), member));
});

test('OAuth final redirect gives safe contextual destinations precedence over normalized role landing', () => {
  const source = readFileSync('api/auth/google/callback.js', 'utf8');
  const fn = source.slice(source.indexOf('export function buildGoogleFinalRedirect'), source.indexOf('export default async function handler')).replace('export ', '');
  const build = vm.runInNewContext(`${fn}; buildGoogleFinalRedirect`, { normalizeInternalReturnTo });
  const landingPage = normalizeMemberLanding('/portal/custom?tab=One#Two');
  assert.equal(build({ landingPage, isProduction: false }), landingPage);
  assert.equal(build({ landingPage, returnTo: '/events/requested?q=One#book', isProduction: false }), '/events/requested?q=One#book');
  assert.equal(build({ landingPage, returnTo: '//evil.invalid', isProduction: false }), landingPage);
});

test('end masquerade restores original admin identity and return URL', async () => {
  const source = readFileSync('api/auth/end-masquerade.js', 'utf8').replace(/^import .*;\n/gm, '').replace('export default ', '');
  let restored;
  const context = {
    console: { log() {}, error() {} },
    supabase: { from() { return { select() { return this; }, eq() { return this; }, async single() { return { data: { id: 'admin', tenant_id: 'tenant', role_id: 'admin-role' } }; } }; } },
    getSession: async () => ({ id: 'masquerade', data: { isMasquerading: true, masqueradeAdminMemberId: 'admin', masqueradeAdminUserType: 'member', masqueradeAdminTenantId: 'tenant', masqueradeReturnUrl: '/members/target?tab=notes#top' } }),
    createSession: async (_res, data) => { restored = data; return { id: 'restored' }; },
  };
  const handler = vm.runInNewContext(`${source}; handler`, context);
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await handler({ method: 'POST', headers: {} }, res);
  assert.equal(restored.memberId, 'admin');
  assert.equal(restored.roleId, 'admin-role');
  assert.equal(res.body.returnUrl, '/members/target?tab=notes#top');
});

test('real masquerade handler resolves target role before replacing session and keeps admin return separate', async () => {
  const source = readFileSync('api/auth/masquerade.js', 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
  for (const options of [{}, { landing: null }, { landing: '/portal/custom' }, { landing: '//evil.invalid' }, { roleError: true }, { crossRole: true }, { crossMember: true }, { denied: true }]) {
    const db = dbFixture(options);
    let sessionData;
    const context = {
      supabase: db, resolveMemberLanding, normalizeInternalReturnTo, console: { log() {}, error() {} },
      getSession: async () => ({ id: 'admin-session', data: {} }),
      getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant', tenantUserId: 'admin' }),
      evaluateMemberOrganisationLoginAccess: async () => ({ blocked: false }),
      createSession: async (_res, data) => { sessionData = data; return { id: 'member-session' }; },
    };
    const handler = vm.runInNewContext(`${source}; handler`, context);
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method: 'POST', headers: {}, body: { memberId: 'target', returnUrl: '/members/target?tab=notes#top' } }, res);
    if (options.roleError || options.crossRole || options.crossMember || options.denied) {
      assert.ok(res.code >= 400);
      assert.equal(sessionData, undefined);
    } else {
      assert.equal(res.code, 200);
      assert.equal(res.body.landingUrl, normalizeMemberLanding(options.landing === undefined ? 'member-portal' : options.landing));
      assert.equal(sessionData.memberId, 'target');
      assert.equal(sessionData.roleId, 'member-role');
      assert.equal(sessionData.isMasquerading, true);
      assert.equal(sessionData.masqueradeReturnUrl, '/members/target?tab=notes#top');
      assert.ok(db.calls.some(c => c.table === 'role' && c.filters.tenant_id === 'tenant'));
    }
  }
});
