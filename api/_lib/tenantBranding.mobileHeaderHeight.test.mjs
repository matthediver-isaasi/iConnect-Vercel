import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTenantBrandingPayload } from './tenantBranding.js';

const tenant = {
  id: 'tenant-1',
  name: 'Tenant',
  slug: 'tenant',
  footer_source: 'configured',
  header_config: {
    mobileHeaderHeight: 112,
    topBarHeight: 80,
  },
};

test('public tenant branding payload delivers the tenant mobile header height', async () => {
  const payload = await resolveTenantBrandingPayload(tenant);

  assert.equal(payload.headerConfig.mobileHeaderHeight, 112);
  assert.equal(payload.headerConfig.topBarHeight, 80);
});

test('microsite branding inherits the tenant mobile header height when not overridden', async () => {
  const payload = await resolveTenantBrandingPayload(tenant, {
    id: 'microsite-1',
    name: 'Microsite',
    path_prefix: 'microsite',
    footer_source: 'inherit',
    header_config: { topBarHeight: 96 },
  });

  assert.equal(payload.headerConfig.mobileHeaderHeight, 112);
  assert.equal(payload.headerConfig.topBarHeight, 96);
});