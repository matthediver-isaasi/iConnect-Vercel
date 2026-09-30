import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler } from './csv-settings.js';

function response() {
  return {
    statusCode: 200, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('CSV settings uses the directory-settings gate and a strict GET/PUT contract', async () => {
  const calls = [];
  const handler = createHandler({
    db: {},
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-1', roleId: 'role-1' }),
    hasFeatureAccess: async (_role, feature) => feature === 'membership.organisation-directory-settings',
    resolveMemberExclusions: async () => [],
    readOrganisationDirectoryCsvSetting: async () => false,
    saveOrganisationDirectoryCsvSetting: async (input) => { calls.push(input); return input.allowCsvDownload; },
  });
  let res = response();
  await handler({ method: 'GET', query: {}, headers: {} }, res);
  assert.deepEqual(res.body, { allowCsvDownload: false });
  res = response();
  await handler({ method: 'PUT', query: {}, headers: {}, body: { allowCsvDownload: true } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { allowCsvDownload: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tenantId, 'tenant-1');
  assert.equal(calls[0].allowCsvDownload, true);
});

test('CSV settings refuses embed and excluded users', async () => {
  const handler = createHandler({
    db: {},
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-1', roleId: 'role-1' }),
    hasFeatureAccess: async () => true,
    resolveMemberExclusions: async () => ['membership.organisation-directory-settings'],
  });
  let res = response();
  await handler({ method: 'GET', query: { embed: 'true' }, headers: {} }, res);
  assert.equal(res.statusCode, 403);
  res = response();
  await handler({ method: 'GET', query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 403);
});