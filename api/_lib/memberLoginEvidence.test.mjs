import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { assessLifecycleLogins, isGenuineMemberLogin, stampMemberLoginSession } from './memberLoginEvidence.js';

const member = { userType: 'member', memberId: 'member', tenantId: 'tenant' };
test('only explicit genuine member authentication can produce login evidence', () => {
  for (const source of ['password', 'google', 'password_setup', 'mobile_password']) {
    assert.equal(isGenuineMemberLogin(member, source), true);
  }
  for (const source of [undefined, 'refresh', 'masquerade', 'tenant_switch', 'portal_sso']) {
    assert.equal(isGenuineMemberLogin(member, source), false);
  }
  for (const extra of [
    { userType: 'tenant_user' }, { tenantId: null }, { memberId: null }, { tenantUserId: 'admin' },
    { isMasquerading: true }, { isPlatformImpersonation: true }, { masqueradeAdminSessionId: 'admin-session' },
    { promotedFromMember: true }, { originalUserType: 'member' },
  ]) assert.equal(isGenuineMemberLogin({ ...member, ...extra }, 'password'), false);
});

test('stamping is scoped to the issued session and preserves its auth/cookie fields', async () => {
  let payload, scopedId;
  const session = { ...member, cookie: { secure: true }, authMethod: 'bearer', memberLoginGeneration: 2 };
  const db = { from: table => {
    assert.equal(table, 'session');
    return { update(value) { payload = value; return {
      eq(key, id) { assert.equal(key, 'sid'); scopedId = id; return {
        select(columns) { assert.equal(columns, 'sid'); return {
          maybeSingle: async () => ({ data: { sid: id }, error: null }),
        }; },
      }; },
    }; } };
  } };
  assert.equal(await stampMemberLoginSession(db, { sessionId: 'opaque', sessionData: session, source: 'mobile_password' }), true);
  assert.equal(scopedId, 'opaque');
  const { memberLoginEvidence: marker, ...saved } = payload.sess;
  assert.deepEqual(saved, session);
  assert.match(marker.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(marker).sort(), ['id', 'source', 'version']);
  assert.equal(session.memberLoginEvidence, undefined);
});

test('unqualified sessions do not query storage', async () => {
  assert.equal(await stampMemberLoginSession({}, {
    sessionId: 'opaque', sessionData: { ...member, isMasquerading: true }, source: 'password',
  }), true);
});
test('missing session rows and storage errors cannot claim successful finalization', async () => {
  for (const result of [{ data: null }, { data: { sid: 'other' } }, { error: { code: '500' } }]) {
    const chain = { update: () => chain, eq: () => chain, select: () => chain, maybeSingle: async () => result };
    assert.equal(await stampMemberLoginSession({ from: () => chain },
      { sessionId: 'opaque', sessionData: member, source: 'password' }), false);
  }
});

const source = fs.readFileSync(new URL('./session.js', import.meta.url), 'utf8');
async function issue({ bearer = false, finalization = true, fence = true, loginSource, data = member } = {}) {
  const events = [];
  const cookieBody = source.slice(source.indexOf('export async function createSession('),
    source.indexOf('// Bearer tokens for native/mobile clients')).replace('export async', 'async');
  const bearerBody = source.slice(source.indexOf('export async function createBearerSession('),
    source.indexOf('/**\n * Revoke (delete)')).replace('export async', 'async');
  let inserted;
  const db = { from: () => ({
    insert: async row => { events.push('insert'); inserted = row; return {}; },
    delete: () => ({ eq: async () => { events.push('delete'); return {}; } }),
  }) };
  const run = new Function('supabase', 'applyMemberSessionAccessFence', 'generateSessionId',
    'SESSION_MAX_AGE', 'BEARER_TOKEN_MAX_AGE', 'PRODUCTION_COOKIE_DOMAIN', 'getMemberSessionAccessFence',
    'isMemberSessionFenceRevoked', 'signSessionId', 'serialize', 'SESSION_COOKIE_NAME',
    'stampMemberLoginSession', 'crypto',
    `${bearer ? bearerBody : cookieBody};return ${bearer ? 'createBearerSession' : 'createSession'};`)(
    db, async data => ({ allowed: true, sessionData: data }), () => 'opaque',
    1000, 1000, '.iconn.app', async () => { events.push('fence'); return { allowed: fence }; },
    () => false, value => value, () => 'cookie', 'sid',
    async (_db, input) => { events.push('finalize'); assert.equal(input.source, loginSource); return finalization; },
    crypto,
  );
  const options = { loginEvidenceSource: loginSource };
  const result = bearer ? await run(data, options)
    : await run({ setHeader: () => events.push('cookie') }, data, options);
  return { result, events, inserted };
}
test('cookie and bearer login evidence follows successful access revalidation', async () => {
  for (const bearer of [false, true]) {
    const result = await issue({ bearer, loginSource: 'password' });
    assert.deepEqual(result.events, ['insert', 'fence', 'finalize', ...bearer ? [] : ['cookie']]);
    assert.ok(result.result);
    const refused = await issue({ bearer, loginSource: 'password', fence: false });
    assert.deepEqual(refused.events, ['insert', 'fence', 'delete']);
    assert.equal(refused.result, null);
    const failed = await issue({ bearer, loginSource: 'password', finalization: false });
    assert.deepEqual(failed.events, ['insert', 'fence', 'finalize', 'delete']);
    assert.equal(failed.result, null);
  }
});
test('ordinary session creation strips inherited markers and does not finalize a login', async () => {
  for (const bearer of [false, true]) {
    const result = await issue({ bearer, data: { ...member, memberLoginEvidence: { id: 'old' } } });
    assert.equal(result.inserted.sess.memberLoginEvidence, undefined);
    assert.equal(result.events.includes('finalize'), false);
  }
});
test('session refresh preserves only the original persisted login marker', async () => {
  const body = source.slice(source.indexOf('export async function updateSession('),
    source.indexOf('export async function destroySession(')).replace('export async', 'async');
  const originalMarker = { id: 'original', source: 'password', version: 1 };
  let saved = { ...member, cookie: {}, memberLoginEvidence: originalMarker };
  const db = { from: () => ({
    select: () => ({ eq: () => ({ single: async () => ({ data: { sess: saved } }) }) }),
    update: payload => ({ eq: async () => { saved = payload.sess; return {}; } }),
  }) };
  const update = new Function('supabase', 'SESSION_MAX_AGE', 'getMemberSessionAccessFence',
    'isMemberSessionFenceRevoked', 'applyMemberSessionAccessFence',
    `${body};return updateSession;`)(db, 1000, async () => ({ allowed: true }),
    () => false, async data => ({ allowed: true, sessionData: data }));
  assert.equal(await update('opaque', { ...member, memberLoginEvidence: { id: 'replacement' } }), true);
  assert.deepEqual(saved.memberLoginEvidence, originalMarker);
});
test('each real authentication entry point opts in; administrative paths do not', () => {
  for (const [file, source] of [
    ['login.js', 'password'], ['google/callback.js', 'google'],
    ['mobile-login.js', 'mobile_password'], ['set-password.js', 'password_setup'],
  ]) assert.ok(fs.readFileSync(new URL(`../auth/${file}`, import.meta.url), 'utf8')
    .includes(`loginEvidenceSource: '${source}'`));
  for (const file of ['masquerade.js', 'tenant-switch.js', 'portal-sso.js', 'tenant-identity-login.js']) {
    assert.doesNotMatch(fs.readFileSync(new URL(`../auth/${file}`, import.meta.url), 'utf8'), /loginEvidenceSource/);
  }
});
test('forward login observations expose real dates without certifying historical completeness', () => {
  const scope = { tenantId: 'tenant', memberId: 'member', now: new Date('2026-11-22') };
  const row = { id: 'id', tenant_id: 'tenant', member_id: 'member', source: 'password', occurred_at: '2026-11-20T23:30:00Z' };
  const result = assessLifecycleLogins([row], { ...scope, timezone: 'Europe/Madrid' });
  assert.equal(result.lastOccurredAt, '2026-11-21');
  assert.equal(result.complete, false);
  assert.equal(assessLifecycleLogins([], scope).complete, false);
  for (const extra of [{ tenant_id: 'other' }, { member_id: 'other' }, { source: 'masquerade' },
    { occurred_at: '2027-01-01' }, { occurred_at: null }]) {
    assert.throws(() => assessLifecycleLogins([{ ...row, ...extra }], scope));
  }
});
