import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectRepeatableRelationshipRecordIds,
  collectRepeatableOrganisationIds,
  formatRepeatableRows,
  formatRepeatableRowsText,
} from './repeatableFormRowsFormat.js';

const field = {
  id: 'employment',
  type: 'repeatable_row',
  repeatable_row: {
    child_fields: [
      { id: 'employer', label: 'Employer', type: 'text' },
      { id: 'organisation', label: 'Organisation', type: 'organisation_dropdown' },
      { id: 'department', label: 'Department', type: 'relationship_dropdown' },
      { id: 'current', label: 'Current role', type: 'boolean' },
    ],
  },
};
const value = [
  { _row_id: 'stable-a', employer: 'Analytical Engines', organisation: 'org-1', department: 'dept-1', current: true },
  { _row_id: 'stable-b', employer: 'Royal Society', organisation: 'org-2', department: 'dept-2', current: false },
];

test('repeatable answers become an ordered labelled row/column model without row metadata', () => {
  const model = formatRepeatableRows(field, value);
  assert.deepEqual(model.columns.map((column) => column.label), ['Employer', 'Organisation', 'Department', 'Current role']);
  assert.deepEqual(model.rows.map((row) => row.rowId), ['stable-a', 'stable-b']);
  assert.deepEqual(model.rows[0].cells, ['Analytical Engines', 'org-1', 'dept-1', 'Yes']);
  assert.equal(JSON.stringify(model).includes('_row_id'), false);
});

test('repeatable text output is readable and permits context-specific relationship labels', () => {
  const text = formatRepeatableRowsText(field, value, {
    formatCell: (cell, child) => child.type === 'relationship_dropdown'
      ? { 'dept-1': 'Research', 'dept-2': 'Membership' }[cell]
      : cell,
    organisationNamesById: { 'org-1': 'Analytical Engines Ltd', 'org-2': 'Royal Society' },
  });
  assert.match(text, /Row 1\nEmployer: Analytical Engines\nOrganisation: Analytical Engines Ltd\nDepartment: Research/);
  assert.match(text, /Row 2[\s\S]*Department: Membership/);
  assert.equal(text.includes('_row_id'), false);
});

test('collects only relationship IDs from configured repeatable children', () => {
  assert.deepEqual(
    collectRepeatableRelationshipRecordIds([field], { employment: value }),
    ['dept-1', 'dept-2'],
  );
});

test('collects nested organisation IDs from builder-shaped rows', () => {
  assert.deepEqual(collectRepeatableOrganisationIds([field], { employment: value }), ['org-1', 'org-2']);
});

test('does not treat repeatable not-listed choices as entity IDs', () => {
  const notListed = [{ organisation: '__form_not_listed__', department: '__form_not_listed__' }];
  assert.deepEqual(collectRepeatableOrganisationIds([field], { employment: notListed }), []);
  assert.deepEqual(collectRepeatableRelationshipRecordIds([field], { employment: notListed }), []);
});

test('accepts config and legacy row-id aliases without exposing either identity key', () => {
  const aliasField = {
    id: 'aliases',
    type: 'repeatable_rows',
    config: { child_fields: [{ id: 'answer', label: 'Answer', type: 'text' }] },
  };
  const model = formatRepeatableRows(aliasField, [{ _row_id: 'canonical', row_id: 'legacy', answer: 'Visible' }]);
  assert.equal(model.rows[0].rowId, 'canonical');
  assert.equal(formatRepeatableRowsText(aliasField, [{ row_id: 'legacy', answer: 'Visible' }]), 'Row 1\nAnswer: Visible');
  assert.equal(JSON.stringify(model).includes('legacy'), false);
});

test('repeatable formatting uses the nested snapshotted not-listed label', () => {
  const historicalField = {
    id: 'rows',
    type: 'repeatable_row',
    children: [{
      id: 'organisation',
      label: 'Organisation',
      type: 'organisation_dropdown',
      not_listed_choice: { enabled: false, label: 'Renamed label' },
    }],
  };
  const text = formatRepeatableRowsText(
    historicalField,
    [{ organisation: '__form_not_listed__' }],
    {
      submissionData: {
        __not_listed_choice_labels: {
          rows: { organisation: 'Original organisation label' },
        },
      },
      organisationNamesById: {},
    },
  );
  assert.equal(text, 'Row 1\nOrganisation: Original organisation label');
});