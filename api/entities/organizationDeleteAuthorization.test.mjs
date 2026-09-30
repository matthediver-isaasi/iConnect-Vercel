import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unlink, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

const fixtureSlot = '__organizationDeleteAuthorizationFixture';

async function loadHandler() {
  const result = await build({
    entryPoints: [resolve('api/entities/[entity]/[id].js')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    plugins: [{
      name: 'organization-delete-authorization-fixture',
      setup(builder) {
        builder.onResolve({ filter: /database\.js$/ }, args => ({
          path: args.path, namespace: 'fixture',
        }));
        builder.onResolve({ filter: /tenantContext\.js$/ }, args => ({
          path: args.path, namespace: 'fixture',
        }));
        builder.onResolve({ filter: /\/_lib\/session\.js$/ }, args => ({
          path: args.path, namespace: 'fixture',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => {
          if (args.path.endsWith('/database.js')) {
            return {
              loader: 'js',
              contents: `export const supabase = { from: (...args) => globalThis.${fixtureSlot}.db.from(...args) };`,
            };
          }
          if (args.path.endsWith('/tenantContext.js')) {
            return {
              loader: 'js',
              contents: `
                export const TENANT_SCOPE = {
                  GLOBAL: 'global', TENANT: 'tenant',
                  ORGANIZATION: 'organization', MEMBER: 'member'
                };
                export const getTenantContext = async () => globalThis.${fixtureSlot}.tenantContext;
                export const getEntityTenantScope = () => TENANT_SCOPE.TENANT;
                export const getTenantColumn = () => 'tenant_id';
                export const hasAdminAccess = async ctx => ctx.admin === true;
                export const hasFeatureAccess = async () => false;
                export const checkCrossOrgPermissions = async () => ({ hasCrossOrgAccess: false });
                export const checkCrossMemberPermissions = async () => ({ hasCrossMemberAccess: false });
              `,
            };
          }
          return {
            loader: 'js',
            contents: `
              export const getSession = async () => null;
              export const invalidateMemberSessions = async id => {
                globalThis.${fixtureSlot}.invalidated.push(id);
              };
              export const invalidateOrganizationMemberSessions = async () => {};
              export const revokeBlockedOrganisationMemberSessionsForTenant = async () => {};
            `,
          };
        });
      },
    }],
  });
  const outputPath = resolve('tmp', `organization-delete-authorization-${process.pid}.mjs`);
  await writeFile(outputPath, result.outputFiles[0].text);
  try {
    return (await import(`${pathToFileURL(outputPath).href}?v=${Date.now()}`)).default;
  } finally {
    await unlink(outputPath);
  }
}

const handler = await loadHandler();

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

function database(organization) {
  const mutations = [];
  const calls = [];
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.operation = 'select';
    }
    select() { return this; }
    eq(key, value) { this.filters.push([key, value]); return this; }
    in(key, values) { this.filters.push([key, values]); return this; }
    update(payload) { this.operation = 'update'; this.payload = payload; return this; }
    delete() { this.operation = 'delete'; return this; }
    matchingOrganization() {
      return this.table === 'organization'
        && this.filters.every(([key, value]) => organization?.[key] === value);
    }
    result(single = false) {
      if (this.operation !== 'select') {
        mutations.push({ table: this.table, operation: this.operation, filters: this.filters });
        return { data: null, error: null };
      }
      let data = [];
      if (this.matchingOrganization()) data = [organization];
      if (this.table === 'member') data = [];
      return { data: single ? data[0] || null : data, error: single && !data.length ? { code: 'PGRST116' } : null };
    }
    async single() { return this.result(true); }
    async maybeSingle() { return this.result(true); }
    then(resolve, reject) { return Promise.resolve(this.result()).then(resolve, reject); }
  }
  return { from(table) { calls.push(table); return new Query(table); }, mutations, calls };
}

async function invoke({ organization, tenantId = 'tenant-a', admin = true }) {
  const db = database(organization);
  globalThis[fixtureSlot] = {
    db,
    tenantContext: { isAuthenticated: true, tenantId, memberId: 'member', admin },
    invalidated: [],
  };
  const { response, res } = responseRecorder();
  await handler({
    method: 'DELETE',
    query: { entity: 'Organization', id: organization?.id || 'org-a' },
    body: {},
    headers: {},
  }, res);
  return { response, db };
}

test('organization DELETE allows an admin to delete a tenant-owned non-primary organization', async () => {
  const result = await invoke({
    organization: { id: 'org-a', tenant_id: 'tenant-a', is_primary: false, name: 'Branch' },
  });
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.response.body.success, true);
  assert.ok(result.db.mutations.some(({ table, operation }) =>
    table === 'organization' && operation === 'delete'));
});

test('organization DELETE denies a primary organization', async () => {
  const result = await invoke({
    organization: { id: 'org-a', tenant_id: 'tenant-a', is_primary: true, name: 'Primary' },
  });
  assert.equal(result.response.statusCode, 403);
  assert.equal(result.response.body.error, 'Cannot delete primary organization');
  assert.equal(result.db.mutations.length, 0);
});

test('organization DELETE hides a cross-tenant organization', async () => {
  const result = await invoke({
    organization: { id: 'org-a', tenant_id: 'tenant-b', is_primary: false, name: 'Other' },
  });
  assert.equal(result.response.statusCode, 404);
  assert.equal(result.response.body.error, 'Not found or access denied');
  assert.equal(result.db.mutations.length, 0);
});

test('organization DELETE denies a non-admin before database access', async () => {
  const result = await invoke({
    organization: { id: 'org-a', tenant_id: 'tenant-a', is_primary: false, name: 'Branch' },
    admin: false,
  });
  assert.equal(result.response.statusCode, 403);
  assert.equal(result.response.body.error, 'Admin access required');
  assert.deepEqual(result.db.calls, []);
  assert.equal(result.db.mutations.length, 0);
});