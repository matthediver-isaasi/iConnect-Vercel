import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// Execute the actual resolver with isolated session/host dependencies.
const source = await fs.readFile(new URL('./tenantContext.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export async function getTenantContext('),
  source.indexOf('export function getTenantColumn('))
  .replace('export async function', 'async function')
  .replace("await import('./tenantResolver.js')", '({ resolveTenantFromRequest: resolveHost })');

function fixture({ admin = false, sessionTenantId = 'tenant' } = {}) {
  let reads = 0;
  let revoked = false;
  let failure = false;
  const session = { data: { tenantId: sessionTenantId, memberId: 'member' } };
  const getSession = async () => {
    reads++;
    if (failure) throw Object.assign(new Error('Unavailable'), { code: 'SESSION_UNAVAILABLE' });
    return revoked ? null : session;
  };
  const getSessionMember = async (_req, supplied) => {
    const resolved = supplied === undefined ? await getSession() : supplied;
    return resolved ? { id: 'member', tenant_id: 'tenant', role_id: 'role' } : null;
  };
  const getSessionTenantUser = async (_req, supplied) => {
    const resolved = supplied === undefined ? await getSession() : supplied;
    return admin && resolved ? { id: 'admin', tenant_id: 'tenant' } : null;
  };
  const resolve = new Function('getSession', 'getSessionMember', 'getSessionTenantUser',
    'resolveHost', `${body}; return getTenantContext;`)(
    getSession, getSessionMember, getSessionTenantUser, async () => ({ id: 'tenant' }));
  return { resolve, get reads() { return reads; },
    revoke() { revoked = true; }, fail() { failure = true; } };
}

for (const admin of [false, true]) {
  test(`carousel shares one session per pass, never across passes (admin=${admin})`, async () => {
    const f = fixture({ admin });
    const options = { reuseSessionWithinPass: true };
    assert.equal((await f.resolve({ headers: {} }, options)).isAuthenticated, true);
    assert.equal(f.reads, 1);
    assert.equal((await f.resolve({ headers: {} }, options)).isAuthenticated, true);
    assert.equal(f.reads, 2);
    f.revoke();
    assert.equal((await f.resolve({ headers: {} }, options)).isAuthenticated, false);
    assert.equal(f.reads, 3);
  });
}

test('other endpoints retain the historical session lookup behavior', async () => {
  const f = fixture();
  assert.equal((await f.resolve({ headers: {} })).isAuthenticated, true);
  assert.equal(f.reads, 3);
});

test('a fresh session outage on a later pass fails closed', async () => {
  const f = fixture();
  const options = { reuseSessionWithinPass: true };
  await f.resolve({ headers: {} }, options);
  f.fail();
  await assert.rejects(f.resolve({ headers: {} }, options), { code: 'SESSION_UNAVAILABLE' });
});

test('session reuse retains the cross-tenant mismatch guard', async () => {
  const f = fixture({ sessionTenantId: 'another-tenant' });
  const result = await f.resolve({ headers: {} }, { reuseSessionWithinPass: true });
  assert.equal(result.tenantMismatch, true);
  assert.equal(f.reads, 1);
});
