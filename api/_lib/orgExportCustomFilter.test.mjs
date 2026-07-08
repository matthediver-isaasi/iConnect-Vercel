// Regression tests for the organisation CSV export custom-field filter
// matching, and for the shared multi-select option-filter helpers used by the
// paginated /members and /organisations endpoints.
//
// Guards against the multi-select rollout regression where array filter
// values hit string-only code paths (e.g. `filterValue.trim()` throwing).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isActiveExportFilterValue,
  matchesCustomFieldFilter,
  matchesSingleOptionValue,
} from '../admin/organisations/export-csv.js';
import {
  buildOptionValueOrConditions,
  parseCustomFilterRawValue,
} from './prefValueOptionFilter.js';

test('isActiveExportFilterValue: arrays never throw and activate on real values', () => {
  assert.equal(isActiveExportFilterValue(['A']), true);
  assert.equal(isActiveExportFilterValue(['A', 'B']), true);
  assert.equal(isActiveExportFilterValue([]), false);
  assert.equal(isActiveExportFilterValue(['', 'all']), false);
});

test('isActiveExportFilterValue: legacy string semantics unchanged', () => {
  assert.equal(isActiveExportFilterValue('Red'), true);
  assert.equal(isActiveExportFilterValue('__text__:foo'), true);
  assert.equal(isActiveExportFilterValue(''), false);
  assert.equal(isActiveExportFilterValue('all'), false);
  assert.equal(isActiveExportFilterValue('   '), false);
  assert.equal(isActiveExportFilterValue(null), false);
  assert.equal(isActiveExportFilterValue(undefined), false);
});

test('matchesCustomFieldFilter: array filter ORs across values', () => {
  assert.equal(matchesCustomFieldFilter('Red', ['Red', 'Blue']), true);
  assert.equal(matchesCustomFieldFilter('Green', ['Red', 'Blue']), false);
  // Org value stored as an array (checkbox field)
  assert.equal(matchesCustomFieldFilter(['Green', 'Blue'], ['Red', 'Blue']), true);
  assert.equal(matchesCustomFieldFilter(['Green'], ['Red', 'Blue']), false);
  // Inactive / empty arrays pass everything through
  assert.equal(matchesCustomFieldFilter('anything', []), true);
  assert.equal(matchesCustomFieldFilter(null, ['', 'all']), true);
  // Missing org value fails an active filter
  assert.equal(matchesCustomFieldFilter(null, ['Red']), false);
  assert.equal(matchesCustomFieldFilter(undefined, ['Red']), false);
});

test('matchesCustomFieldFilter: legacy single string and text filters unchanged', () => {
  assert.equal(matchesCustomFieldFilter('Red', 'Red'), true);
  assert.equal(matchesCustomFieldFilter('Blue', 'Red'), false);
  assert.equal(matchesCustomFieldFilter(['Red', 'Blue'], 'Red'), true);
  assert.equal(matchesCustomFieldFilter('Something Redish', '__text__:redish'), true);
  assert.equal(matchesCustomFieldFilter(['Alpha', 'Beta'], '__text__:beta'), true);
  assert.equal(matchesCustomFieldFilter('x', ''), true);
  assert.equal(matchesCustomFieldFilter('x', 'all'), true);
});

test('matchesSingleOptionValue: scalar and array org values', () => {
  assert.equal(matchesSingleOptionValue('A', 'A'), true);
  assert.equal(matchesSingleOptionValue('A', 'B'), false);
  assert.equal(matchesSingleOptionValue(['A', 'B'], 'B'), true);
  assert.equal(matchesSingleOptionValue(['A', 'B'], 'C'), false);
});

test('parseCustomFilterRawValue: arrays cleaned, legacy strings kept, empties null', () => {
  assert.deepEqual(parseCustomFilterRawValue(['A', '', 'all', 'B']), ['A', 'B']);
  assert.equal(parseCustomFilterRawValue('legacy'), 'legacy');
  assert.equal(parseCustomFilterRawValue([]), null);
  assert.equal(parseCustomFilterRawValue(['', 'all']), null);
  assert.equal(parseCustomFilterRawValue(''), null);
  assert.equal(parseCustomFilterRawValue('all'), null);
  assert.equal(parseCustomFilterRawValue(null), null);
  assert.equal(parseCustomFilterRawValue(undefined), null);
  // Non-string scalars are stringified (harmless legacy passthrough)
  assert.equal(parseCustomFilterRawValue(42), '42');
});

test('buildOptionValueOrConditions: quotes values and escapes ilike wildcards', () => {
  assert.equal(
    buildOptionValueOrConditions(['AI']),
    'value.eq."AI",value.ilike."*\\"AI\\"*"'
  );
  // Comma inside an option value must stay inside PostgREST quotes
  const commaConds = buildOptionValueOrConditions(['A, B']);
  assert.ok(commaConds.includes('value.eq."A, B"'));
  assert.ok(commaConds.includes('value.ilike."*\\"A, B\\"*"'));
  // % and _ are LIKE wildcards and must be backslash-escaped in the pattern
  // (the escaping backslash itself is doubled for PostgREST's quoted grammar)
  const pctConds = buildOptionValueOrConditions(['50%_x']);
  assert.ok(pctConds.includes('value.ilike."*\\"50\\\\%\\\\_x\\"*"'), pctConds);
  // Embedded double quotes are backslash-escaped for PostgREST, and the
  // JSON-encoded form is used for the array-storage pattern
  const quoteConds = buildOptionValueOrConditions(['C"D']);
  assert.ok(quoteConds.includes('value.eq."C\\"D"'), quoteConds);
  assert.ok(quoteConds.includes('value.ilike."*\\"C\\\\\\"D\\"*"'), quoteConds);
  // Multiple values join with commas (OR)
  const multi = buildOptionValueOrConditions(['A', 'B']);
  assert.equal(multi.split(',').length, 4);
});
