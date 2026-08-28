import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeCpdTemplates, CPD_TEMPLATE_CAPABILITY } from './cpdCertificateTemplatesApi.js';
import { isResourceExcluded } from './roleVisibility.js';

test('CPD templates use a dedicated exclusion key', () => {
  assert.equal(CPD_TEMPLATE_CAPABILITY, 'cpd.certificate-templates');
  assert.equal(isResourceExcluded([CPD_TEMPLATE_CAPABILITY], CPD_TEMPLATE_CAPABILITY), true);
  assert.equal(isResourceExcluded(['admin.role-management'], CPD_TEMPLATE_CAPABILITY), false);
});

function roleDatabase(result, calls) {
  const chain = {
    select() { return this; },
    eq(column, value) { calls.push([column, value]); return this; },
    async maybeSingle() { return result; },
  };
  return { from(table) { calls.push(['table', table]); return chain; } };
}

const memberContext = {
  isAuthenticated: true,
  tenantId: 'tenant-a',
  memberId: 'member-a',
  roleId: 'role-a',
  memberExcludedFeatures: [],
};

test('authorization fails closed for unauthenticated, missing-role, and role lookup failures', async () => {
  const unauthenticated = await authorizeCpdTemplates({}, {
    getTenantContext: async () => ({ isAuthenticated: false }),
    supabase: roleDatabase({ data: null, error: null }, []),
  });
  assert.equal(unauthenticated.status, 401);

  const missingRole = await authorizeCpdTemplates({}, {
    getTenantContext: async () => ({
      ...memberContext,
      memberId: null,
      roleId: null,
      tenantUserId: 'tenant-user-owner',
      isSuperAdmin: true,
    }),
    supabase: roleDatabase({ data: null, error: null }, []),
  });
  assert.equal(missingRole.status, 403);

  const lookupFailure = await authorizeCpdTemplates({}, {
    getTenantContext: async () => memberContext,
    supabase: roleDatabase({ data: null, error: new Error('lookup failed') }, []),
  });
  assert.equal(lookupFailure.status, 403);
});

test('tenant-admin status alone never grants the portal capability', async () => {
  const result = await authorizeCpdTemplates({}, {
    getTenantContext: async () => ({
      isAuthenticated: true,
      tenantId: 'tenant-a',
      tenantUserId: 'tenant-user-owner',
      isSuperAdmin: true,
      memberId: null,
      roleId: null,
      memberExcludedFeatures: [],
    }),
    supabase: roleDatabase({ data: { excluded_features: [] }, error: null }, []),
  });
  assert.equal(result.status, 403);
});

test('authorization enforces role, member, and parent-module exclusions', async () => {
  for (const { roleExcluded = [], memberExcluded = [] } of [
    { roleExcluded: [CPD_TEMPLATE_CAPABILITY] },
    { memberExcluded: [CPD_TEMPLATE_CAPABILITY] },
    { roleExcluded: ['cpd'] },
  ]) {
    const result = await authorizeCpdTemplates({}, {
      getTenantContext: async () => ({ ...memberContext, memberExcludedFeatures: memberExcluded }),
      supabase: roleDatabase({ data: { excluded_features: roleExcluded }, error: null }, []),
    });
    assert.equal(result.status, 403);
  }
});

test('authorization grants a portal role and scopes its lookup to the request tenant', async () => {
  const calls = [];
  const result = await authorizeCpdTemplates({}, {
    getTenantContext: async () => memberContext,
    supabase: roleDatabase({ data: { excluded_features: [] }, error: null }, calls),
  });
  assert.equal(result.context, memberContext);
  assert.deepEqual(calls, [
    ['table', 'role'],
    ['id', 'role-a'],
    ['tenant_id', 'tenant-a'],
  ]);
});

test('a tenant user linked to a permitted member role is authorized', async () => {
  const linkedTenantUser = {
    ...memberContext,
    tenantUserId: 'tenant-user-owner',
  };
  const result = await authorizeCpdTemplates({}, {
    getTenantContext: async () => linkedTenantUser,
    supabase: roleDatabase({ data: { excluded_features: [] }, error: null }, []),
  });
  assert.equal(result.context, linkedTenantUser);
});