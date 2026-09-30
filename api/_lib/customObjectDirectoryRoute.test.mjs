import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../organisation-directory/custom-object-fields.js';
import { CustomObjectDirectoryError } from './customObjectDirectory.js';

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name] = value; },
  };
}

test('endpoint permits GET only', async () => {
  const handler = createHandler({
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant' }),
  });
  const res = response();
  await handler({ method: 'POST', query: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'GET');
  assert.equal(res.headers['Cache-Control'], 'private, no-store, max-age=0');
});

test('endpoint rejects public requests before database access', async () => {
  const handler = createHandler({
    db: { from() { throw new Error('database must not be queried'); } },
    getTenantContext: async () => ({ isAuthenticated: false, tenantId: 'tenant-from-host' }),
  });
  const res = response();
  await handler({ method: 'GET', query: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'Authentication required');
  assert.equal(res.headers['Cache-Control'], 'private, no-store, max-age=0');
});

test('authenticated embed requests are denied before database access', async () => {
  const handler = createHandler({
    db: { from() { throw new Error('database must not be queried'); } },
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant', roleId: 'role',
    }),
    hasAdminAccess: async () => false,
  });
  const res = response();
  await handler({
    method: 'GET',
    query: {},
    headers: { referer: 'https://tenant.example/embed/directory' },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Embed access denied');
});

function emptyDb() {
  return {
    from() {
      const query = new Proxy({}, {
        get(_target, property) {
          if (property === 'then') {
            return (resolve) => resolve({ data: [], error: null });
          }
          return () => query;
        },
      });
      return query;
    },
  };
}

test('settings metadata requires the dedicated standard-directory feature', async () => {
  const checked = [];
  const handler = createHandler({
    db: emptyDb(),
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant', roleId: 'role',
    }),
    hasFeatureAccess: async (roleId, feature) => {
      checked.push([roleId, feature]);
      return true;
    },
    hasAdminAccess: async () => false,
  });
  const res = response();
  await handler({ method: 'GET', query: { settings: 'true' }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { sources: [] });
  assert.deepEqual(checked, [['role', 'membership.organisation-directory-settings']]);
});

test('member-admin reads sources without explicit object or field grants', async () => {
  let receivedAdmin;
  const handler = createHandler({
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant', roleId: 'member-admin-role',
    }),
    hasAdminAccess: async () => true,
    createCustomObjectDirectory: ({ isAdmin }) => {
      receivedAdmin = isAdmin;
      return {
        async metadata() {
          if (!isAdmin) throw new CustomObjectDirectoryError(403, 'Source access denied');
          return { sources: [{ key: 'admin-readable-source' }] };
        },
      };
    },
  });
  const res = response();
  await handler({ method: 'GET', query: {}, headers: {} }, res);
  assert.equal(receivedAdmin, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { sources: [{ key: 'admin-readable-source' }] });
});

test('regular member without object or field grants remains denied', async () => {
  let receivedAdmin;
  const handler = createHandler({
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant', roleId: 'regular-role',
    }),
    hasAdminAccess: async () => false,
    createCustomObjectDirectory: ({ isAdmin }) => {
      receivedAdmin = isAdmin;
      return {
        async metadata() {
          throw new CustomObjectDirectoryError(403, 'Source access denied');
        },
      };
    },
  });
  const res = response();
  await handler({ method: 'GET', query: {}, headers: {} }, res);
  assert.equal(receivedAdmin, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Source access denied');
});

test('broad admin status cannot replace directory-settings authorization', async () => {
  const handler = createHandler({
    db: { from() { throw new Error('database must not be queried'); } },
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant', roleId: 'role',
    }),
    hasFeatureAccess: async () => false,
    hasAdminAccess: async () => true,
  });
  const res = response();
  await handler({ method: 'GET', query: { settings: 'true' }, headers: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Directory settings access denied');
});

test('endpoint rejects stale cross-tenant sessions', async () => {
  const handler = createHandler({
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'old-tenant', tenantMismatch: true,
    }),
  });
  const res = response();
  await handler({ method: 'GET', query: {} }, res);
  assert.equal(res.statusCode, 409);
});

test('value mode requires a source key before database access', async () => {
  const handler = createHandler({
    db: { from() { throw new Error('database must not be queried'); } },
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant', roleId: 'role',
    }),
    hasAdminAccess: async () => false,
  });
  const res = response();
  await handler({ method: 'GET', query: { organization_id: 'org' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'source_key is required');
});