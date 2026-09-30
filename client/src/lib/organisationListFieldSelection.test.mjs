import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getDisplayedOrganisationCardFields,
  getOrganisationFieldsParam,
  getRequestedOrganisationFieldIds,
} from './organisationListFieldSelection.mjs';

const columnFields = [
  { id: 'field-one' },
  { id: 'field-two' },
  { id: 'field-three' },
];

test('list mode requests every visible custom column and no hidden custom columns', () => {
  const columns = [
    { id: 'name', visible: true },
    { id: 'cf_one', visible: true, isCustomField: true, fieldId: 'field-one' },
    { id: 'cf_two', visible: false, isCustomField: true, fieldId: 'field-two' },
    { id: 'cf_three', visible: true, isCustomField: true, fieldId: 'field-three' },
  ];

  assert.deepEqual(
    getRequestedOrganisationFieldIds({ viewMode: 'list', columns, columnFields }),
    ['field-one', 'field-three'],
  );
});

test('card mode requests the same first two custom fields that cards render', () => {
  const displayedIds = getDisplayedOrganisationCardFields(columnFields).map((field) => field.id);
  const requestedIds = getRequestedOrganisationFieldIds({
    viewMode: 'card',
    columns: [],
    columnFields,
  });

  assert.deepEqual(requestedIds, displayedIds);
  assert.deepEqual(
    requestedIds,
    ['field-one', 'field-two'],
  );
});

test('uses the explicit none sentinel when the active mode renders no custom fields', () => {
  assert.equal(
    getOrganisationFieldsParam({ viewMode: 'list', columns: [], columnFields }),
    'none',
  );
  assert.equal(
    getOrganisationFieldsParam({ viewMode: 'card', columns: [], columnFields: [] }),
    'none',
  );
});