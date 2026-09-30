import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPublicResourceAccess } from './publicResourceProjection.js';

test('private tenant-form resources never expose their FormView target', () => {
  const projected = projectPublicResourceAccess({
    id: 'resource-private-form',
    resource_type: 'tenant_form',
    is_public: false,
    target_url: '/FormView?slug=private-renewal',
  }, 'tenant.example.test');

  assert.equal(projected.target_url, null);
  assert.equal(projected.is_locked, true);
  assert.match(projected.login_redirect_url, /resourceId=resource-private-form$/);
});

test('public tenant-form resources retain their canonical FormView target', () => {
  const projected = projectPublicResourceAccess({
    id: 'resource-public-form',
    resource_type: 'tenant_form',
    is_public: true,
    target_url: '/FormView?slug=member-update',
  }, 'tenant.example.test');

  assert.equal(projected.target_url, '/FormView?slug=member-update');
  assert.equal(projected.is_locked, false);
  assert.equal(projected.login_redirect_url, null);
});