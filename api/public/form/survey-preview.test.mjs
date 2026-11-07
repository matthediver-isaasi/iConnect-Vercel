import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePublicForm } from './[slug].js';

async function request({ admin = false, authenticated = false, contextTenant = 'tenant', session = null,
  assigned = true, assignmentFailure = false, active = true, status = 'published',
  lifecycle = 'active', type = 'survey', requireAuth = false, access = true, snapshot = true,
  formRows = null } = {}) {
  const form = { id: 'form', tenant_id: 'tenant', slug: 'survey', form_type: type, is_active: active,
    archived_at: null, require_authentication: requireAuth, fields: [], pages: [], visibility_rules: [],
    survey_settings: { status, lifecycle_state: lifecycle, current_version: 2 } };
  const queries = [];
  const db = { from(table) {
    queries.push(table);
    const filters = [];
    const q = {
      select() { return q; },
      eq(key, value) { filters.push(row => row[key] === value); return q; },
      is(key, value) { filters.push(row => row[key] === value); return q; },
      limit() { return q; }, single() { return q; },
      maybeSingle() { return q; },
      then(resolve, reject) {
        const matchedForms = (formRows || [form]).filter(row => filters.every(filter => filter(row)));
        const data = table === 'form' ? structuredClone(matchedForms[0] || null)
          : table === 'survey_version' ? (snapshot ? { fields: [], pages: [], survey_settings: {}, version_number: 2 } : null)
          : table === 'event_survey_assignment' ? (assigned ? [{ id: 'assignment' }] : [])
          : null;
        return Promise.resolve({ data, error: table === 'form' && matchedForms.length !== 1
          ? { code: 'PGRST116' } : table === 'event_survey_assignment' && assignmentFailure
          ? { message: 'unavailable' } : null }).then(resolve, reject);
      },
    };
    return q;
  } };
  const res = { statusCode: 200, headers: {}, setHeader(k,v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handlePublicForm({ method: 'GET', query: { slug: 'survey', ...(authenticated ? { authenticated: '1' } : {}) } }, res, {
    db, resolveTenant: async () => ({ id: 'tenant' }),
    resolveAccess: async () => ({ allowed: access, restricted: false }),
    getTenantContext: async () => ({ isAuthenticated: admin || !!session, tenantId: contextTenant }),
    hasAdminAccess: async () => admin, getSession: async () => session,
  });
  return { res, queries };
}

test('tenant admin without a member or query flag can preview the published event survey', async () => {
  const { res, queries } = await request({ admin: true });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.survey_admin_preview, true);
  assert.equal(res.body.survey_settings.current_version, 2);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.ok(!queries.includes('event_survey_assignment'));
});

test('admin preview ignores dormant active flag and supports auth-required surveys without a member', async () => {
  const { res } = await request({ admin: true, active: false, requireAuth: true });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.survey_admin_preview, true);
  assert.deepEqual(res.body.fields, []);
});

test('guest, ordinary member, and foreign tenant admin must use the event link', async () => {
  for (const options of [{}, { authenticated: true }, { session: { id: 'session' }, authenticated: true },
    { admin: true, contextTenant: 'different-tenant', authenticated: true }]) {
    const { res } = await request(options);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'SURVEY_EVENT_LINK_REQUIRED');
    assert.equal(res.body.fields, undefined);
    assert.equal(res.body.survey_admin_preview, undefined);
  }
});

test('only tenant admins can preview drafts; ordinary published standalone surveys still load', async () => {
  assert.equal((await request({ admin: true, status: 'draft', lifecycle: 'draft' })).res.statusCode, 200);
  assert.equal((await request({ session: {}, authenticated: true, status: 'draft', lifecycle: 'draft' })).res.statusCode, 409);
  const { res } = await request({ assigned: false });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.survey_admin_preview, undefined);
});

test('missing published snapshot and archived survey remain unavailable to admin previews', async () => {
  assert.equal((await request({ admin: true, snapshot: false })).res.statusCode, 404);
  assert.equal((await request({ admin: true, status: 'archived', lifecycle: 'archived' })).res.statusCode, 404);
});

test('assignment discovery failure never grants ordinary survey access', async () => {
  assert.equal((await request({ assignmentFailure: true })).res.statusCode, 500);
});

test('ordinary inactive forms remain blocked even for administrators', async () => {
  assert.equal((await request({ admin: true, type: 'application', active: false })).res.statusCode, 404);
});

const publicQuestionnaire = {
  id: 'joining', tenant_id: 'tenant', slug: 'survey', form_type: 'standard',
  is_active: true, archived_at: null, fields: [], pages: [],
};

test('a public questionnaire resolves despite archived and foreign-tenant copies of its slug', async () => {
  for (const authenticated of [false, true]) {
    const { res } = await request({ authenticated, session: authenticated ? { id: 'session' } : null,
      formRows: [
        { ...publicQuestionnaire, id: 'archived', archived_at: '2026-09-30', is_active: false },
        { ...publicQuestionnaire, id: 'foreign', tenant_id: 'other-tenant' },
        publicQuestionnaire,
      ] });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.id, 'joining');
  }
});

test('archived-only URLs stay unavailable even if their old active flag is true', async () => {
  const { res } = await request({ formRows: [
    { ...publicQuestionnaire, archived_at: '2026-09-30' },
  ] });
  assert.equal(res.statusCode, 404);
});

test('duplicate unarchived URLs fail closed instead of selecting an arbitrary form', async () => {
  const { res } = await request({ formRows: [
    publicQuestionnaire, { ...publicQuestionnaire, id: 'duplicate' },
  ] });
  assert.equal(res.statusCode, 404);
});

test('archive filtering does not bypass access policy or scheduled deactivation', async () => {
  assert.equal((await request({ access: false, formRows: [publicQuestionnaire] })).res.statusCode, 403);
  assert.equal((await request({ formRows: [
    { ...publicQuestionnaire, deactivate_at: '2020-01-01T00:00:00Z' },
  ] })).res.statusCode, 404);
});
