import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDirectoryExpression, matchesDirectoryExpression, validateDirectoryExpression } from '../../shared/directoryExpression.js';
import { directoryEligibleIds, revalidateDirectoryInclusion, projectDirectoryInclusion, canManageDirectoryConfiguration } from './directoryExpression.js';
import configHandler from '../dynamic-directory/config.js';
import { dynamicDirectoryHandler } from '../public/dynamic-directory.js';
import { isDirectoryOrganizationEligible } from './customObjectDirectory.js';

const leaf = (field_id, value) => ({ field_id, value });
const expression = { version: 1, root: { op: 'and', children: [
  leaf('partner', 'Partner'), { op: 'or', children: [leaf('application_status', 'A'), leaf('application_status', 'B')] },
] } };
test('directory writes preserve administrator and feature-authorized member access', async () => {
  const context = { tenantId: 'tenant', isAuthenticated: true, roleId: 'directory-manager', memberExcludedFeatures: ['other-feature'] };
  const dependencies = {
    hasAdminAccess: async () => false,
    hasFeatureAccess: async (role, feature, exclusions) => {
      assert.equal(role, 'directory-manager');
      assert.equal(feature, 'page_DynamicDirectoryManagement');
      assert.deepEqual(exclusions, ['other-feature']);
      return true;
    },
  };
  assert.equal(await canManageDirectoryConfiguration(context, dependencies), true);
  assert.equal(await canManageDirectoryConfiguration(context, { ...dependencies, hasFeatureAccess: async () => false }), false);
  assert.equal(await canManageDirectoryConfiguration({ ...context, roleId: null }, { ...dependencies, hasAdminAccess: async () => true }), true);
  assert.equal(await canManageDirectoryConfiguration({ ...context, isAuthenticated: false }, dependencies), false);
  assert.equal(await canManageDirectoryConfiguration({ ...context, tenantMismatch: true }, dependencies), false);
});

test('unfiltered legacy directories remain unrestricted in config, embeds, carousel and contacts', async () => {
  for (const filter_expression of [undefined, null]) {
    const state = fixture();
    Object.assign(state.dynamic_directory[0], { slug: 'legacy', filter_expression, filter_field_id: null, filter_value: null, allowed_role_ids: [] });
    state.organization = state.organization.slice(0, 3);
    state.preference_field = [];
    state.organization_preference_value = [];
    const db = database(state);
    const context = { tenantId: 'tenant', tenantUserId: 'admin', isAuthenticated: true };
    const dependencies = { supabase: db, getTenantContext: async () => context,
      resolveTenant: async () => ({ id: 'tenant' }), hasFeatureAccess: async () => true, resolveMemberExclusions: async () => [] };
    const directory = state.dynamic_directory[0];
    assert.equal(await directoryEligibleIds(db, 'tenant', directory), null);
    assert.deepEqual(await directoryEligibleIds(db, 'tenant', directory, ['org0', 'org1']), ['org0', 'org1']);
    function response() { return { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }
    const full = response();
    await configHandler({ method: 'GET', query: { slug: 'legacy' } }, full, dependencies);
    assert.equal(full.code, 200);
    assert.deepEqual(full.body.organizations.map(row => row.id), ['org0', 'org1', 'org2']);
    for (const mode of [undefined, 'carousel']) {
      const res = response();
      await dynamicDirectoryHandler({ method: 'GET', headers: {}, query: { slug: 'legacy', mode } }, res, dependencies);
      assert.equal(res.code, 200);
      assert.deepEqual(res.body.records.map(row => row.id), ['org0', 'org1', 'org2']);
    }
    assert.equal((await isDirectoryOrganizationEligible({ db, context, directory, organizationId: 'org0' })).id, 'org0');
  }
});
function database(state, failure) {
  return {
    rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find public.organization_carousel_snapshot' } }),
    from(table) {
    const predicates = []; let offset = 0; let end = Infinity;
    return {
      select() { return this; }, order() { return this; }, like() { return this; }, or() { return this; }, not() { return this; }, is() { return this; },
      eq(key, value) { predicates.push(row => row[key] === value); return this; },
      in(key, values) { predicates.push(row => values.includes(row[key])); return this; },
      limit(n) { end = n - 1; return this; },
      range(a, b) { offset = a; end = Math.min(b, a + 36); return this; },
      then(resolve) { return Promise.resolve(failure === table ? { error: new Error('fixture failure') } :
        { data: (state[table] || []).filter(row => predicates.every(p => p(row))).slice(offset, end + 1),
          count: (state[table] || []).filter(row => predicates.every(p => p(row))).length, error: null }).then(resolve); },
    };
  } };
}
function fixture() {
  return {
    dynamic_directory: [{ id: 'dir', tenant_id: 'tenant', entity_type: 'organization', is_active: true, filter_expression: expression }],
    preference_field: ['partner', 'application_status'].map(id => ({ id, tenant_id: 'tenant', entity_scope: 'organization', is_active: true, field_type: 'dropdown' })),
    organization: Array.from({ length: 1205 }, (_, i) => ({ id: `org${i}`, tenant_id: 'tenant' })),
    organization_preference_value: Array.from({ length: 1205 }, (_, i) => [
      { id: `${i}p`, organization_id: `org${i}`, field_id: 'partner', value: '["Partner"]' },
      { id: `${i}s`, organization_id: `org${i}`, field_id: 'application_status', value: i % 2 ? 'B' : 'C' },
    ]).flat(),
  };
}
test('Partner AND (status A OR status B), legacy, false and absent values', () => {
  const values = new Map([['partner', ['["Partner"]']], ['application_status', ['B']]]);
  assert.equal(matchesDirectoryExpression(expression, values), true);
  values.delete('partner');
  assert.equal(matchesDirectoryExpression(expression, values), false);
  const legacy = normalizeDirectoryExpression({ filter_field_id: 'bool', filter_value: false });
  assert.equal(matchesDirectoryExpression(legacy, new Map([['bool', ['no']]])), true);
  assert.equal(matchesDirectoryExpression(legacy, new Map()), false);
  assert.deepEqual(normalizeDirectoryExpression({ filter_expression: expression, filter_field_id: 'ignored' }), expression);
  assert.deepEqual(JSON.parse(JSON.stringify(expression)), expression);
});
test('full config, embed, carousel and contact gates share mixed eligibility without publishing hidden answers', async () => {
  const state = fixture();
  state.dynamic_directory[0].slug = 'partners';
  state.dynamic_directory[0].allowed_role_ids = [];
  state.organization = state.organization.slice(0, 8);
  const db = database(state);
  const context = { tenantId: 'tenant', tenantUserId: 'admin', isAuthenticated: true };
  const dependencies = { supabase: db, getTenantContext: async () => context,
    resolveTenant: async () => ({ id: 'tenant' }), hasFeatureAccess: async () => true, resolveMemberExclusions: async () => [] };
  function response() { return { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }
  const full = response();
  await configHandler({ method: 'GET', query: { slug: 'partners' } }, full, dependencies);
  assert.equal(full.code, 200);
  assert.deepEqual(full.body.organizations.map(row => row.id), ['org1', 'org3', 'org5', 'org7']);
  assert.deepEqual(full.body.allOrgPreferenceValues, []);
  assert.equal(Object.hasOwn(full.body.directory, 'filter_expression'), false);
  for (const mode of [undefined, 'carousel']) {
    const res = response();
    await dynamicDirectoryHandler({ method: 'GET', headers: {}, query: { slug: 'partners', mode } }, res, dependencies);
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.records.map(row => row.id), ['org1', 'org3', 'org5', 'org7']);
    assert.equal(JSON.stringify(res.body).includes('application_status'), false);
  }
  assert.equal(await isDirectoryOrganizationEligible({ db, context, directory: state.dynamic_directory[0], organizationId: 'org0' }), null);
  assert.equal((await isDirectoryOrganizationEligible({ db, context, directory: state.dynamic_directory[0], organizationId: 'org1' })).id, 'org1');
});
test('malformed, empty and oversized expressions never become unrestricted', () => {
  for (const value of [{}, { version: 2, root: expression.root }, { version: 1, root: { op: 'or', children: [] } },
    { version: 1, root: leaf('a', 'b') }, { version: 1, root: { op: 'and', children: Array(101).fill(leaf('a', false)) } }]) {
    assert.throws(() => validateDirectoryExpression(value));
    assert.throws(() => normalizeDirectoryExpression({ filter_expression: value, filter_field_id: 'a', filter_value: 'b' }));
  }
});
test('complete capped inventories, tenant scoped values and privacy projection', async () => {
  const state = fixture();
  state.organization.push({ id: 'foreign', tenant_id: 'other' });
  const ids = await directoryEligibleIds(database(state), 'tenant', state.dynamic_directory[0]);
  assert.equal(ids.length, 602);
  assert.ok(ids.includes('org1203'));
  assert.equal(ids.includes('foreign'), false);
  assert.equal(Object.hasOwn(projectDirectoryInclusion(state.dynamic_directory[0]), 'filter_expression'), false);
});
test('missing, inactive, wrong-scope, foreign and unsupported fields fail closed', async () => {
  for (const patch of [{ is_active: false }, { tenant_id: 'other' }, { entity_scope: 'member' }, { field_type: 'text' }]) {
    const state = fixture(); Object.assign(state.preference_field[0], patch);
    await assert.rejects(directoryEligibleIds(database(state), 'tenant', state.dynamic_directory[0]));
  }
  const state = fixture(); state.preference_field = [];
  await assert.rejects(directoryEligibleIds(database(state), 'tenant', state.dynamic_directory[0]));
});
test('failed eligibility reads do not return partial results; policy and value changes invalidate publication', async () => {
  const state = fixture(); const directory = structuredClone(state.dynamic_directory[0]);
  for (const table of ['preference_field', 'organization', 'organization_preference_value']) {
    await assert.rejects(directoryEligibleIds(database(state, table), 'tenant', directory));
  }
  assert.equal(await revalidateDirectoryInclusion(database(state), 'tenant', directory, ['org1']), true);
  state.organization_preference_value.find(row => row.id === '1s').value = 'C';
  assert.equal(await revalidateDirectoryInclusion(database(state), 'tenant', directory, ['org1']), false);
  state.dynamic_directory[0].filter_expression = { version: 1, root: { op: 'or', children: [leaf('partner', 'Other')] } };
  assert.equal(await revalidateDirectoryInclusion(database(state), 'tenant', directory, ['org1']), false);
});
