import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normalizeCanvasSwatches } from '../_lib/microsites.js';
import {
  MOBILE_HEADER_HEIGHT_ERROR,
  validateMobileHeaderHeight,
} from '../../shared/mobileHeaderHeight.js';

// Evaluate the real route while explicitly supplying imported effects. This
// exercises validation and JSONB merge/reset behavior without a database.
const routeSource = readFileSync(new URL('./tenant-branding.js', import.meta.url), 'utf8');
const implementation = routeSource
  .replace(/^import .*;$/gm, '')
  .replace('export default async function handler', 'async function handler');
const loadHandler = new Function(
  'getTenantContext',
  'hasAdminAccess',
  'supabase',
  'clearTenantCache',
  'normalizeCanvasSwatches',
  'validateMobileHeaderHeight',
  `${implementation}\nreturn handler;`,
);

function setup(existingHeaderConfig = {}) {
  const state = {
    tenant: {
      id: 'tenant-1',
      slug: null,
      domain: null,
      header_config: structuredClone(existingHeaderConfig),
      footer_config: {},
      branding_config: {},
      platform_branding: {},
    },
    updates: [],
  };

  const supabase = {
    from(table) {
      let operation = 'select';
      let payload;
      const query = {
        select() { return query; },
        eq() { return query; },
        update(value) {
          operation = 'update';
          payload = structuredClone(value);
          return query;
        },
        async single() {
          if (table !== 'tenant') return { data: null, error: null };
          if (operation === 'update') {
            state.updates.push(payload);
            Object.assign(state.tenant, payload);
          }
          return { data: structuredClone(state.tenant), error: null };
        },
        then(resolve, reject) {
          return Promise.resolve({
            data: table === 'installed_font' ? [] : [structuredClone(state.tenant)],
            error: null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };

  const handler = loadHandler(
    async () => ({ isAuthenticated: true, tenantId: 'tenant-1' }),
    async () => true,
    supabase,
    () => {},
    normalizeCanvasSwatches,
    validateMobileHeaderHeight,
  );

  async function patch(headerConfig) {
    const response = {
      statusCode: 200,
      setHeader() {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
      end() { return this; },
    };
    await handler({
      method: 'PATCH',
      headers: {},
      body: { header_config: headerConfig },
    }, response);
    return response;
  }

  return { patch, state };
}

test('persists a valid mobile header height while preserving existing config', async () => {
  const fixture = setup({ topBarHeight: 80 });
  const response = await fixture.patch({ mobileHeaderHeight: '128' });

  assert.equal(response.statusCode, 200);
  assert.equal(fixture.state.updates.length, 1);
  assert.deepEqual(fixture.state.updates[0].header_config, {
    topBarHeight: 80,
    mobileHeaderHeight: 128,
  });
});

test('empty mobile header height deletes the override after config merge', async () => {
  const fixture = setup({ topBarHeight: 80, mobileHeaderHeight: 144 });
  const response = await fixture.patch({ mobileHeaderHeight: null });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(fixture.state.updates[0].header_config, { topBarHeight: 80 });
});

test('invalid mobile header height returns the shared error and does not write', async () => {
  const fixture = setup({ mobileHeaderHeight: 96 });
  const response = await fixture.patch({ mobileHeaderHeight: 96.5 });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, MOBILE_HEADER_HEIGHT_ERROR);
  assert.equal(fixture.state.updates.length, 0);
});

test('omitting mobile header height preserves the existing override', async () => {
  const fixture = setup({ mobileHeaderHeight: 104, topBarHeight: 72 });
  const response = await fixture.patch({ topBarHeight: 88 });

  assert.equal(response.statusCode, 200);
  assert.equal(fixture.state.updates[0].header_config.mobileHeaderHeight, 104);
  assert.equal(fixture.state.updates[0].header_config.topBarHeight, 88);
});