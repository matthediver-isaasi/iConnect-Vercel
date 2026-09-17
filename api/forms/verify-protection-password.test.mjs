import assert from 'node:assert/strict';
import test from 'node:test';
import { handleVerifyProtectionPassword } from './verify-protection-password.js';
import {
  PROTECTED_DEPARTMENT_FORM_ID,
  PROTECTED_DEPARTMENT_TENANT_ID,
} from '../_lib/protectedDepartmentForm.js';

function responseRecorder() {
  const response = { statusCode: 200, body: null };
  return {
    response,
    res: {
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return body; },
    },
  };
}

function fakeDb({ found = true } = {}) {
  const calls = [];
  const query = {
    select() { return this; },
    eq(column, value) { calls.push([column, value]); return this; },
    async maybeSingle() {
      return { data: found ? { id: PROTECTED_DEPARTMENT_FORM_ID } : null, error: null };
    },
  };
  return {
    calls,
    client: { from(table) { assert.equal(table, 'form'); return query; } },
  };
}

const context = {
  isAuthenticated: true,
  tenantId: PROTECTED_DEPARTMENT_TENANT_ID,
  memberId: 'admin-1',
};

async function request(password, overrides = {}) {
  const db = fakeDb(overrides);
  const { response, res } = responseRecorder();
  await handleVerifyProtectionPassword({
    method: 'POST',
    body: { form_id: PROTECTED_DEPARTMENT_FORM_ID, password },
  }, res, {
    supabase: db.client,
    getTenantContext: async () => overrides.context || context,
    hasAdminAccess: async () => overrides.admin !== false,
    isRateLimited: () => overrides.rateLimited === true,
    recordFailure: () => {},
    clearFailures: () => {},
    env: overrides.env || { BNMS_DEPT_SURVEY_SECRET: 'server-only-secret' },
  });
  return { response, calls: db.calls };
}

test('verification rejects wrong password without a write and scopes lookup to tenant', async () => {
  const { response, calls } = await request('wrong');
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, 'PROTECTED_FORM_PASSWORD_INCORRECT');
  assert.deepEqual(calls, [
    ['id', PROTECTED_DEPARTMENT_FORM_ID],
    ['tenant_id', PROTECTED_DEPARTMENT_TENANT_ID],
  ]);
});

test('verification accepts the environment-backed password without mutation', async () => {
  const { response } = await request('server-only-secret');
  assert.deepEqual(response, { statusCode: 200, body: { success: true } });
});

test('verification fails closed when secret is absent', async () => {
  const { response } = await request('server-only-secret', { env: Object.create(null) });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'PROTECTED_FORM_SECRET_NOT_CONFIGURED');
});

test('verification requires authenticated admin and applies rate limit', async () => {
  assert.equal((await request('server-only-secret', {
    context: { isAuthenticated: false },
  })).response.statusCode, 401);
  assert.equal((await request('server-only-secret', { admin: false })).response.statusCode, 403);
  assert.equal((await request('server-only-secret', { rateLimited: true })).response.statusCode, 429);
});