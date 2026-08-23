import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TENANT_FORM_RESOURCE_TYPE,
  buildTenantFormResourceUrl,
  getTenantFormSlugFromTarget,
  normalizeTenantFormResourceTarget,
} from './resourceFormTarget.js';

function mockSupabase(form) {
  const chain = {
    select() { return chain; },
    eq() { return chain; },
    async maybeSingle() { return { data: form, error: null }; },
  };
  return { from() { return chain; } };
}

test('tenant form resources use the canonical standalone FormView route', () => {
  assert.equal(TENANT_FORM_RESOURCE_TYPE, 'tenant_form');
  assert.equal(
    buildTenantFormResourceUrl('member update & consent'),
    '/FormView?slug=member%20update%20%26%20consent',
  );
});

test('only a standalone FormView target is accepted as a tenant form target', () => {
  assert.equal(getTenantFormSlugFromTarget('/FormView?slug=member-update'), 'member-update');
  assert.equal(getTenantFormSlugFromTarget('https://example.com/FormView?slug=member-update'), 'member-update');
  assert.equal(getTenantFormSlugFromTarget('/form/member-update'), null);
  assert.equal(getTenantFormSlugFromTarget('https://elsewhere.example/form?slug=member-update'), null);
});

test('tenant ownership validation regenerates the canonical target', async () => {
  const resourceBody = {
    resource_type: 'tenant_form',
    target_url: 'https://other-host.example/FormView?slug=member-update',
  };
  const result = await normalizeTenantFormResourceTarget({
    supabase: mockSupabase({ id: 'form-1', slug: 'member-update' }),
    tenantId: 'tenant-1',
    resourceBody,
  });
  assert.equal(result.ok, true);
  assert.equal(resourceBody.target_url, '/FormView?slug=member-update');
});

test('an unavailable or cross-tenant form is rejected', async () => {
  const resourceBody = {
    resource_type: 'tenant_form',
    target_url: '/FormView?slug=another-tenant-form',
  };
  const result = await normalizeTenantFormResourceTarget({
    supabase: mockSupabase(null),
    tenantId: 'tenant-1',
    resourceBody,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test('unrelated patches do not strand a resource whose form was later deactivated', async () => {
  const result = await normalizeTenantFormResourceTarget({
    supabase: {
      from() {
        throw new Error('form lookup should not run for an unrelated patch');
      },
    },
    tenantId: 'tenant-1',
    resourceBody: { title: 'Updated title' },
    existingResource: {
      resource_type: 'tenant_form',
      target_url: '/FormView?slug=old-form',
    },
  });
  assert.equal(result.ok, true);
});