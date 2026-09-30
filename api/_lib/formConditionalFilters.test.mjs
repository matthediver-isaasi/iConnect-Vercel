import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conditionalSelectionAllowed,
  normalizeConditionalValue,
  resolveConditionalFilter,
  validateConditionalFilters,
} from './formConditionalFilters.js';
import { FORM_NOT_LISTED_VALUE } from '../../shared/formNotListedChoice.js';

const rule = (overrides = {}) => ({
  id: 'rule-1',
  source_field_id: 'country',
  operator: 'equals',
  value: 'GB',
  is_fallback: false,
  allowed_values: ['a', 'b'],
  org_filter: null,
  ...overrides,
});

test('normalizes scalar, boolean, number, object values and arrays', () => {
  assert.equal(normalizeConditionalValue({ value: false }), false);
  assert.equal(normalizeConditionalValue({ value: 12 }), 12);
  assert.deepEqual(normalizeConditionalValue([{ value: 'a' }, 2, true]), ['a', 2, true]);
});

test('ordered first match wins and allowed values intersect saved base choices', () => {
  const field = {
    options: [{ value: 'b' }, { value: 'c' }],
    conditional_filters: {
      version: 1,
      rules: [
        rule({ id: 'first', allowed_values: ['a', 'b'] }),
        rule({ id: 'second', allowed_values: ['c'] }),
      ],
    },
  };
  const resolution = resolveConditionalFilter(field, { country: { value: 'GB' } }, []);
  assert.equal(resolution.rule.id, 'first');
  assert.deepEqual(resolution.allowedValues, ['b']);
  assert.equal(conditionalSelectionAllowed('b', resolution), true);
  assert.equal(conditionalSelectionAllowed('a', resolution), false);
  assert.equal(conditionalSelectionAllowed('stale-or-forged', resolution), false);
});

test('first fallback applies only when no non-fallback rule matches', () => {
  const field = { conditional_filters: {
    version: 1,
    rules: [
      rule(),
      rule({ id: 'fallback', is_fallback: true, allowed_values: ['fallback'] }),
    ],
  } };
  const resolution = resolveConditionalFilter(field, { country: 'US' }, []);
  assert.equal(resolution.rule.id, 'fallback');
  assert.equal(conditionalSelectionAllowed('fallback', resolution), true);
});

test('configured filters without a match or fallback fail closed', () => {
  const resolution = resolveConditionalFilter(
    { conditional_filters: { version: 1, rules: [rule()] } },
    { country: 'US' },
  );
  assert.equal(resolution.configured, true);
  assert.deepEqual(resolution.allowedValues, []);
  assert.equal(conditionalSelectionAllowed('forged', resolution), false);
});

test('repeatable dependencies can match the stable not-listed source value', () => {
  const target = {
    type: 'category_dropdown',
    options: ['visible'],
    conditional_filters: {
      version: 1,
      rules: [rule({
        source_field_id: 'org',
        value: FORM_NOT_LISTED_VALUE,
        allowed_values: ['visible'],
      })],
    },
  };
  const resolution = resolveConditionalFilter(
    target,
    { org: FORM_NOT_LISTED_VALUE },
    [{ id: 'org', type: 'organisation_dropdown' }, target],
  );
  assert.equal(resolution.rule.id, 'rule-1');
  assert.equal(conditionalSelectionAllowed('visible', resolution), true);
});

test('absent and empty rules preserve legacy selection behavior', () => {
  for (const field of [{}, { conditional_filters: { version: 1, rules: [] } }]) {
    const resolution = resolveConditionalFilter(field, {}, []);
    assert.equal(resolution.configured, false);
    assert.equal(conditionalSelectionAllowed('legacy-value', resolution), true);
  }
});

test('relationship IDs can be conditionally restricted', () => {
  const resolution = resolveConditionalFilter({
    type: 'relationship_dropdown',
    options: [],
    conditional_filters: { version: 1, rules: [rule({ allowed_values: ['record-1'] })] },
  }, { country: 'GB' });
  assert.equal(conditionalSelectionAllowed('record-1', resolution), true);
  assert.equal(conditionalSelectionAllowed('record-2', resolution), false);
});

test('relationship and organisation IDs can be excluded from a dynamic eligible universe', () => {
  for (const type of ['relationship_dropdown', 'organisation_dropdown']) {
    const resolution = resolveConditionalFilter({
      type,
      options: [],
      conditional_filters: {
        version: 1,
        rules: [rule({
          allowed_values: ['blocked-id'],
          allowed_values_mode: 'exclude',
        })],
      },
    }, { country: 'GB' });
    assert.equal(resolution.allowedValues, null);
    assert.deepEqual(resolution.excludedValues, ['blocked-id']);
    assert.equal(conditionalSelectionAllowed('newly-added-id', resolution), true);
    assert.equal(conditionalSelectionAllowed('blocked-id', resolution), false);
  }
});

test('target exclusion is applied after static choices and empty exclusion is unrestricted', () => {
  const field = {
    type: 'dropdown',
    options: ['a', 'b', 'c'],
    conditional_filters: {
      version: 1,
      rules: [rule({ allowed_values: ['b'], allowed_values_mode: 'exclude' })],
    },
  };
  const resolution = resolveConditionalFilter(field, { country: 'GB' });
  assert.deepEqual(resolution.allowedValues, ['a', 'c']);
  assert.equal(conditionalSelectionAllowed('a', resolution), true);
  assert.equal(conditionalSelectionAllowed('b', resolution), false);
  assert.equal(conditionalSelectionAllowed('forged', resolution), false);

  field.conditional_filters.rules[0].allowed_values = [];
  const empty = resolveConditionalFilter(field, { country: 'GB' });
  assert.deepEqual(empty.allowedValues, ['a', 'b', 'c']);
});

test('organisation-only filters permit IDs for subsequent trusted eligibility check', () => {
  const orgFilter = { type: 'core', field: 'status', values: ['approved'] };
  const resolution = resolveConditionalFilter({
    type: 'organisation_dropdown',
    options: [],
    conditional_filters: {
      version: 1,
      rules: [rule({ allowed_values: [], org_filter: orgFilter })],
    },
  }, { country: 'GB' });
  assert.equal(conditionalSelectionAllowed('org-id', resolution), true);
  assert.deepEqual(resolution.orgFilter, orgFilter);
});

test('organisation filters can derive values from the persisted earlier source field', () => {
  const dynamicRule = rule({
    operator: 'is_not_empty',
    value: null,
    allowed_values: [],
    org_filter: {
      type: 'custom',
      field: 'country',
      values: [],
      mode: 'include',
      value_source: 'source',
    },
  });
  const target = {
    type: 'organisation_dropdown',
    options: [],
    conditional_filters: { version: 1, rules: [dynamicRule] },
  };
  const fields = [{ id: 'country', type: 'country' }, target];
  const resolution = resolveConditionalFilter(target, { country: 'United Kingdom' }, fields);
  assert.deepEqual(resolution.orgFilter.values, ['GB']);
  assert.equal(resolution.orgFilter.value_source, 'source');
  assert.equal(resolution.orgFilter.comparison, 'country');

  const empty = resolveConditionalFilter(target, { country: '' }, fields);
  assert.equal(empty.rule, null);
});

test('source-derived comparison meaning comes only from the persisted source field type', () => {
  const dynamicRule = rule({
    source_field_id: 'source',
    operator: 'is_not_empty',
    value: null,
    allowed_values: [],
    org_filter: {
      type: 'custom',
      field: 'country_named_dropdown',
      values: [],
      value_source: 'source',
      comparison: 'country',
    },
  });
  const target = {
    type: 'organisation_dropdown',
    conditional_filters: { version: 1, rules: [dynamicRule] },
  };
  const country = resolveConditionalFilter(
    target,
    { source: 'Sudan' },
    [{ id: 'source', type: 'country' }, target],
  );
  assert.deepEqual(country.orgFilter.values, ['SD']);
  assert.equal(country.orgFilter.comparison, 'country');

  const ordinary = resolveConditionalFilter(
    target,
    { source: 'Sudan' },
    [{ id: 'source', type: 'dropdown', name: 'Country' }, target],
  );
  assert.deepEqual(ordinary.orgFilter.values, ['Sudan']);
  assert.equal(ordinary.orgFilter.comparison, undefined);
});

test('empty conditional organisation result filters are valid and unrestricted in both modes', () => {
  for (const mode of ['include', 'exclude']) {
    const orgFilter = { type: 'core', field: 'country', values: [], mode };
    const field = {
      type: 'organisation_dropdown',
      options: [],
      conditional_filters: {
        version: 1,
        rules: [rule({ allowed_values: [], org_filter: orgFilter })],
      },
    };
    assert.equal(validateConditionalFilters(field.conditional_filters).valid, true);
    const resolution = resolveConditionalFilter(field, { country: 'GB' });
    assert.equal(conditionalSelectionAllowed('new-org', resolution), true);
    assert.deepEqual(resolution.orgFilter, orgFilter);
  }
});

test('empty saved option placeholders do not deny server-loaded dynamic IDs', () => {
  for (const type of ['organisation_dropdown', 'relationship_dropdown']) {
    const resolution = resolveConditionalFilter({
      type,
      options: [],
      conditional_filters: {
        version: 1,
        rules: [rule({ allowed_values: [] })],
      },
    }, { country: 'GB' });
    assert.equal(resolution.allowedValues, null);
    assert.equal(conditionalSelectionAllowed('server-loaded-id', resolution), true);
  }
});

test('empty saved options remain authoritative for ordinary static fields', () => {
  const resolution = resolveConditionalFilter({
    type: 'dropdown',
    options: [],
    conditional_filters: {
      version: 1,
      rules: [rule({ allowed_values: [] })],
    },
  }, { country: 'GB' });
  assert.deepEqual(resolution.allowedValues, []);
  assert.equal(conditionalSelectionAllowed('forged', resolution), false);
});

test('validator rejects malformed contracts and unsupported operators', () => {
  assert.equal(validateConditionalFilters({
    version: 1,
    rules: [rule({ operator: 'contains', allowed_values: null })],
  }).valid, false);
  assert.equal(validateConditionalFilters({
    version: 1,
    rules: [rule({ allowed_values_mode: 'forged' })],
  }).valid, false);
  assert.equal(validateConditionalFilters({
    version: 1,
    rules: [rule({
      org_filter: {
        type: 'core', field: 'country', values: ['Spain'], mode: 'forged',
      },
    })],
  }).valid, false);
  assert.equal(validateConditionalFilters({
    version: 1,
    rules: [rule({
      is_fallback: true,
      org_filter: {
        type: 'core', field: 'country', values: [], value_source: 'source',
      },
    })],
  }).valid, false);
});

test('communication preference sources compare subscribed category IDs only', () => {
  const target = {
    conditional_filters: { version: 1, rules: [
      rule({ source_field_id: 'communications', value: 'news', allowed_values: ['visible'] }),
    ] },
  };
  const fields = [{ id: 'communications', type: 'communication_preferences' }, target];
  assert.equal(resolveConditionalFilter(
    target,
    { communications: { news: true, events: false } },
    fields,
  ).rule.id, 'rule-1');
  assert.equal(resolveConditionalFilter(
    target,
    { communications: { news: false, events: true } },
    fields,
  ).rule, null);
});

test('communication preference targets validate submitted category keys', () => {
  const field = {
    type: 'communication_preferences',
    allowed_category_ids: ['news', 'events'],
    conditional_filters: {
      version: 1,
      rules: [rule({ allowed_values: ['news', 'events'] })],
    },
  };
  const resolution = resolveConditionalFilter(field, { country: 'GB' });
  assert.equal(conditionalSelectionAllowed({ news: true, events: false }, resolution), true);
  assert.equal(conditionalSelectionAllowed({ news: true, forged: false }, resolution), false);
  const noneAllowed = resolveConditionalFilter({
    type: 'communication_preferences',
    allowed_category_ids: ['news', 'events'],
    conditional_filters: {
      version: 1,
      rules: [rule({ allowed_values: [] })],
    },
  }, { country: 'GB' });
  assert.deepEqual(noneAllowed.allowedValues, ['news', 'events']);
  assert.equal(conditionalSelectionAllowed({ news: false }, noneAllowed), true);
  assert.equal(conditionalSelectionAllowed({ forged: false }, noneAllowed), false);
});

test('communication preference validation uses real allowed_category_ids shape against forged payloads', () => {
  const field = {
    id: 'communications',
    type: 'communication_preferences',
    allowed_category_ids: ['category-1', 'category-2'],
    conditional_filters: {
      version: 1,
      rules: [rule({ allowed_values: [] })],
    },
  };
  const resolution = resolveConditionalFilter(field, { country: 'GB' });
  assert.deepEqual(resolution.allowedValues, ['category-1', 'category-2']);
  assert.equal(conditionalSelectionAllowed({
    'category-1': true,
    'category-2': false,
  }, resolution), true);
  assert.equal(conditionalSelectionAllowed({
    'category-1': true,
    'forged-category': true,
  }, resolution), false);
});

test('empty allowed_category_ids preserves existing unrestricted communication behavior', () => {
  const field = {
    type: 'communication_preferences',
    allowed_category_ids: [],
    conditional_filters: {
      version: 1,
      rules: [rule({ allowed_values: [] })],
    },
  };
  const resolution = resolveConditionalFilter(field, { country: 'GB' });
  assert.equal(resolution.allowedValues, null);
  assert.equal(conditionalSelectionAllowed({ 'legacy-category': true }, resolution), true);
});

test('empty allowed values retain static choices and reject forged ordinary values', () => {
  const field = {
    type: 'dropdown',
    choices: ['saved-a', { value: 'saved-b' }],
    conditional_filters: {
      version: 1,
      rules: [rule({ allowed_values: [] })],
    },
  };
  const resolution = resolveConditionalFilter(field, { country: 'GB' });
  assert.deepEqual(resolution.allowedValues, ['saved-a', 'saved-b']);
  assert.equal(conditionalSelectionAllowed('saved-b', resolution), true);
  assert.equal(conditionalSelectionAllowed('forged', resolution), false);
});

test('country fields compare legacy codes with canonical submitted names only for country fields', () => {
  const target = { conditional_filters: { version: 1, rules: [rule({ value: 'GB' })] } };
  const resolution = resolveConditionalFilter(
    target,
    { country: 'United Kingdom' },
    [{ id: 'country', type: 'country' }, target],
  );
  assert.equal(resolution.rule.id, 'rule-1');
  const ordinary = resolveConditionalFilter(
    target,
    { country: 'United Kingdom' },
    [{ id: 'country', type: 'text' }, target],
  );
  assert.equal(ordinary.rule, null);
});

test('custom country source metadata matches client NZ and New Zealand parity', () => {
  const target = {
    conditional_filters: {
      version: 1,
      rules: [rule({ source_field_id: 'custom-country', value: 'NZ' })],
    },
  };
  const metadataShapes = [
    { custom_field_type: 'country' },
    { field_type: 'countries' },
    { custom_field: { field_type: 'country' } },
    { custom_field_definition: { field_type: 'countries' } },
  ];
  for (const metadata of metadataShapes) {
    const resolution = resolveConditionalFilter(
      target,
      { 'custom-country': 'New Zealand' },
      [{ id: 'custom-country', type: 'custom_field', ...metadata }, target],
    );
    assert.equal(resolution.rule?.id, 'rule-1', JSON.stringify(metadata));
  }
});

test('non-country custom fields do not canonicalize arbitrary NZ-like text', () => {
  const target = {
    conditional_filters: {
      version: 1,
      rules: [rule({ source_field_id: 'custom-text', value: 'NZ' })],
    },
  };
  const resolution = resolveConditionalFilter(
    target,
    { 'custom-text': 'New Zealand' },
    [{ id: 'custom-text', type: 'custom_field', field_type: 'text' }, target],
  );
  assert.equal(resolution.rule, null);
});

test('malformed and non-v1 configurations fail closed, including empty rules', () => {
  for (const conditional_filters of [
    { version: 2, rules: [] },
    { version: 1 },
    'invalid',
  ]) {
    const resolution = resolveConditionalFilter({ conditional_filters }, {});
    assert.equal(resolution.configured, true);
    assert.equal(resolution.valid, false);
    assert.equal(conditionalSelectionAllowed('forged', resolution), false);
  }
});