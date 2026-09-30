import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCanvasDashboardEmbed,
  isSharedTenantWidget,
  setCanvasDashboardNoStore,
} from './permissions.js';

test('Canvas dashboard embedding is opt-in and recognises repeated query values safely', () => {
  assert.equal(isCanvasDashboardEmbed({ query: { embed: 'canvas' } }), true);
  assert.equal(isCanvasDashboardEmbed({ query: { embed: 'Canvas' } }), true);
  assert.equal(isCanvasDashboardEmbed({ query: { embed: ['other', 'canvas'] } }), true);
  assert.equal(isCanvasDashboardEmbed({ query: { embed: 'true' } }), false);
  assert.equal(isCanvasDashboardEmbed({ query: {} }), false);
});

test('Canvas references accept only shared widgets in the current tenant', () => {
  const actor = { tenantId: 'tenant-1' };

  assert.equal(isSharedTenantWidget(
    { scope: 'shared', tenant_id: 'tenant-1' },
    actor,
  ), true);
  assert.equal(isSharedTenantWidget(
    { scope: 'personal', tenant_id: 'tenant-1' },
    actor,
  ), false);
  assert.equal(isSharedTenantWidget(
    { scope: 'shared', tenant_id: 'tenant-2' },
    actor,
  ), false);
  assert.equal(isSharedTenantWidget(
    { scope: 'shared', tenant_id: null },
    { tenantId: null },
  ), true);
  assert.equal(isSharedTenantWidget(
    { scope: 'shared', tenant_id: 'tenant-1' },
    { tenantId: null },
  ), false);
});

test('Canvas dashboard responses are marked private and no-store', () => {
  const res = {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };

  setCanvasDashboardNoStore({ query: { embed: 'canvas' } }, res);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');

  const regularResponse = {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
  setCanvasDashboardNoStore({ query: {} }, regularResponse);
  assert.deepEqual(regularResponse.headers, {});
});