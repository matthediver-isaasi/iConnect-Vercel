import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Bundle the real handler and permission policy with a tenant-filter-aware
// in-memory database and synthetic session context. No live deletion is possible.
globalThis.fetch = async () => { throw new Error('No network allowed in deletion fixtures'); };
const slot = '__formSubmissionDeletionFixture';
globalThis[slot] = {
  from(table) {
    assert.equal(table, 'role_access_item');
    return { select: async () => ({ data: [], error: null }) };
  },
};
const bundle = await build({
  entryPoints: [resolve('api/entities/[entity]/[id].js')],
  bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external',
  plugins: [{
    name: 'synthetic-database-only',
    setup(builder) {
      builder.onResolve({ filter: /database\.js$/ }, args => ({ path: args.path, namespace: 'fixture-db' }));
      // Isolate the session dependency graph (as in organization deletion
      // handler tests); the new authorization policy and role hierarchy stay real.
      builder.onResolve({ filter: /tenantContext\.js$/ }, () => ({ path: 'tenant-context', namespace: 'fixture-context' }));
      builder.onResolve({ filter: /\/_lib\/session\.js$/ }, () => ({ path: 'session', namespace: 'fixture-context' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture-context' }, args => ({
        loader: 'js',
        contents: args.path === 'tenant-context' ? `
          export const TENANT_SCOPE = { GLOBAL: 'global', TENANT: 'tenant', ORGANIZATION: 'organization', MEMBER: 'member' };
          export const getTenantContext = async () => { throw new Error('Use injected fixture context'); };
          export const getEntityTenantScope = () => TENANT_SCOPE.TENANT;
          export const getTenantColumn = () => 'tenant_id';
          export const hasAdminAccess = async () => false;
          export const hasFeatureAccess = async () => false;
          export const checkCrossOrgPermissions = async () => ({ hasCrossOrgAccess: false });
          export const checkCrossMemberPermissions = async () => ({ hasCrossMemberAccess: false });
        ` : `
          export const getSession = async () => null;
          export const invalidateMemberSessions = async () => {};
          export const invalidateOrganizationMemberSessions = async () => {};
          export const revokeBlockedOrganisationMemberSessionsForTenant = async () => {};
        `,
      }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture-db' }, () => ({
        contents: `export const supabase = { from: (...args) => globalThis.${slot}.from(...args) };`,
        loader: 'js',
      }));
    },
  }],
});
const directory = resolve('generated-artifacts');
await mkdir(directory, { recursive: true });
const output = resolve(directory, `form-submission-delete-handler-${process.pid}.mjs`);
await writeFile(output, bundle.outputFiles[0].text);
let handler;
try { handler = (await import(pathToFileURL(output).href)).default; }
finally { await unlink(output); }

async function invoke({ context = {}, excluded = [], roleError = false, roleMissing = false, formType = 'standard', submissionTenant = 'fixture-tenant', entity = 'FormSubmission' } = {}) {
  const writes = [];
  const reads = [];
  const ctx = {
    isAuthenticated: true, tenantId: 'fixture-tenant', memberId: 'fixture-member', roleId: 'fixture-role',
    memberExcludedFeatures: [], ...context,
  };
  const rows = {
    role: roleMissing ? [] : [{ id: 'fixture-role', tenant_id: 'fixture-tenant', excluded_features: excluded }],
    form: [{ id: 'fixture-form', tenant_id: 'fixture-tenant', form_type: formType }],
    form_submission: [{ id: 'fixture-submission', tenant_id: submissionTenant, form_id: 'fixture-form' }],
    role_access_item: [],
  };
  const db = {
    from(table) {
      assert.ok(Object.hasOwn(rows, table), `Unexpected database table ${table}`);
      const filters = [];
      let deleting = false;
      const result = single => {
        const matched = rows[table].filter(row => filters.every(([key, value]) => row[key] === value));
        if (deleting) writes.push({ table, filters: [...filters], ids: matched.map(row => row.id) });
        else reads.push({ table, filters: [...filters] });
        return { data: single ? matched[0] || null : matched, error: table === 'role' && roleError ? { message: 'Synthetic role failure' } : null };
      };
      const query = {
        select() { return this; },
        eq(key, value) { filters.push([key, value]); return this; },
        delete() { deleting = true; return this; },
        single() { return Promise.resolve(result(true)); },
        maybeSingle() { return Promise.resolve(result(true)); },
        then(resolveResult, reject) { return Promise.resolve(result(false)).then(resolveResult, reject); },
      };
      return query;
    },
  };
  globalThis[slot] = db;
  const response = { statusCode: 200, body: null };
  await handler({ method: 'DELETE', query: { entity, id: 'fixture-submission' }, headers: {} }, {
    status(code) { response.statusCode = code; return this; },
    json(body) { response.body = body; return body; },
  }, { supabase: db, getTenantContext: async () => ctx });
  return { ...response, writes, reads };
}

test('real DELETE rejects a logged-in portal member lacking submission-management access', async () => {
  for (const excluded of [['forms.submissions'], ['page_FormSubmissions'], ['forms']]) {
    const result = await invoke({ excluded });
    assert.equal(result.statusCode, 403);
    assert.match(result.body.error, /management access required/);
    assert.deepEqual(result.writes, []);
    assert.equal(result.reads.some(read => read.table === 'form_submission'), false);
  }
});

test('real DELETE rejects member overrides and missing or failed roles, including entity aliases', async () => {
  for (const options of [
    { context: { memberExcludedFeatures: ['forms.submissions'] } },
    { context: { roleId: null } }, { roleMissing: true }, { roleError: true },
    { context: { roleId: 'other-tenant-role' } },
    { entity: 'form_submission', excluded: ['forms.submissions'] },
  ]) {
    const result = await invoke(options);
    assert.equal(result.statusCode, 403);
    assert.deepEqual(result.writes, []);
  }
});

test('real DELETE requires authentication and preserves the tenant-switch guard', async () => {
  for (const [context, status] of [
    [{ isAuthenticated: false }, 401], [{ tenantId: null }, 401], [{ tenantMismatch: true }, 409],
  ]) {
    const result = await invoke({ context });
    assert.equal(result.statusCode, status);
    assert.deepEqual(result.writes, []);
  }
});

test('real DELETE allows submission managers and tenant dashboard users', async () => {
  for (const context of [{}, { tenantUserId: 'fixture-operator', roleId: null }]) {
    const result = await invoke({ context });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.writes.length, 1);
    assert.deepEqual(result.writes[0].ids, ['fixture-submission']);
  }
});

test('authorized managers can delete surveys, but not cross-tenant submissions', async () => {
  const survey = await invoke({ formType: 'survey' });
  assert.equal(survey.statusCode, 200);
  assert.deepEqual(survey.writes[0].ids, ['fixture-submission']);
  for (const [options, status] of [
    [{ submissionTenant: 'other-tenant' }, 404],
    [{ formType: 'survey', submissionTenant: 'other-tenant' }, 404],
    [{ formType: 'survey', excluded: ['forms.submissions'] }, 403],
  ]) {
    const result = await invoke(options);
    assert.equal(result.statusCode, status);
    assert.deepEqual(result.writes, []);
  }
});
