import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveMemberForTenantLogin } from '../_lib/memberLoginResolver.js';

const source = fs.readFileSync(new URL('./team.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace('export default async function handler', 'async function handler');
const makeHandler = new Function('supabase', 'getSessionTenantUser', 'sendEmail', 'crypto',
  `${source}; return handler;`);
const resendSource = fs.readFileSync(new URL('./team/[id]/resend-invite.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
const makeResendHandler = new Function('supabase', 'getSessionTenantUser', 'sendEmail', 'crypto',
  `${resendSource}; return handler;`);

function database({ identities = [], memberships = [], credentials = [], members = [], tenantUsers = [], fail = {}, beforePromotion, beforeInsert } = {}) {
  const writes = [];
  const tables = {
    tenant_identity: identities, tenant_membership: memberships,
    tenant_membership_credentials: credentials, member: members, tenant_user: tenantUsers,
    tenant: [{ id: 't1', name: 'Tenant', slug: 'tenant' }],
  };
  let sequence = 0;
  function from(table) {
    let operation = 'read';
    let values, filters = {};
    const query = {
      select() { return query; },
      eq(key, value) { filters[key] = value; return query; },
      in(key, values) { filters[key] = values; return query; },
      not(key, operator, value) { filters[`not:${key}`] = value; return query; },
      is(key, value) { filters[`is:${key}`] = value; return query; },
      ilike(key, value) { filters[`ilike:${key}`] = value; return query; },
      limit() { return query; },
      order() { return query; },
      insert(payload) { operation = 'insert'; values = payload; return query; },
      update(payload) { operation = 'update'; values = payload; return query; },
      delete() { operation = 'delete'; return query; },
      single() { return resolve(true); },
      maybeSingle() { return resolve(true); },
      then(ok, bad) { return resolve(false).then(ok, bad); },
    };
    async function resolve(single) {
      if (fail[`${table}:${operation}`]) return { data: null, error: { code: fail[`${table}:${operation}`], message: 'database failure' } };
      const matches = row => Object.entries(filters).every(([k, v]) => k.startsWith('not:')
        ? row[k.slice(4)] !== v : k.startsWith('is:')
          ? (row[k.slice(3)] ?? null) === v : k.startsWith('ilike:')
            ? String(row[k.slice(6)] || '').toLowerCase() === String(v).toLowerCase()
            : Array.isArray(v) ? v.includes(row[k]) : row[k] === v);
      const rows = tables[table].filter(matches);
      if (operation === 'read') {
        const decorated = rows.map(row => table === 'tenant_membership'
          ? { ...row, tenant_identity: identities.find(i => i.id === row.identity_id),
            tenant: tables.tenant.find(t => t.id === row.tenant_id) } : row);
        return { data: single ? decorated[0] || null : decorated, error: null };
      }
      if (operation === 'insert') {
        if (beforeInsert) {
          const callback = beforeInsert;
          beforeInsert = null;
          callback(table, values, tables);
        }
        if (table === 'tenant_membership' && memberships.some(row => row.identity_id === values.identity_id && row.tenant_id === values.tenant_id))
          return { data: null, error: { code: '23505' } };
        if (table === 'tenant_identity' && identities.some(row => row.email === values.email))
          return { data: null, error: { code: '23505' } };
        const row = { id: `generated-${++sequence}`, ...values };
        tables[table].push(row); writes.push({ table, operation, values });
        return { data: row, error: null };
      }
      if (operation === 'update' && table === 'tenant_membership' && beforePromotion) {
        const callback = beforePromotion;
        beforePromotion = null;
        callback(tables);
      }
      const matching = tables[table].filter(matches);
      matching.forEach(row => Object.assign(row, values));
      writes.push({ table, operation, values, count: matching.length });
      if (operation === 'delete') matching.forEach(row => tables[table].splice(tables[table].indexOf(row), 1));
      return { data: single ? matching[0] || null : matching, error: null };
    }
    return query;
  }
  return { sb: { from }, tables, writes };
}

const portalIdentity = { id: 'i1', email: 'member@example.com', first_name: 'Member', password_hash: 'existing-hash' };
const portalMembership = { id: 'm1', identity_id: 'i1', tenant_id: 't1', role: 'member', membership_type: 'member', status: 'active', member_id: 'portal1', is_default: true };
async function request(db, method, body = {}, requesterRole = 'owner') {
  const emails = [];
  const handler = makeHandler(db.sb, async () => ({ role: requesterRole, _sessionTenantId: 't1', _sessionIdentityId: 'inviter', email: 'admin@example.com' }), async mail => { emails.push(mail); }, { randomUUID: () => 'token' });
  const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(payload) { this.body = payload; return this; } };
  await handler({ method, body, headers: { host: 'tenant.iconn.app' } }, res);
  return { code: res.code, body: res.body, emails };
}

test('existing portal member is promoted in place, keeps portal link and credentials, appears in team list', async () => {
  const db = database({ identities: [{ ...portalIdentity }], memberships: [{ ...portalMembership }, { id: 'other', identity_id: 'i1', tenant_id: 't2', role: 'member', membership_type: 'member' }] });
  const result = await request(db, 'POST', { email: ' MEMBER@example.com ', role: 'admin' });
  assert.equal(result.code, 200);
  assert.equal(result.body.member.id, 'm1');
  assert.equal(result.emails.length, 1);
  assert.equal(db.tables.tenant_membership[0].member_id, 'portal1');
  assert.equal(db.tables.tenant_membership[0].role, 'admin');
  assert.equal(db.tables.tenant_membership[0].membership_type, 'owner');
  assert.equal(db.tables.tenant_membership[1].role, 'member');
  assert.equal(db.tables.tenant_identity[0].password_hash, 'existing-hash');
  assert.equal(db.writes.filter(w => w.table === 'tenant_identity').length, 0);
  const list = await request(db, 'GET');
  assert.equal(list.body.members.length, 1);
  assert.equal(list.body.members[0].id, 'm1');
});

test('duplicate team role including legacy member-type admin has no writes or mail', async () => {
  for (const role of ['admin', 'owner']) {
    const db = database({ identities: [{ ...portalIdentity }], memberships: [{ ...portalMembership, role }] });
    const result = await request(db, 'POST', { email: portalIdentity.email, role: 'viewer' });
    assert.equal(result.code, 400);
    assert.match(result.body.error, /already a team member/);
    assert.equal(db.writes.length, 0);
    assert.equal(result.emails.length, 0);
  }
});

test('promotion CAS does not overwrite concurrent role change', async () => {
  const db = database({ identities: [{ ...portalIdentity }], memberships: [{ ...portalMembership }],
    beforePromotion: tables => { tables.tenant_membership[0].role = 'owner'; } });
  const result = await request(db, 'POST', { email: portalIdentity.email, role: 'viewer' });
  assert.equal(result.code, 409);
  assert.equal(db.tables.tenant_membership[0].role, 'owner');
  assert.equal(result.emails.length, 0);
});

test('concurrent valid invitations grant once and send exactly one email', async () => {
  for (const memberships of [[{ ...portalMembership }], []]) {
    const existingPortal = memberships.length > 0;
    const db = database({ identities: [{ ...portalIdentity }], memberships });
    const results = await Promise.all([
      request(db, 'POST', { email: portalIdentity.email, role: 'admin' }),
      request(db, 'POST', { email: portalIdentity.email, role: 'viewer' }),
    ]);
    assert.deepEqual(results.map(r => r.code).sort(), [200, existingPortal ? 409 : 400]);
    assert.equal(results.reduce((total, r) => total + r.emails.length, 0), 1);
    assert.equal(db.tables.tenant_membership.filter(m => m.tenant_id === 't1').length, 1);
    assert.equal(db.tables.tenant_membership[0].role, 'admin');
    assert.equal(db.writes.filter(w => w.table === 'tenant_membership' && w.operation !== 'read' && w.count !== 0).length, 1);
  }
});

test('new identity and cross-tenant identity insert one membership without touching other tenant', async () => {
  for (const identities of [[], [{ ...portalIdentity }]]) {
    const crossTenant = identities.length > 0;
    const db = database({ identities, memberships: identities.length ? [{ ...portalMembership, tenant_id: 't2' }] : [] });
    const result = await request(db, 'POST', { email: portalIdentity.email, role: 'admin' });
    assert.equal(result.code, 200);
    assert.equal(db.tables.tenant_membership.filter(m => m.tenant_id === 't1').length, 1);
    assert.equal(db.tables.tenant_membership.find(m => m.tenant_id === 't2')?.role, crossTenant ? 'member' : undefined);
  }
});

test('lookup errors stop before membership or invitation writes', async () => {
  for (const failingTable of ['tenant_identity', 'tenant_membership']) {
    const db = database({ identities: [{ ...portalIdentity }], fail: { [`${failingTable}:read`]: 'DB_ERROR' } });
    const result = await request(db, 'POST', { email: portalIdentity.email });
    assert.equal(result.code, 500);
    assert.equal(db.writes.length, 0);
    assert.equal(result.emails.length, 0);
  }
});

test('identity creation race reuses the winner without duplicating identity', async () => {
  const db = database({ beforeInsert: (table, values, tables) => {
    assert.equal(table, 'tenant_identity');
    tables.tenant_identity.push({ ...portalIdentity });
  } });
  const result = await request(db, 'POST', { email: portalIdentity.email, role: 'admin' });
  assert.equal(result.code, 200);
  assert.equal(db.tables.tenant_identity.length, 1);
  assert.equal(db.tables.tenant_membership[0].identity_id, 'i1');
});

test('membership insert race returns duplicate without role overwrite or invitation', async () => {
  const db = database({ identities: [{ ...portalIdentity }], beforeInsert: (table, values, tables) => {
    assert.equal(table, 'tenant_membership');
    tables.tenant_membership.push({ ...portalMembership, role: 'owner', membership_type: 'owner' });
  } });
  const result = await request(db, 'POST', { email: portalIdentity.email, role: 'viewer' });
  assert.equal(result.code, 400);
  assert.equal(db.tables.tenant_membership[0].role, 'owner');
  assert.equal(result.emails.length, 0);
  assert.equal(db.writes.length, 0);
});

test('deleting a dual-access team row demotes it instead of deleting portal access', async () => {
  const db = database({ identities: [{ ...portalIdentity }], memberships: [{ ...portalMembership, role: 'admin', membership_type: 'owner' }] });
  const result = await request(db, 'DELETE', { membership_id: 'm1' });
  assert.equal(result.code, 200);
  assert.equal(db.tables.tenant_membership[0].member_id, 'portal1');
  assert.equal(db.tables.tenant_membership[0].role, 'member');
  assert.equal(db.tables.tenant_membership[0].status, 'active');
});

test('inactivating dual-access team row revokes team role without deactivating portal membership', async () => {
  const db = database({ identities: [{ ...portalIdentity }], memberships: [{ ...portalMembership, role: 'admin', membership_type: 'owner' }] });
  const result = await request(db, 'PATCH', { membership_id: 'm1', status: 'inactive' });
  assert.equal(result.code, 200);
  assert.equal(db.tables.tenant_membership[0].role, 'member');
  assert.equal(db.tables.tenant_membership[0].status, 'active');
  assert.equal(db.tables.tenant_membership[0].member_id, 'portal1');
});

test('linked team removal and inactivation revoke legacy admin fallback for fresh login and existing sessions', async () => {
  const sessionSource = fs.readFileSync(new URL('../_lib/session.js', import.meta.url), 'utf8');
  const sessionFn = sessionSource.slice(sessionSource.indexOf('export async function getSessionTenantUser'),
    sessionSource.indexOf('/**\n * Invalidate all sessions', sessionSource.indexOf('export async function getSessionTenantUser')))
    .replace('export async function getSessionTenantUser', 'async function getSessionTenantUser');
  const loginSource = fs.readFileSync(new URL('../auth/tenant-identity-login.js', import.meta.url), 'utf8');
  const loginFn = loginSource.slice(loginSource.indexOf('export default async function handler'),
    loginSource.indexOf('async function handleLegacyLogin')).replace('export default async function handler', 'async function handler');
  for (const method of ['DELETE', 'PATCH']) {
    const db = database({
      identities: [{ ...portalIdentity }],
      memberships: [{ ...portalMembership, role: 'admin', membership_type: 'owner' }],
      members: [{ id: 'portal1', identity_id: 'i1', email: portalIdentity.email, tenant_id: 't1', login_enabled: true }],
      // One linked legacy admin and a pre-migration email-only row, plus rows
      // from a different tenant and identity which must remain untouched.
      tenantUsers: [
        { id: 'legacy1', identity_id: 'i1', tenant_id: 't1', email: portalIdentity.email, role: 'admin', status: 'active' },
        { id: 'legacyEmail', identity_id: null, tenant_id: 't1', email: 'MEMBER@example.com', role: 'admin', status: 'active' },
        { id: 'otherTenant', identity_id: 'i1', tenant_id: 't2', email: portalIdentity.email, role: 'admin', status: 'active' },
        { id: 'otherIdentity', identity_id: 'i2', tenant_id: 't1', email: 'other@example.com', role: 'admin', status: 'active' },
      ],
    });
    const login = new Function('supabase', 'bcrypt', 'resolveTenantFromRequest', 'createSession', `${loginFn}; return handler;`)(
      db.sb, { compare: async () => true }, async () => ({ id: 't1' }), async () => {});
    const loginAttempt = async () => {
      const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      await login({ method: 'POST', body: { email: portalIdentity.email, password: 'password', tenantId: 't1' }, headers: {} }, res);
      return res;
    };
    const getTenantUser = new Function('supabase', 'getSession', 'updateSession', 'tryPromoteMemberToTenantUser',
      `${sessionFn}; return getSessionTenantUser;`)(db.sb,
      async () => ({ id: 'existing-admin-session', data: { identityId: 'i1', tenantUserId: 'legacy1', tenantId: 't1', userType: 'tenant_user' } }),
      async () => true, async () => null);
    assert.equal((await loginAttempt()).code, 200);
    assert.equal((await getTenantUser({ headers: {} }))?.role, 'admin');
    const result = await request(db, method, method === 'PATCH' ? { membership_id: 'm1', status: 'inactive' } : { membership_id: 'm1' });
    assert.equal(result.code, 200);
    assert.equal(db.tables.tenant_membership[0].member_id, 'portal1');
    assert.equal(db.tables.tenant_membership[0].status, 'active');
    assert.equal(db.tables.tenant_membership[0].role, 'member');
    assert.equal((await resolveMemberForTenantLogin({ supabase: db.sb, identityId: 'i1', email: portalIdentity.email, tenantId: 't1' })).member.id, 'portal1');
    assert.equal((await loginAttempt()).code, 403);
    assert.equal(await getTenantUser({ headers: {} }), null);
    assert.deepEqual(db.tables.tenant_user.map(row => row.status), ['inactive', 'inactive', 'active', 'active']);
    const revocationWrites = db.writes.filter(w => ['tenant_membership', 'tenant_user'].includes(w.table)
      && w.operation === 'update' && (w.values?.status === 'inactive' || w.values?.role === 'member'));
    assert.equal(revocationWrites[0].table, 'tenant_membership');
    assert.equal(revocationWrites[0].values.status, 'inactive');
    assert.equal(revocationWrites.at(-1).values.role, 'member');
    assert.equal(revocationWrites.filter(w => w.table === 'tenant_user').length, 2);
  }
});

test('legacy revocation write failure leaves unified membership suspended, never reports success', async () => {
  const sessionSource = fs.readFileSync(new URL('../_lib/session.js', import.meta.url), 'utf8');
  const fn = sessionSource.slice(sessionSource.indexOf('export async function getSessionTenantUser'),
    sessionSource.indexOf('/**\n * Invalidate all sessions', sessionSource.indexOf('export async function getSessionTenantUser')))
    .replace('export async function getSessionTenantUser', 'async function getSessionTenantUser');
  for (const failure of ['tenant_user:read', 'tenant_user:update']) {
    const db = database({ identities: [{ ...portalIdentity }],
      memberships: [{ ...portalMembership, role: 'admin', membership_type: 'owner' }],
      tenantUsers: [
        { id: 'legacy1', identity_id: 'i1', tenant_id: 't1', email: portalIdentity.email, role: 'admin', status: 'active' },
        { id: 'legacyEmail', identity_id: null, tenant_id: 't1', email: portalIdentity.email, role: 'admin', status: 'active' },
      ],
      fail: { [failure]: 'DB_ERROR' } });
    const result = await request(db, 'DELETE', { membership_id: 'm1' });
    assert.equal(result.code, 500);
    assert.equal(db.tables.tenant_membership[0].status, 'inactive');
    const getTenantUser = new Function('supabase', 'getSession', 'updateSession', 'tryPromoteMemberToTenantUser',
      `${fn}; return getSessionTenantUser;`)(db.sb,
      async () => ({ id: 'existing-admin-session', data: { identityId: 'i1', tenantUserId: 'legacy1', tenantId: 't1', userType: 'tenant_user' } }),
      async () => true, async () => null);
    assert.equal(await getTenantUser({ headers: {} }), null, 'suspended membership fences active legacy session');
    const emailOnlySession = new Function('supabase', 'getSession', 'updateSession', 'tryPromoteMemberToTenantUser',
      `${fn}; return getSessionTenantUser;`)(db.sb,
      async () => ({ id: 'old-email-only-session', data: { identityId: 'legacyEmail', tenantUserId: 'legacyEmail', tenantId: 't1', userType: 'tenant_user' } }),
      async () => true, async () => null);
    assert.equal(await emailOnlySession({ headers: {} }), null, 'email-only legacy session is also fenced');
    const promoteSource = sessionSource.slice(sessionSource.indexOf('async function tryPromoteMemberToTenantUser'),
      sessionSource.indexOf('const SESSION_NOT_PROVIDED'));
    const promote = new Function('supabase', 'updateSession', `${promoteSource}; return tryPromoteMemberToTenantUser;`)(
      db.sb, async () => { throw new Error('must not promote suspended team access'); });
    assert.equal(await promote({ id: 'portal-session', data: { identityId: 'i1', tenantId: 't1', memberId: 'portal1', userType: 'member' } }, {}),
      null, 'portal session cannot re-promote through active legacy row');
  }
});

test('failed membership insert or CAS update fails without mail, and never changes portal role', async () => {
  for (const membership of [null, { ...portalMembership }]) {
    const db = database({ identities: [{ ...portalIdentity }],
      memberships: membership ? [membership] : [],
      fail: { [`tenant_membership:${membership ? 'update' : 'insert'}`]: 'DB_ERROR' } });
    const result = await request(db, 'POST', { email: portalIdentity.email, role: 'admin' });
    assert.equal(result.code, 500);
    assert.equal(result.emails.length, 0);
    assert.equal(db.tables.tenant_membership.length, membership ? 1 : 0);
    if (membership) assert.equal(db.tables.tenant_membership[0].role, 'member');
  }
});

test('team mutations require owner/admin and cannot target portal-only memberships', async () => {
  const db = database({ identities: [{ ...portalIdentity }], memberships: [{ ...portalMembership }] });
  for (const role of ['member', 'billing', 'viewer']) {
    const result = await request(db, 'POST', { email: portalIdentity.email }, role);
    assert.equal(result.code, 403);
  }
  for (const method of ['PATCH', 'DELETE']) {
    assert.equal((await request(db, method, { membership_id: 'm1', role: 'owner' })).code, 404);
  }
  assert.equal(db.writes.length, 0);
});

test('only per-tenant password: invitation and resend do not rotate identity token', async () => {
  const db = database({ identities: [{ ...portalIdentity, password_hash: null }],
    credentials: [{ id: 'c1', identity_id: 'i1', tenant_id: 't1', password_hash: 'tenant-hash' }],
    memberships: [{ ...portalMembership }] });
  const invited = await request(db, 'POST', { email: portalIdentity.email, role: 'admin' });
  assert.equal(invited.code, 200);
  assert.equal(invited.emails.length, 1);
  assert.doesNotMatch(invited.emails[0].html, /setup=/);
  assert.equal(db.tables.tenant_identity[0].reset_token, undefined);
  assert.equal(db.tables.tenant_membership_credentials[0].password_hash, 'tenant-hash');

  const resend = makeResendHandler(
    db.sb, async () => ({ role: 'admin', tenant_id: 't1', email: 'admin@example.com' }),
    async email => { invited.emails.push(email); }, { randomUUID: () => 'rotated-token' });
  const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await resend({ method: 'POST', query: { id: 'm1' }, headers: { host: 'tenant.iconn.app' } }, res);
  assert.equal(res.code, 200);
  assert.doesNotMatch(invited.emails[1].html, /setup=/);
  assert.equal(db.tables.tenant_identity[0].reset_token, undefined);
  assert.equal(db.tables.tenant_membership_credentials[0].password_hash, 'tenant-hash');
});

test('resend requires admin access and a team membership inside the current tenant', async () => {
  for (const membership of [
    { ...portalMembership },
    { ...portalMembership, role: 'admin', membership_type: 'owner', tenant_id: 't2' },
    { ...portalMembership, role: 'admin', membership_type: 'owner' },
  ]) {
    const db = database({ identities: [{ ...portalIdentity }], memberships: [membership] });
    const emails = [];
    const isAuthorized = membership.role === 'admin' && membership.tenant_id === 't1';
    const requesterRole = membership.tenant_id === 't2' ? 'owner' : isAuthorized ? 'owner' : 'viewer';
    const resend = makeResendHandler(db.sb,
      async () => ({ role: requesterRole, tenant_id: 't1', email: 'admin@example.com' }),
      async email => { emails.push(email); }, { randomUUID: () => 'token' });
    const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await resend({ method: 'POST', query: { id: 'm1' }, headers: {} }, res);
    assert.equal(res.code, isAuthorized ? 200 : membership.tenant_id === 't2' ? 404 : 403);
    assert.equal(emails.length, isAuthorized ? 1 : 0);
  }
  const db = database({ identities: [{ ...portalIdentity }], memberships: [{ ...portalMembership }] });
  const resend = makeResendHandler(db.sb,
    async () => ({ role: 'owner', tenant_id: 't1' }), async () => { throw new Error('must not email'); }, { randomUUID: () => 'token' });
  const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await resend({ method: 'POST', query: { id: 'm1' }, headers: {} }, res);
  assert.equal(res.code, 404);
  assert.equal(db.writes.length, 0);

  const inactive = database({ identities: [{ ...portalIdentity }],
    memberships: [{ ...portalMembership, role: 'admin', membership_type: 'owner', status: 'inactive' }] });
  const inactiveHandler = makeResendHandler(inactive.sb,
    async () => ({ role: 'owner', tenant_id: 't1' }), async () => { throw new Error('must not email'); }, { randomUUID: () => 'token' });
  const inactiveRes = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await inactiveHandler({ method: 'POST', query: { id: 'm1' }, headers: {} }, inactiveRes);
  assert.equal(inactiveRes.code, 409);
  assert.equal(inactive.writes.length, 0);
});

test('portal member resolver retains member linkage after promotion, and session sees team role', async () => {
  const db = database({ identities: [{ ...portalIdentity }], members: [{ id: 'portal1', email: portalIdentity.email, identity_id: 'i1', tenant_id: 't1' }],
    memberships: [{ ...portalMembership }] });
  assert.equal((await request(db, 'POST', { email: portalIdentity.email, role: 'admin' })).code, 200);
  const resolved = await resolveMemberForTenantLogin({ supabase: db.sb, identityId: 'i1', email: portalIdentity.email, tenantId: 't1' });
  assert.equal(resolved.member.id, 'portal1');
  assert.equal(resolved.source, 'tenant_membership');
  const sessionSource = fs.readFileSync(new URL('../_lib/session.js', import.meta.url), 'utf8');
  const memberFn = sessionSource.slice(sessionSource.indexOf('export async function getSessionMember'),
    sessionSource.indexOf('export async function getSessionTenantUser'))
    .replace('export async function getSessionMember', 'async function getSessionMember');
  const getMember = new Function('supabase', 'getSession', 'SESSION_NOT_PROVIDED',
    `${memberFn}; return getSessionMember;`)(db.sb, async () => null, Symbol('missing session'));
  const portalSessionMember = await getMember({ headers: {} },
    { id: 'portal-session', data: { memberId: 'portal1', identityId: 'i1', tenantId: 't1', userType: 'member' } });
  assert.equal(portalSessionMember.id, 'portal1');
  const fn = sessionSource.slice(sessionSource.indexOf('export async function getSessionTenantUser'),
    sessionSource.indexOf('/**\n * Invalidate all sessions', sessionSource.indexOf('export async function getSessionTenantUser')))
    .replace('export async function getSessionTenantUser', 'async function getSessionTenantUser');
  const getTenantUser = new Function('supabase', 'getSession', 'updateSession', 'tryPromoteMemberToTenantUser',
    `${fn}; return getSessionTenantUser;`)(db.sb,
    async () => ({ id: 'session1', data: { identityId: 'i1', tenantUserId: 'i1', tenantId: 't1', userType: 'tenant_user' } }),
    async () => true, async () => null);
  const verified = await getTenantUser({ headers: {} });
  assert.equal(verified.role, 'admin');
  assert.equal(verified._sessionTenantId, 't1');
});

test('admin login accepts promoted roles with tenant-specific or shared hash, preserving correct precedence', async () => {
  const loginSource = fs.readFileSync(new URL('../auth/tenant-identity-login.js', import.meta.url), 'utf8');
  const fn = loginSource.slice(loginSource.indexOf('export default async function handler'),
    loginSource.indexOf('async function handleLegacyLogin')).replace('export default async function handler', 'async function handler');
  for (const role of ['admin', 'billing', 'viewer']) {
    for (const credentialCase of ['tenant-only', 'shared-only', 'both']) {
      const db = database({ identities: [{ ...portalIdentity, password_hash: credentialCase === 'tenant-only' ? null : 'shared-hash' }],
        credentials: credentialCase === 'shared-only' ? [] : [{ id: 'c1', identity_id: 'i1', tenant_id: 't1', password_hash: 'tenant-hash' }],
        memberships: [{ ...portalMembership, role, membership_type: 'owner' }] });
      const compared = [], sessions = [];
      const login = new Function('supabase', 'bcrypt', 'resolveTenantFromRequest', 'createSession', `${fn}; return handler;`)(
        db.sb, { compare: async (_password, hash) => { compared.push(hash); return true; } },
        async () => ({ id: 't1' }), async (_res, session) => { sessions.push(session); });
      const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      await login({ method: 'POST', body: { email: portalIdentity.email, password: 'password', tenantId: 't1' }, headers: {} }, res);
      assert.equal(res.code, 200);
      assert.equal(res.body.tenantUser.role, role);
      assert.deepEqual(compared, [credentialCase === 'shared-only' ? 'shared-hash' : 'tenant-hash']);
      assert.equal(sessions[0].membershipRole, role);
      const sessionSource = fs.readFileSync(new URL('../_lib/session.js', import.meta.url), 'utf8');
      const sessionFn = sessionSource.slice(sessionSource.indexOf('export async function getSessionTenantUser'),
        sessionSource.indexOf('/**\n * Invalidate all sessions', sessionSource.indexOf('export async function getSessionTenantUser')))
        .replace('export async function getSessionTenantUser', 'async function getSessionTenantUser');
      const getTenantUser = new Function('supabase', 'getSession', 'updateSession', 'tryPromoteMemberToTenantUser',
        `${sessionFn}; return getSessionTenantUser;`)(db.sb, async () => ({ id: 'session1', data: sessions[0] }), async () => true, async () => null);
      assert.equal((await getTenantUser({ headers: {} })).role, role);
    }
  }
});