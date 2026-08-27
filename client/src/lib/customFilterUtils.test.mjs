import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ORGANIZATION_FILTER_PREFIX,
  organizationFilterKey,
  organizationFieldIdFromFilterKey,
  buildOrganizationFilterPayload,
  coerceCustomFilters,
} from './customFilterUtils.js';

test('organisation filter keys are collision-safe and reversible', () => {
  assert.equal(organizationFilterKey('same-id'), `${ORGANIZATION_FILTER_PREFIX}same-id`);
  assert.equal(organizationFieldIdFromFilterKey('org:same-id'), 'same-id');
  assert.equal(organizationFieldIdFromFilterKey('same-id'), null);
});

test('member and organisation saved values with the same field id remain independent', () => {
  const memberValues = coerceCustomFilters({ shared: 'Member option' });
  const organizationValues = coerceCustomFilters({ shared: 'Organisation option' });
  const filterOps = {
    shared: 'none_of',
    'org:shared': 'any_of',
  };
  assert.deepEqual(memberValues.shared, ['Member option']);
  assert.deepEqual(
    buildOrganizationFilterPayload(organizationValues, filterOps),
    { shared: ['Organisation option'] }
  );
});

test('organisation multi-value, negative and empty filters use the expected wire format', () => {
  assert.deepEqual(
    buildOrganizationFilterPayload(
      { options: ['A', 'B'], country: '__country__:France' },
      { 'org:options': 'none_of', 'org:missing': 'empty' }
    ),
    {
      options: { op: 'none_of', value: ['A', 'B'] },
      country: '__country__:France',
      missing: { op: 'empty' },
    }
  );
});

test('saved emptiness filters transmit before field definitions are loaded', () => {
  assert.deepEqual(
    buildOrganizationFilterPayload({}, { 'org:field-from-view': 'not_empty' }),
    { 'field-from-view': { op: 'not_empty' } }
  );
});

test('malformed unrelated operator keys do not enter the organisation payload', () => {
  assert.deepEqual(
    buildOrganizationFilterPayload({}, { status: 'empty', 'org:': 'empty' }),
    {}
  );
});