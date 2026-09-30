import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler } from './export-csv.js';

function response() {
  return {
    statusCode: 200, headers: {}, sent: false,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.sent = true; this.body = body; return this; },
  };
}

function exportHandler({ enabled = true, csv = 'complete csv', feature = true } = {}) {
  return createHandler({
    db: {},
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-1', roleId: 'role-1' }),
    hasFeatureAccess: async () => feature,
    resolveMemberExclusions: async () => [],
    hasAdminAccess: async () => false,
    readOrganisationDirectoryCsvSetting: async () => enabled,
    createOrganisationDirectoryFilters: () => ({ csv: async () => {
      if (csv instanceof Error) throw csv;
      return { csv };
    } }),
  });
}

test('directory CSV export requires the explicit tenant opt-in and sends an attachment', async () => {
  let res = response();
  await exportHandler({ enabled: false })({ method: 'GET', query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.sent, false);

  res = response();
  await exportHandler({ csv: '\ufeffOrganisation\r\nOne' })({ method: 'GET', query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Disposition'], 'attachment; filename="organisation-directory.csv"');
  assert.equal(res.headers['Content-Type'], 'text/csv; charset=utf-8');
  assert.equal(res.sent, true);
});

test('directory CSV export never starts an attachment when projection fails', async () => {
  const res = response();
  await exportHandler({ csv: new Error('database failed') })({ method: 'GET', query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.sent, false);
  assert.deepEqual(res.body, { error: 'Failed to export organisation directory CSV' });
});

test('export rechecks viewer access, admin bypass, tenant and opt-in before attachment', async () => {
  for (const changed of ['feature', 'admin', 'tenant', 'setting', 'authenticated', 'role', 'organization']) {
    let finished = false;
    const handler = createHandler({
      db: {},
      getTenantContext: async () => ({
        isAuthenticated: !(finished && changed === 'authenticated'),
        tenantId: finished && changed === 'tenant' ? 'other' : 'tenant',
        roleId: finished && changed === 'role' ? 'other' : 'role',
        organizationId: finished && changed === 'organization' ? 'other' : 'org',
      }),
      hasFeatureAccess: async () => !(finished && changed === 'feature'),
      resolveMemberExclusions: async () => [],
      hasAdminAccess: async () => !(finished && changed === 'admin'),
      readOrganisationDirectoryCsvSetting: async () => !(finished && changed === 'setting'),
      createOrganisationDirectoryFilters: () => ({ csv: async () => {
        finished = true;
        return { csv: 'must not deliver' };
      } }),
    });
    const res = response();
    await handler({ method: 'GET', query: {}, headers: {} }, res);
    assert.equal(res.statusCode, 403, changed);
    assert.equal(res.sent, false);
    assert.equal(res.headers['Content-Disposition'], undefined);
  }
});