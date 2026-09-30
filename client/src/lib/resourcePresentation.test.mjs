import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTenantFormResourceUrl,
  getResourceTypeLabel,
  getResourceTypeName,
  resolveResourceNewTab,
} from './resourcePresentation.js';

test('tenant-form resources target FormView and preserve URL-safe slugs', () => {
  assert.equal(
    buildTenantFormResourceUrl('renewal & prefill'),
    '/FormView?slug=renewal%20%26%20prefill',
  );
});

test('tenant forms preserve their resource-level new-tab choice on embedded surfaces', () => {
  assert.equal(resolveResourceNewTab({ resource_type: 'tenant_form', open_in_new_tab: false }, true), false);
  assert.equal(resolveResourceNewTab({ resource_type: 'tenant_form', open_in_new_tab: true }, false), true);
  assert.equal(resolveResourceNewTab({ resource_type: 'external_link', open_in_new_tab: false }, true), true);
});

test('tenant-form resources have a human CTA and type name', () => {
  assert.equal(getResourceTypeLabel('tenant_form'), 'Open Form');
  assert.equal(getResourceTypeName('tenant_form'), 'Tenant form');
  assert.equal(getResourceTypeLabel('video'), 'Watch Video');
  assert.equal(getResourceTypeLabel('external_link'), 'Visit Site');
});