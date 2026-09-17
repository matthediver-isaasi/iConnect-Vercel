import assert from 'node:assert/strict';
import test from 'node:test';
import handler from './[entity]/[id].js';
import { handleVerifyProtectionPassword } from '../forms/verify-protection-password.js';
import {
  PROTECTED_DEPARTMENT_FORM_ID,
  PROTECTED_FORM_HELPER_MESSAGE,
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

test('real generic endpoint rejects wrong protected-form password after auth and before any mutation', async () => {
  const originalSecret = process.env.BNMS_DEPT_SURVEY_SECRET;
  process.env.BNMS_DEPT_SURVEY_SECRET = 'endpoint-test-secret';
  const databaseCalls = [];
  const dependencies = {
    supabase: {
      from(table) {
        databaseCalls.push(['from', table]);
        throw new Error('database mutation/read was not expected after injected auth');
      },
    },
    getTenantContext: async () => ({
      isAuthenticated: true,
      tenantId: 'presented-tenant',
      memberId: 'admin-1',
    }),
    hasAdminAccess: async () => true,
  };
  try {
    const { response, res } = responseRecorder();
    await handler({
      method: 'PATCH',
      query: { entity: 'Form', id: PROTECTED_DEPARTMENT_FORM_ID },
      headers: {
        'x-form-protection-password': 'wrong',
        'x-forwarded-for': '192.0.2.41',
      },
      body: { name: 'must not persist' },
    }, res, dependencies);
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.code, 'PROTECTED_FORM_PASSWORD_INCORRECT');
    assert.deepEqual(databaseCalls, []);
  } finally {
    if (originalSecret === undefined) delete process.env.BNMS_DEPT_SURVEY_SECRET;
    else process.env.BNMS_DEPT_SURVEY_SECRET = originalSecret;
  }
});

test('real generic endpoint forbids protected-form deletion before admin/platform or database bypasses', async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error('database/network access was not expected');
  };
  try {
    const { response, res } = responseRecorder();
    await handler({
      method: 'DELETE',
      query: { entity: 'Form', id: PROTECTED_DEPARTMENT_FORM_ID },
      headers: { 'x-form-protection-password': 'even-a-correct-password-cannot-delete' },
      body: {},
    }, res);
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.code, 'PROTECTED_FORM_DELETE_FORBIDDEN');
    assert.equal(response.body.error, PROTECTED_FORM_HELPER_MESSAGE);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('real generic endpoint rate limits repeated direct password guesses', async () => {
  const originalSecret = process.env.BNMS_DEPT_SURVEY_SECRET;
  process.env.BNMS_DEPT_SURVEY_SECRET = 'endpoint-test-secret';
  try {
    const dependencies = {
      supabase: {},
      getTenantContext: async () => ({
        isAuthenticated: true,
        tenantId: 'presented-tenant',
        memberId: 'admin-1',
      }),
      hasAdminAccess: async () => true,
    };
    let last;
    for (let index = 0; index < 11; index += 1) {
      const { response, res } = responseRecorder();
      await handler({
        method: 'PATCH',
        query: { entity: 'Form', id: PROTECTED_DEPARTMENT_FORM_ID },
        headers: {
          'x-form-protection-password': `wrong-${index}`,
          'x-forwarded-for': '192.0.2.42',
        },
        body: { name: 'must not persist' },
      }, res, dependencies);
      last = response;
    }
    assert.equal(last.statusCode, 429);
    assert.equal(last.body.code, 'PROTECTED_FORM_RATE_LIMITED');
  } finally {
    if (originalSecret === undefined) delete process.env.BNMS_DEPT_SURVEY_SECRET;
    else process.env.BNMS_DEPT_SURVEY_SECRET = originalSecret;
  }
});

test('real generic endpoint does not expose password validity before authentication', async () => {
  const originalSecret = process.env.BNMS_DEPT_SURVEY_SECRET;
  process.env.BNMS_DEPT_SURVEY_SECRET = 'endpoint-test-secret';
  try {
    for (const password of ['wrong', 'endpoint-test-secret']) {
      const { response, res } = responseRecorder();
      await handler({
        method: 'PATCH',
        query: { entity: 'Form', id: PROTECTED_DEPARTMENT_FORM_ID },
        headers: {
          'x-form-protection-password': password,
          'x-forwarded-for': `192.0.2.${password === 'wrong' ? 43 : 44}`,
        },
        body: { name: 'must not persist' },
      }, res, {
        supabase: {},
        getTenantContext: async () => ({ isAuthenticated: false, tenantId: null }),
        hasAdminAccess: async () => {
          throw new Error('admin check must not run for anonymous callers');
        },
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.body.error, 'Authentication required');
    }
  } finally {
    if (originalSecret === undefined) delete process.env.BNMS_DEPT_SURVEY_SECRET;
    else process.env.BNMS_DEPT_SURVEY_SECRET = originalSecret;
  }
});

test('tenant mismatch and admin authorization resolve before password verification', async () => {
  const originalSecret = process.env.BNMS_DEPT_SURVEY_SECRET;
  process.env.BNMS_DEPT_SURVEY_SECRET = 'endpoint-test-secret';
  try {
    for (const scenario of [
      {
        context: { isAuthenticated: true, tenantMismatch: true, tenantId: 'wrong-tenant' },
        admin: true,
        status: 409,
        code: 'TENANT_CONTEXT_CHANGED',
      },
      {
        context: { isAuthenticated: true, tenantId: 'presented-tenant', memberId: 'member-1' },
        admin: false,
        status: 403,
        error: 'Admin access required',
      },
    ]) {
      for (const password of ['wrong', 'endpoint-test-secret']) {
        const { response, res } = responseRecorder();
        await handler({
          method: 'PATCH',
          query: { entity: 'Form', id: PROTECTED_DEPARTMENT_FORM_ID },
          headers: {
            'x-form-protection-password': password,
            'x-forwarded-for': `192.0.2.${password === 'wrong' ? 46 : 47}`,
          },
          body: { name: 'must not persist' },
        }, res, {
          supabase: {},
          getTenantContext: async () => scenario.context,
          hasAdminAccess: async () => scenario.admin,
        });
        assert.equal(response.statusCode, scenario.status);
        if (scenario.code) assert.equal(response.body.code, scenario.code);
        if (scenario.error) assert.equal(response.body.error, scenario.error);
      }
    }
  } finally {
    if (originalSecret === undefined) delete process.env.BNMS_DEPT_SURVEY_SECRET;
    else process.env.BNMS_DEPT_SURVEY_SECRET = originalSecret;
  }
});

test('verification and mutation share one password-failure limit', async () => {
  const originalSecret = process.env.BNMS_DEPT_SURVEY_SECRET;
  process.env.BNMS_DEPT_SURVEY_SECRET = 'endpoint-test-secret';
  const ip = '192.0.2.45';
  const tenantContext = {
    isAuthenticated: true,
    tenantId: 'ff2df806-b321-4254-b651-3af11fccf1db',
    memberId: 'admin-1',
  };
  const verifyDb = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          return { data: { id: PROTECTED_DEPARTMENT_FORM_ID }, error: null };
        },
      };
    },
  };
  try {
    for (let index = 0; index < 5; index += 1) {
      const { response, res } = responseRecorder();
      await handleVerifyProtectionPassword({
        method: 'POST',
        headers: { 'x-forwarded-for': ip },
        body: { form_id: PROTECTED_DEPARTMENT_FORM_ID, password: `verify-wrong-${index}` },
      }, res, {
        supabase: verifyDb,
        getTenantContext: async () => tenantContext,
        hasAdminAccess: async () => true,
      });
      assert.equal(response.statusCode, 403);
    }
    for (let index = 0; index < 5; index += 1) {
      const { response, res } = responseRecorder();
      await handler({
        method: 'PATCH',
        query: { entity: 'Form', id: PROTECTED_DEPARTMENT_FORM_ID },
        headers: {
          'x-form-protection-password': `mutation-wrong-${index}`,
          'x-forwarded-for': ip,
        },
        body: { name: 'must not persist' },
      }, res, {
        supabase: {},
        getTenantContext: async () => tenantContext,
        hasAdminAccess: async () => true,
      });
      assert.equal(response.statusCode, 403);
    }
    const { response, res } = responseRecorder();
    await handler({
      method: 'PATCH',
      query: { entity: 'Form', id: PROTECTED_DEPARTMENT_FORM_ID },
      headers: {
        'x-form-protection-password': 'eleventh-wrong',
        'x-forwarded-for': ip,
      },
      body: { name: 'must not persist' },
    }, res, {
      supabase: {},
      getTenantContext: async () => tenantContext,
      hasAdminAccess: async () => true,
    });
    assert.equal(response.statusCode, 429);
    assert.equal(response.body.code, 'PROTECTED_FORM_RATE_LIMITED');
  } finally {
    if (originalSecret === undefined) delete process.env.BNMS_DEPT_SURVEY_SECRET;
    else process.env.BNMS_DEPT_SURVEY_SECRET = originalSecret;
  }
});