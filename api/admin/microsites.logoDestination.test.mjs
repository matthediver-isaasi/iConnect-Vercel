import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  resolveMicrositeHeaderConfigUpdate,
  validateMicrositeHeaderLogoConfig,
} from '../_lib/microsites.js';

// Evaluate the actual route implementation while supplying every imported
// effect explicitly. This exercises its create/update normalization and write
// paths without loading the configured database client or making network calls.
const routeSource = readFileSync(new URL('./microsites.js', import.meta.url), 'utf8');
const implementation = routeSource
  .slice(routeSource.indexOf('async function getTenantHeaderConfig'))
  .replace('export default async function handler', 'async function handler');
const loadHandler = new Function(
  'getTenantContext',
  'hasAdminAccess',
  'hasFeatureAccess',
  'supabase',
  'validateMicrositePrefix',
  'isMissingMicrositeSchema',
  'sanitizeMicrositeBrandingConfig',
  'normalizeSearchResultsBranding',
  'resolveAllowedFontFamilies',
  'validateMicrositeHeaderLogoConfig',
  'resolveMicrositeHeaderConfigUpdate',
  `${implementation}\nreturn handler;`,
);

function createDatabase(existingHeaderConfig = {}) {
  const state = {
    microsite: {
      id: 'microsite-1',
      tenant_id: 'tenant-1',
      name: 'Existing',
      path_prefix: 'existing',
      header_config: structuredClone(existingHeaderConfig),
    },
    inserts: [],
    updates: [],
  };

  const supabase = {
    from(table) {
      let operation = 'select';
      let payload = null;
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        insert(value) {
          operation = 'insert';
          payload = structuredClone(value);
          return query;
        },
        update(value) {
          operation = 'update';
          payload = structuredClone(value);
          return query;
        },
        maybeSingle() {
          if (table === 'tenant') {
            return Promise.resolve({ data: { header_config: {} }, error: null });
          }
          if (table === 'microsite') {
            return Promise.resolve({ data: structuredClone(state.microsite), error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        single() {
          return execute(true);
        },
        then(resolve, reject) {
          return execute(false).then(resolve, reject);
        },
      };

      async function execute(single) {
        if (table === 'i_edit_page') return { data: [], error: null };
        if (table !== 'microsite') return { data: single ? null : [], error: null };
        if (operation === 'insert') {
          state.inserts.push(payload);
          state.microsite = { id: 'created-1', ...payload };
          return { data: structuredClone(state.microsite), error: null };
        }
        if (operation === 'update') {
          state.updates.push(payload);
          Object.assign(state.microsite, payload);
          return { data: structuredClone(state.microsite), error: null };
        }
        return {
          data: single ? structuredClone(state.microsite) : [structuredClone(state.microsite)],
          error: null,
        };
      }

      return query;
    },
  };

  return { supabase, state };
}

function setup(existingHeaderConfig = {}) {
  const { supabase, state } = createDatabase(existingHeaderConfig);
  const handler = loadHandler(
    async () => ({ isAuthenticated: true, tenantId: 'tenant-1', roleId: null }),
    async () => true,
    async () => false,
    supabase,
    () => ({ ok: true }),
    () => false,
    () => ({}),
    value => value,
    async () => [],
    validateMicrositeHeaderLogoConfig,
    resolveMicrositeHeaderConfigUpdate,
  );

  async function request(method, headerConfig, extraBody = {}) {
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
      end() {
        return this;
      },
    };
    await handler({
      method,
      query: method === 'PATCH' ? { id: 'microsite-1' } : {},
      body: {
        ...(method === 'POST' ? { name: 'New microsite', path_prefix: 'new-site' } : {}),
        header_config: headerConfig,
        ...extraBody,
      },
    }, response);
    return response;
  }

  return { request, state };
}

test('POST persists main-site logo destination', async () => {
  const fixture = setup();
  const response = await fixture.request('POST', {
    logoDestination: 'main_site_home',
    textColor: '#123456',
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(fixture.state.inserts[0].header_config, {
    logoDestination: 'main_site_home',
    textColor: '#123456',
  });
});

for (const method of ['POST', 'PATCH']) {
  test(`${method} rejects an invalid logo destination without writing`, async () => {
    const fixture = setup({ textColor: '#abcdef' });
    const response = await fixture.request(method, { logoDestination: 'tenant_home' });
    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /logoDestination/);
    assert.equal(fixture.state.inserts.length, 0);
    assert.equal(fixture.state.updates.length, 0);
  });
}

test('focused PATCH persists main destination and preserves unrelated config', async () => {
  const existing = {
    gradientStops: [{ color: '#112233', position: 0 }],
    secondaryBar: { enabled: true },
  };
  const fixture = setup(existing);
  const response = await fixture.request('PATCH', {
    logoDestination: 'main_site_home',
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(fixture.state.updates[0].header_config, {
    ...existing,
    logoDestination: 'main_site_home',
  });
});

for (const resetValue of [null, '', 'microsite_home']) {
  test(`PATCH reset ${JSON.stringify(resetValue)} omits the stored destination`, async () => {
    const fixture = setup({
      logoDestination: 'main_site_home',
      textColor: '#abcdef',
    });
    const response = await fixture.request('PATCH', {
      logoDestination: resetValue,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(fixture.state.updates[0].header_config, {
      textColor: '#abcdef',
    });
  });
}

test('full editor replacement resets destination while retaining submitted unrelated config', async () => {
  const fixture = setup({
    logoDestination: 'main_site_home',
    oldSetting: 'remove me',
  });
  const response = await fixture.request('PATCH', {
    logoDestination: 'microsite_home',
    gradientStops: [{ color: '#445566', position: 0 }],
    secondaryBar: { enabled: false },
  }, {
    replace_header_config: true,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(fixture.state.updates[0].header_config, {
    gradientStops: [{ color: '#445566', position: 0 }],
    secondaryBar: { enabled: false },
  });
});