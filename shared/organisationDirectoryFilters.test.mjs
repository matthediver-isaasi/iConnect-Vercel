import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ORG_DIRECTORY_FILTER_SETTING,
  isOrganisationDirectoryFieldFilterable,
  parseOrganisationDirectoryFilterOverrides,
} from './organisationDirectoryFilters.js';

test('strictly parses filter overrides', () => {
  assert.equal(ORG_DIRECTORY_FILTER_SETTING, 'org_directory_filterable_back_fields');
  assert.deepEqual(parseOrganisationDirectoryFilterOverrides(undefined), {});
  assert.deepEqual(parseOrganisationDirectoryFilterOverrides('{"custom:a":true,"core":false}'), {
    'custom:a': true, core: false,
  });
  for (const malformed of ['', '[]', 'null', '{"a":1}', [], { a: 'true' }]) {
    assert.throws(() => parseOrganisationDirectoryFilterOverrides(malformed));
  }
  for (const polluted of [
    '{"__proto__":true}',
    '{"constructor":false}',
    '{"prototype":true}',
  ]) {
    assert.throws(() => parseOrganisationDirectoryFilterOverrides(polluted), /Unsafe/);
  }
  assert.equal({}.polluted, undefined);
});

test('explicit overrides win and only custom fields inherit is_filterable', () => {
  assert.equal(isOrganisationDirectoryFieldFilterable('custom:a', {}, { is_filterable: true }), true);
  assert.equal(isOrganisationDirectoryFieldFilterable('custom:a', {}, { is_filterable: false }), false);
  assert.equal(isOrganisationDirectoryFieldFilterable('custom:a', { 'custom:a': true }, {}), true);
  assert.equal(isOrganisationDirectoryFieldFilterable('custom:a', { 'custom:a': false }, { is_filterable: true }), false);
  assert.equal(isOrganisationDirectoryFieldFilterable('org_member_count', {}, { is_filterable: true }), false);
  assert.equal(isOrganisationDirectoryFieldFilterable('object-field:a', {}, { is_filterable: true }), false);
});