import assert from 'node:assert/strict';
import test from 'node:test';
import { handlePublishSurvey } from './publish-survey.js';
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

function noWriteDb() {
  const calls = [];
  return {
    calls,
    client: {
      from(table) { calls.push(['from', table]); throw new Error('unexpected database access'); },
      rpc(name) { calls.push(['rpc', name]); throw new Error('unexpected mutation'); },
    },
  };
}

test('publish-survey rejects wrong password before lookup or publish RPC', async () => {
  const db = noWriteDb();
  const { response, res } = responseRecorder();
  await handlePublishSurvey({
    method: 'POST',
    headers: { 'x-form-protection-password': 'wrong' },
    body: { form_id: PROTECTED_DEPARTMENT_FORM_ID },
  }, res, {
    supabase: db.client,
    getTenantContext: async () => ({
      isAuthenticated: true,
      tenantId: PROTECTED_DEPARTMENT_TENANT_ID,
      memberId: 'admin-1',
    }),
    hasAdminAccess: async () => true,
    env: { BNMS_DEPT_SURVEY_SECRET: 'correct' },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, 'PROTECTED_FORM_PASSWORD_INCORRECT');
  assert.deepEqual(db.calls, []);
});

test('publish-survey remains unchanged for unrelated forms', async () => {
  const queries = [];
  const form = {
    id: 'unrelated-form',
    tenant_id: 'tenant-1',
    form_type: 'survey',
    fields: [{
      id: 'score-1',
      type: 'score',
      label: 'Quality',
      score_style: 'numbers',
      score_min: 1,
      score_max: 5,
      weight: 1,
    }],
    pages: [],
    visibility_rules: [],
    survey_settings: {},
    survey_audit_log: [],
  };
  const db = {
    from(table) {
      const query = {
        select() { return this; },
        eq() { return this; },
        async single() { queries.push(['read', table]); return { data: form, error: null }; },
        async maybeSingle() { return { data: null, error: null }; },
      };
      return query;
    },
    async rpc(name) {
      queries.push(['rpc', name]);
      return {
        data: {
          version_id: 'version-1',
          version_number: 1,
          survey_settings: { status: 'published' },
          survey_audit_log: [],
        },
        error: null,
      };
    },
  };
  const { response, res } = responseRecorder();
  await handlePublishSurvey({
    method: 'POST',
    body: { form_id: form.id },
    headers: {},
  }, res, {
    supabase: db,
    getTenantContext: async () => ({
      isAuthenticated: true,
      tenantId: 'tenant-1',
      memberId: null,
      tenantUserId: null,
    }),
    hasAdminAccess: async () => true,
    env: {},
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(queries, [['read', 'form'], ['rpc', 'publish_survey']]);
});