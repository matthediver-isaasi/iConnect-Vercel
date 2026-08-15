// Tests for linkPrimaryOrgLogo in demo-seeds/logos.mjs
// Run: node --test demo-seeds/logos.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkPrimaryOrgLogo } from './logos.mjs';

const TENANT_ID = 't-demo';
const PRIMARY_ORG_ID = 'org-primary';
const BRANDING_LOGO = 'https://cdn.example.com/logos/aesp.png';

/**
 * Minimal chainable supabase mock. Supports select/update/insert/maybeSingle
 * and the filters used by linkPrimaryOrgLogo + resolveDemoPrimaryOrganizationId.
 *
 * `tables` is a map of tableName -> array of row objects.
 * `updates` accumulates { table, filters, patch } for assertions.
 */
function mockSb({ tables = {}, updates = [], errors = {} } = {}) {
  const from = (table) => {
    const state = { table, filters: {}, nullFilters: {}, patch: null, op: 'select' };

    const chain = {
      select: () => chain,
      update: (patch) => { state.op = 'update'; state.patch = patch; return chain; },
      insert: () => { state.op = 'insert'; return chain; },
      eq: (k, v) => { state.filters[k] = v; return chain; },
      is: (k, v) => { state.nullFilters[k] = v; return chain; },  // is(col, null)
      limit: () => chain,
      order: () => chain,
      maybeSingle: async () => {
        if (errors[table]) return { data: null, error: errors[table] };
        const rows = resolve();
        return { data: rows[0] || null, error: null };
      },
      single: async () => {
        if (errors[table]) return { data: null, error: errors[table] };
        const rows = resolve();
        return { data: rows[0] || null, error: null };
      },
      // Awaiting the chain directly (for .select() terminal or .delete().then())
      then: (res) => Promise.resolve(run()).then(res),
    };

    const resolve = () => {
      const all = tables[table] || [];
      return all.filter(r =>
        Object.entries(state.filters).every(([k, v]) => r[k] === v) &&
        Object.entries(state.nullFilters).every(([k, v]) => v === null ? r[k] == null : r[k] != null)
      );
    };

    const run = () => {
      if (errors[table]) return { data: null, error: errors[table] };
      if (state.op === 'update') {
        const matched = resolve();
        updates.push({ table, filters: { ...state.filters }, nullFilters: { ...state.nullFilters }, patch: state.patch });
        // Apply update in-place for subsequent reads.
        for (const row of matched) Object.assign(row, state.patch);
        return { data: matched.map(r => ({ id: r.id })), error: null };
      }
      return { data: resolve(), error: null };
    };

    return chain;
  };

  return { from };
}

// ---------------------------------------------------------------------------
// linkPrimaryOrgLogo tests
// ---------------------------------------------------------------------------

test('branding logo present → primary org logo is linked (fill-null)', async () => {
  const tables = {
    organization: [
      { id: PRIMARY_ORG_ID, tenant_id: TENANT_ID, name: 'AESP', logo_url: null, is_primary: true },
    ],
    tenant: [
      { id: TENANT_ID, logo_url: BRANDING_LOGO, header_logo_url: null },
    ],
  };
  const updates = [];
  const logs = [];

  const result = await linkPrimaryOrgLogo({
    sb: mockSb({ tables, updates }),
    tenantId: TENANT_ID,
    log: (msg) => logs.push(msg),
  });

  assert.equal(result, true, 'should return true when logo is linked');
  assert.equal(updates.length, 1, 'exactly one UPDATE should fire');
  assert.equal(updates[0].table, 'organization');
  assert.equal(updates[0].patch.logo_url, BRANDING_LOGO);
  assert.equal(updates[0].filters.id, PRIMARY_ORG_ID);
  // compare-and-set: IS NULL filter must be present
  assert.ok('logo_url' in updates[0].nullFilters, 'update must re-check logo_url IS NULL');
  assert.ok(logs.some(l => /linked to tenant branding logo/i.test(l)), 'should log success');
});

test('primary org already has a logo → untouched, returns false', async () => {
  const existingLogo = 'https://cdn.example.com/logos/existing.png';
  const tables = {
    organization: [
      { id: PRIMARY_ORG_ID, tenant_id: TENANT_ID, name: 'AESP', logo_url: existingLogo, is_primary: true },
    ],
    tenant: [
      { id: TENANT_ID, logo_url: BRANDING_LOGO, header_logo_url: null },
    ],
  };
  const updates = [];
  const logs = [];

  const result = await linkPrimaryOrgLogo({
    sb: mockSb({ tables, updates }),
    tenantId: TENANT_ID,
    log: (msg) => logs.push(msg),
  });

  assert.equal(result, false, 'should return false when org already has a logo');
  assert.equal(updates.length, 0, 'no UPDATE should fire when logo already set');
  assert.ok(logs.some(l => /already has a logo/i.test(l)), 'should log that existing logo is kept');
});

test('tenant has no branding logo → warns and returns false without touching the org', async () => {
  const tables = {
    organization: [
      { id: PRIMARY_ORG_ID, tenant_id: TENANT_ID, name: 'AESP', logo_url: null, is_primary: true },
    ],
    tenant: [
      { id: TENANT_ID, logo_url: null, header_logo_url: null },
    ],
  };
  const updates = [];
  const logs = [];

  const result = await linkPrimaryOrgLogo({
    sb: mockSb({ tables, updates }),
    tenantId: TENANT_ID,
    log: (msg) => logs.push(msg),
  });

  assert.equal(result, false, 'should return false when no branding logo');
  assert.equal(updates.length, 0, 'no UPDATE should fire when tenant has no logo');
  assert.ok(logs.some(l => /no branding logo/i.test(l)), 'should warn about missing branding logo');
});

test('header_logo_url used as fallback when logo_url is absent', async () => {
  const HEADER_LOGO = 'https://cdn.example.com/logos/header.png';
  const tables = {
    organization: [
      { id: PRIMARY_ORG_ID, tenant_id: TENANT_ID, name: 'AESP', logo_url: null, is_primary: true },
    ],
    tenant: [
      { id: TENANT_ID, logo_url: null, header_logo_url: HEADER_LOGO },
    ],
  };
  const updates = [];

  const result = await linkPrimaryOrgLogo({
    sb: mockSb({ tables, updates }),
    tenantId: TENANT_ID,
  });

  assert.equal(result, true, 'should return true using header_logo_url fallback');
  assert.equal(updates[0]?.patch?.logo_url, HEADER_LOGO, 'should use header_logo_url as the logo');
});
