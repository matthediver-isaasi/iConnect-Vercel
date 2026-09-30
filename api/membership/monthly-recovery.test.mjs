import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonthlyRecoveryHandler } from './monthly-recovery.js';

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function handler(overrides = {}) {
  return createMonthlyRecoveryHandler({
    db: {},
    getContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a', roleId: 'role-a' }),
    isAdmin: async () => true,
    hasFinance: async () => true,
    resolveTrustedBaseUrl: async () => 'https://tenant-a.example.org',
    service: {
      list: async (tenantId) => ({ tenantId, agreements: [] }),
      preview: async (tenantId, id) => ({ tenantId, id }),
      resume: async (tenantId, id, confirmed) => ({ tenantId, id, confirmed }),
    },
    ...overrides,
  });
}

test('API requires authenticated tenant admin and finance permission', async () => {
  let res = response();
  await handler({ getContext: async () => ({ isAuthenticated: false }) })({ method: 'GET', query: {} }, res);
  assert.equal(res.statusCode, 401);

  res = response();
  await handler({ isAdmin: async () => false })({ method: 'GET', query: {} }, res);
  assert.equal(res.statusCode, 403);

  res = response();
  await handler({ hasFinance: async () => false })({ method: 'GET', query: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /finance permission/);
});

test('API scopes list and preview to context tenant', async () => {
  let res = response();
  await handler()({ method: 'GET', query: {} }, res);
  assert.equal(res.body.tenantId, 'tenant-a');

  res = response();
  await handler()({ method: 'GET', query: { agreementId: 'agreement-1' } }, res);
  assert.deepEqual(res.body, { tenantId: 'tenant-a', id: 'agreement-1' });
});

test('API POST guard requires confirmed true before service execution', async () => {
  let calls = 0;
  const service = {
    list: async () => ({}),
    preview: async () => ({}),
    resume: async () => { calls += 1; return {}; },
  };
  let res = response();
  await handler({ service })({
    method: 'POST',
    query: {},
    body: { agreementId: 'agreement-1', confirmed: false },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls, 0);

  res = response();
  await handler({ service })({
    method: 'POST',
    query: {},
    body: { agreementId: 'agreement-1', confirmed: true },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls, 1);
});

test('API resolves canonical base URL without trusting request Origin and passes it to service', async () => {
  let resolverRequest = 'not-called';
  let resumeOptions = null;
  const service = {
    list: async () => ({}),
    preview: async () => ({}),
    resume: async (_tenantId, _agreementId, _confirmed, options) => {
      resumeOptions = options;
      return { resumed: true };
    },
  };
  const res = response();
  await handler({
    service,
    resolveTrustedBaseUrl: async (resolverReq, _db, tenantId) => {
      resolverRequest = resolverReq;
      assert.equal(tenantId, 'tenant-a');
      return 'https://canonical.example.org/path-that-is-discarded';
    },
  })({
    method: 'POST',
    headers: { origin: 'https://attacker.example' },
    query: {},
    body: { agreementId: 'agreement-1', confirmed: true },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(resolverRequest, null);
  assert.deepEqual(resumeOptions, { trustedBaseUrl: 'https://canonical.example.org' });
});

test('API fails closed when canonical tenant base URL is unavailable', async () => {
  let calls = 0;
  const res = response();
  await handler({
    resolveTrustedBaseUrl: async () => '',
    service: {
      list: async () => ({}),
      preview: async () => ({}),
      resume: async () => { calls += 1; },
    },
  })({
    method: 'POST',
    headers: { origin: 'https://attacker.example' },
    query: {},
    body: { agreementId: 'agreement-1', confirmed: true },
  }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(calls, 0);
});