import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyOrganizationFilter,
  configuredOrganizationFilterOptions,
  conditionalRuleMatches,
  intersectConditionalOptions,
  mergeOrganizationFilterOptions,
  normalizeConditionalValue,
  projectConditionalSourceValues,
  removeInvalidConditionalValue,
  resolveConditionalFilters,
} from './formConditionalFilters.js';
import { initializeCommunicationPreferenceDefaults } from './formCommunicationPreferenceDefaults.js';

const rule = (overrides = {}) => ({
  id: 'rule',
  source_field_id: 'source',
  operator: 'equals',
  value: 'x',
  is_fallback: false,
  allowed_values: [],
  org_filter: null,
  ...overrides,
});

test('normalizes scalar, boolean, number, value objects, and arrays', () => {
  assert.deepEqual(normalizeConditionalValue([{ value: 2 }, true, 'Yes']), [2, true, 'Yes']);
});

test('supports comparison, membership, inclusion, and emptiness operators', () => {
  assert.equal(conditionalRuleMatches({ operator: 'equals', value: true }, true), true);
  assert.equal(conditionalRuleMatches({ operator: 'not_equals', value: 2 }, 3), true);
  assert.equal(conditionalRuleMatches({ operator: 'includes', value: 'alp' }, 'alpha'), true);
  assert.equal(conditionalRuleMatches({ operator: 'not_includes', value: 'z' }, ['a', 'b']), true);
  assert.equal(conditionalRuleMatches({ operator: 'in', value: ['a', 'b'] }, 'b'), true);
  assert.equal(conditionalRuleMatches({ operator: 'not_in', value: ['a'] }, ['b']), true);
  assert.equal(conditionalRuleMatches({ operator: 'greater_than', value: 3 }, 4), true);
  assert.equal(conditionalRuleMatches({ operator: 'greater_or_equal', value: 4 }, 4), true);
  assert.equal(conditionalRuleMatches({ operator: 'less_than', value: 4 }, 3), true);
  assert.equal(conditionalRuleMatches({ operator: 'less_or_equal', value: 3 }, 3), true);
  assert.equal(conditionalRuleMatches({ operator: 'is_empty' }, []), true);
  assert.equal(conditionalRuleMatches({ operator: 'is_not_empty' }, { value: 'x' }), true);
});

test('communication preference sources contain only true subscribed category IDs', () => {
  const sourceField = { id: 'preferences', type: 'communication_preferences' };
  const preferences = { news: true, events: false, legacyString: 'true' };
  assert.equal(conditionalRuleMatches(
    { operator: 'equals', value: 'news' },
    preferences,
    sourceField,
  ), true);
  assert.equal(conditionalRuleMatches(
    { operator: 'includes', value: ['events', 'legacyString'] },
    preferences,
    sourceField,
  ), false);
  assert.equal(conditionalRuleMatches(
    { operator: 'is_not_empty', value: '' },
    preferences,
    sourceField,
  ), true);
  assert.equal(conditionalRuleMatches(
    { operator: 'is_empty', value: '' },
    { news: false },
    sourceField,
  ), true);
});

test('communication preference renderer applies checked and unchecked defaults only to visible categories', () => {
  assert.deepEqual(initializeCommunicationPreferenceDefaults({
    value: {},
    categories: [{ id: 'news' }, { id: 'events' }],
    defaultSelectedCategoryIds: ['news', 'hidden'],
  }), {
    news: true,
    events: false,
  });
});

test('legacy communication preference fields default every visible category to unchecked', () => {
  assert.deepEqual(initializeCommunicationPreferenceDefaults({
    value: undefined,
    categories: [{ id: 'news' }, { id: 'events' }],
  }), {
    news: false,
    events: false,
  });
});

test('communication preference initialization preserves user-entered answers', () => {
  assert.equal(initializeCommunicationPreferenceDefaults({
    value: { news: false, events: true },
    categories: [{ id: 'news' }, { id: 'events' }],
    defaultSelectedCategoryIds: ['news'],
  }), null);
});

test('communication preference defaults are applied after renderer filtering', () => {
  const source = readFileSync(new URL('../components/forms/FormRenderer.jsx', import.meta.url), 'utf8');
  const component = source.match(/function CommunicationPreferencesField[\s\S]*?function FormRenderer/)?.[0] || '';
  assert.match(component, /default_selected_category_ids/);
  assert.match(component, /initializedDefaults\.current/);
  assert.match(component, /initializeCommunicationPreferenceDefaults/);
  assert.match(component, /intersectConditionalOptions\(staticallyFiltered/);
  assert.doesNotMatch(component, /cat\.is_public === true\) return true/);
  assert.match(component, /cat\.role_ids\.includes\(effectiveRoleId\)/);
  assert.match(component, /\[allCategories, formMemberRoleId, memberInfo\?\.id, memberInfo\?\.role_id/);
  assert.doesNotMatch(component, /if \(!conditionalResolution\?\.configured \|\| isLoading/);
  assert.match(component, /if \(!communicationEligibilityReady \|\| initializedDefaults\.current/);
});

test('form view waits for member identity and prefill role before initializing communication defaults', () => {
  const source = readFileSync(new URL('../pages/FormView.jsx', import.meta.url), 'utf8');
  assert.match(source, /const communicationEligibilityReady = authResolved/);
  assert.match(source, /memberInfo\?\.id && memberRecordLoading/);
  assert.match(source, /prefillMemberId && form\?\.prefill_source === 'member' && prefillMemberLoading/);
  assert.equal((source.match(/communicationEligibilityReady=\{communicationEligibilityReady\}/g) || []).length, 2);
});

test('communication preference builder keeps inclusion and default selection distinct', () => {
  const source = readFileSync(new URL('../pages/FormBuilder.jsx', import.meta.url), 'utf8');
  assert.match(source, /checkbox-commpref-allowed-/);
  assert.match(source, /checkbox-commpref-default-/);
  assert.match(source, /Selected by default/);
  assert.match(source, /default_selected_category_ids: defaults/);
});

test('country sources match saved ISO codes and submitted names with server parity', () => {
  const country = { id: 'country', type: 'country' };
  const countries = { id: 'countries', type: 'countries' };
  assert.equal(conditionalRuleMatches(
    { operator: 'equals', value: 'GB' },
    'United Kingdom',
    country,
  ), true);
  assert.equal(conditionalRuleMatches(
    { operator: 'equals', value: 'United Kingdom' },
    'gb',
    country,
  ), true);
  assert.equal(conditionalRuleMatches(
    { operator: 'in', value: ['FR', 'United Kingdom'] },
    ['France', 'GB'],
    countries,
  ), true);
});

test('known custom country source definitions use the same country canonicalization', () => {
  assert.equal(conditionalRuleMatches(
    { operator: 'equals', value: 'NZ' },
    'New Zealand',
    { id: 'custom-country', type: 'custom_field', custom_field_type: 'country' },
  ), true);
});

test('uses first matching ordered rule, then fallback, and fails closed', () => {
  const field = { conditional_filters: { version: 1, rules: [
    rule({ id: 'one', allowed_values: ['a'] }),
    rule({ id: 'two', allowed_values: ['b'] }),
    rule({ id: 'fallback', source_field_id: '', is_fallback: true, allowed_values: ['c'] }),
  ] } };
  assert.equal(resolveConditionalFilters({ field, values: { source: 'x' } }).matchedRule.id, 'one');
  assert.equal(resolveConditionalFilters({ field, values: { source: 'no' } }).matchedRule.id, 'fallback');
  const closed = resolveConditionalFilters({
    field: { conditional_filters: { version: 1, rules: field.conditional_filters.rules.slice(0, 2) } },
    values: { source: 'no' },
  });
  assert.deepEqual(intersectConditionalOptions(['a', 'b'], closed), []);
});

test('resolves organisation filter values from the matched earlier country answer', () => {
  const field = { conditional_filters: { version: 1, rules: [
    rule({
      operator: 'is_not_empty',
      value: null,
      org_filter: {
        type: 'custom',
        field: 'country',
        values: [],
        mode: 'include',
        value_source: 'source',
      },
    }),
  ] } };
  const resolution = resolveConditionalFilters({
    field,
    fields: [{ id: 'source', type: 'country' }, field],
    values: { source: 'United Kingdom' },
  });
  assert.deepEqual(resolution.orgFilter.values, ['GB']);
  assert.equal(resolution.orgFilter.value_source, 'source');
  assert.equal(resolution.orgFilter.comparison, 'country');
  const empty = resolveConditionalFilters({
    field,
    fields: [{ id: 'source', type: 'country' }, field],
    values: { source: '' },
  });
  assert.equal(empty.matchedRule, null);
  assert.equal(empty.orgFilter, null);
});

test('country comparison marker matches names and codes without affecting ordinary sources', () => {
  const dynamic = {
    conditional_filters: { version: 1, rules: [rule({
      operator: 'is_not_empty',
      value: null,
      org_filter: {
        type: 'custom',
        field: 'country_dropdown',
        values: [],
        value_source: 'source',
        comparison: 'country',
      },
    })] },
  };
  const country = resolveConditionalFilters({
    field: dynamic,
    fields: [{ id: 'source', type: 'country' }, dynamic],
    values: { source: 'Sudan' },
  });
  assert.equal(country.orgFilter.comparison, 'country');
  const organizations = [
    { id: 'name', custom_fields: { country_dropdown: 'Sudan' } },
    { id: 'code', custom_fields: { country_dropdown: 'SD' } },
    { id: 'other', custom_fields: { country_dropdown: 'Spain' } },
  ];
  assert.deepEqual(
    applyOrganizationFilter(organizations, country.orgFilter).map((item) => item.id),
    ['name', 'code'],
  );

  const ordinary = resolveConditionalFilters({
    field: dynamic,
    fields: [{ id: 'source', type: 'dropdown', name: 'Country' }, dynamic],
    values: { source: 'Sudan' },
  });
  assert.equal(ordinary.orgFilter.comparison, undefined);
  assert.deepEqual(
    applyOrganizationFilter(organizations, ordinary.orgFilter).map((item) => item.id),
    ['name'],
  );
});

test('intersects base options and removes invalid scalar and array values', () => {
  const resolution = { configured: true, matchedRule: {}, allowedValues: ['b', 'c'] };
  const options = intersectConditionalOptions(['a', 'b'], resolution);
  assert.deepEqual(options, ['b']);
  assert.equal(removeInvalidConditionalValue('a', options), '');
  assert.deepEqual(removeInvalidConditionalValue(['a', 'b'], options), ['b']);
});

test('excludes selected target values while legacy rules remain include-only', () => {
  const excluded = resolveConditionalFilters({
    field: { conditional_filters: { version: 1, rules: [
      rule({ allowed_values: ['b'], allowed_values_mode: 'exclude' }),
    ] } },
    values: { source: 'x' },
  });
  assert.equal(excluded.targetMode, 'exclude');
  assert.deepEqual(intersectConditionalOptions(['a', 'b', 'c'], excluded), ['a', 'c']);

  const legacy = resolveConditionalFilters({
    field: { conditional_filters: { version: 1, rules: [
      rule({ allowed_values: ['b'] }),
    ] } },
    values: { source: 'x' },
  });
  assert.equal(legacy.targetMode, 'include');
  assert.deepEqual(intersectConditionalOptions(['a', 'b', 'c'], legacy), ['b']);
});

test('an empty target exclusion adds no restriction', () => {
  const resolution = resolveConditionalFilters({
    field: { conditional_filters: { version: 1, rules: [
      rule({ allowed_values: [], allowed_values_mode: 'exclude' }),
    ] } },
    values: { source: 'x' },
  });
  assert.deepEqual(intersectConditionalOptions(['new', 'existing'], resolution), ['new', 'existing']);
});

test('a matched rule with no allowed values adds no choice restriction', () => {
  const options = ['a', 'b'];
  assert.equal(intersectConditionalOptions(options, {
    configured: true,
    matchedRule: { id: 'org-filter-only' },
    allowedValues: [],
  }), options);
});

test('empty rules preserve legacy options exactly', () => {
  const options = [{ id: 'a' }];
  const resolution = resolveConditionalFilters({
    field: { conditional_filters: { version: 1, rules: [] } },
  });
  assert.equal(intersectConditionalOptions(options, resolution), options);
});

test('projects only referenced sources under canonical IDs with legacy-name lookup', () => {
  const field = {
    conditional_filters: {
      version: 1,
      rules: [
        rule({ source_field_id: 'source-id' }),
        rule({ id: 'second', source_field_id: 'other-id' }),
        rule({ id: 'fallback', source_field_id: '', is_fallback: true }),
      ],
    },
  };
  assert.deepEqual(projectConditionalSourceValues({
    field,
    fields: [
      { id: 'source-id', name: 'legacySource' },
      { id: 'other-id', name: 'other' },
    ],
    values: { legacySource: 'legacy value', 'other-id': ['a'], unrelated: 'secret' },
  }), {
    'source-id': 'legacy value',
    'other-id': ['a'],
  });
});

test('projects an Organisation Group parent even without conditional rules', () => {
  assert.deepEqual(projectConditionalSourceValues({
    field: {
      id: 'org',
      type: 'organisation_dropdown',
      organisation_group_parent_field_id: 'group',
    },
    fields: [{ id: 'group', name: 'legacyGroup', type: 'organisation_group_dropdown' }],
    values: { legacyGroup: 'group-1', unrelated: 'private' },
  }), { group: 'group-1' });
});

test('malformed and non-v1 conditional configs fail closed', () => {
  for (const conditional_filters of [
    'invalid',
    { version: 2, rules: [] },
    { version: 1, rules: [{}] },
    { version: 1, rules: [rule({ org_filter: {} })] },
  ]) {
    const resolution = resolveConditionalFilters({ field: { conditional_filters } });
    assert.equal(resolution.configured, true);
    assert.equal(resolution.valid, false);
    assert.deepEqual(intersectConditionalOptions(['a'], resolution), []);
  }
});

test('builder persists country target choices using submitted names', () => {
  const source = readFileSync(new URL('../pages/FormBuilder.jsx', import.meta.url), 'utf8');
  assert.match(source, /\.map\(country => \(\{ value: country\.name, label: country\.name \}\)\)/);
  assert.match(source, /includes\(customField\?\.field_type\)[\s\S]*?value: country\.name/);
});

test('organization option client sends repeatable container scope to the real handler', () => {
  const source = readFileSync(new URL('../api/publicClient.js', import.meta.url), 'utf8');
  const method = source.match(/async listFormOrganizationOptions[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(method, /this\._fetch\('\/api\/public\/organisations'/);
  assert.match(method, /method: 'POST'/);
  assert.match(method, /\n\s*fieldId,/);
  assert.match(method, /containerFieldId: containerFieldId \|\| null/);
  assert.doesNotMatch(method, /targetFieldId/);
});

test('organization filtering supports standard and custom trusted shapes', () => {
  const organizations = [
    { id: 'a', status: 'active', custom_fields: { sector: 'arts' } },
    { id: 'b', status: 'inactive', custom_fields: { sector: 'tech' } },
    { id: 'missing' },
    { id: 'blank', status: '   ', custom_fields: { sector: '' } },
  ];
  assert.deepEqual(
    applyOrganizationFilter(organizations, { type: 'standard', field: 'status', values: ['active'] }),
    [organizations[0]],
  );
  assert.deepEqual(
    applyOrganizationFilter(organizations, { type: 'custom', field: 'sector', values: ['tech'] }),
    [organizations[1]],
  );
  assert.deepEqual(
    applyOrganizationFilter(organizations, {
      type: 'custom', field: 'sector', values: ['tech'], mode: 'exclude',
    }),
    [organizations[0]],
  );
  assert.deepEqual(
    applyOrganizationFilter(organizations, {
      type: 'core', field: 'status', values: [], mode: 'exclude',
    }),
    organizations,
  );
  assert.deepEqual(
    applyOrganizationFilter(organizations, {
      type: 'core', field: 'status', values: [], mode: 'forged',
    }),
    [],
  );
});

test('populated organization filters exclude empty values in both modes', () => {
  const organizations = [
    { id: 'match', status: 'approved', custom_fields: { sector: 'arts' } },
    { id: 'other', status: 'pending', custom_fields: { sector: 'tech' } },
    { id: 'missing' },
    { id: 'blank', status: '  ', custom_fields: { sector: ' ' } },
    { id: 'empty-array', status: [], custom_fields: { sector: [] } },
  ];
  for (const type of ['core', 'custom']) {
    const field = type === 'core' ? 'status' : 'sector';
    assert.deepEqual(
      applyOrganizationFilter(organizations, { type, field, values: [type === 'core' ? 'approved' : 'arts'] })
        .map(item => item.id),
      ['match'],
    );
    assert.deepEqual(
      applyOrganizationFilter(organizations, { type, field, values: [type === 'core' ? 'approved' : 'arts'], mode: 'exclude' })
        .map(item => item.id),
      ['other'],
    );
  }
});

test('organization filter options use configured custom-field choices', () => {
  assert.deepEqual(configuredOrganizationFilterOptions('custom', 'sector', [
    {
      name: 'sector',
      entity_scope: 'member',
      options: ['Wrong scope'],
    },
    {
      name: 'sector',
      entity_scope: 'organization',
      options: ['Arts', { value: 'tech', label: 'Technology' }, 'Arts'],
    },
  ]), [
    { value: 'Arts', label: 'Arts' },
    { value: 'tech', label: 'Technology' },
  ]);
  assert.deepEqual(configuredOrganizationFilterOptions('core', 'status', []), []);
});

test('organization field-value endpoint is admin-only and flattens custom arrays', async () => {
  const endpoint = await import('../../../api/public/organisation-field-values.js');
  assert.deepEqual(endpoint.normalizePreferenceValues(
    JSON.stringify(['first', { value: 'second' }, ['third']]),
  ), ['first', 'second', 'third']);
  const source = readFileSync(
    new URL('../../../api/public/organisation-field-values.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /getTenantContext\(req\)/);
  assert.match(source, /hasAdminAccess\(tenantContext\)/);
  assert.doesNotMatch(source, /tenantParam/);
  assert.match(source, /\.order\('id', \{ ascending: true \}\)[\s\S]*?\.range\(/);
});

test('organization filter options preserve unavailable saved values', () => {
  assert.deepEqual(mergeOrganizationFilterOptions(
    ['Active', { value: 'pending', label: 'Pending approval' }, 'Active'],
    ['pending', 'Legacy'],
  ), [
    { value: 'Active', label: 'Active' },
    { value: 'pending', label: 'Pending approval' },
    { value: 'Legacy', label: 'Legacy (unavailable)', unavailable: true },
  ]);
});

test('organization result filter builder uses a multi-select instead of comma input', () => {
  const source = readFileSync(new URL('../pages/FormBuilder.jsx', import.meta.url), 'utf8');
  const editor = source.match(/function ConditionalOrgFilterValues[\s\S]*?function ConditionalFilterRuleEditor/)?.[0] || '';
  assert.match(editor, /PolicyMultiSelect/);
  assert.match(editor, /listOrganizationFieldValues/);
  assert.doesNotMatch(editor, /Allowed values, separated by commas/);
  assert.doesNotMatch(editor, /\.split\(','\)/);
  assert.match(editor, /Include only selected values/);
  assert.match(editor, /Exclude selected values/);
  assert.match(editor, /Match earlier field answer/);
});

test('repeatable organisation children expose source-answer result filtering', () => {
  const source = readFileSync(new URL('../pages/FormBuilder.jsx', import.meta.url), 'utf8');
  const editor = source.match(/function RepeatableRowsSettings[\s\S]*?function FieldCard/)?.[0] || '';
  assert.match(editor, /ConditionalOrgFilterEditor/);
  assert.match(editor, /Whenever source has a value/);
  assert.match(editor, /customFields\.find[\s\S]*?field_type/);
});