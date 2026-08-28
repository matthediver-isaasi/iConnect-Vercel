import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSubmissionEmailFieldDisplayValue } from './formSubmissionEmails.js';

const currentId = '11111111-1111-4111-8111-111111111111';
const missingId = '22222222-2222-4222-8222-222222222222';
const fields = [
  { id: 'relationship-id', name: 'Current relationship', type: 'relationship_dropdown' },
  { id: 'legacy-relationship', name: 'Legacy relationship', type: 'relationship_dropdown' },
];

function display(fieldKey, persistedSubmissionData, labels) {
  return resolveSubmissionEmailFieldDisplayValue({
    fields,
    fieldKey,
    rawValue: missingId,
    persistedSubmissionData,
    relationshipLabelsByRecordId: labels,
  });
}

test('configured form-email placeholders render current and missing ID-keyed relationship labels safely', () => {
  assert.equal(
    display('relationship-id', { 'relationship-id': currentId }, { [currentId]: 'Current record' }),
    'Current record',
  );
  assert.equal(
    display('relationship-id', { 'relationship-id': missingId }, {}),
    'Unavailable record',
  );
});

test('configured form-email placeholders render current and missing legacy name-keyed relationship labels safely', () => {
  assert.equal(
    display('legacy-relationship', { 'Legacy relationship': currentId }, { [currentId]: 'Legacy record' }),
    'Legacy record',
  );
  const output = display('Legacy relationship', { 'Legacy relationship': missingId }, {});
  assert.equal(output, 'Unavailable record');
  assert.equal(output.includes(missingId), false);
});

test('configured form-email placeholders render snapshotted not-listed labels', () => {
  const notListedField = {
    id: 'org',
    name: 'Organisation',
    type: 'organisation_dropdown',
    not_listed_choice: { enabled: false, label: 'Renamed label' },
  };
  assert.equal(resolveSubmissionEmailFieldDisplayValue({
    fields: [notListedField],
    fieldKey: 'org',
    rawValue: '__form_not_listed__',
    persistedSubmissionData: {
      org: '__form_not_listed__',
      __not_listed_choice_labels: { org: 'Original label' },
      __not_listed_choice_text: { org: 'Independent organisation' },
    },
    relationshipLabelsByRecordId: {},
  }), 'Original label — Independent organisation');
});

test('configured form-email placeholders render repeatable rows and nested relationship labels', () => {
  const repeatable = {
    id: 'contacts',
    type: 'repeatable_row',
    repeatable_row: {
      child_fields: [
        { id: 'name', label: 'Name', type: 'text' },
        { id: 'employer', label: 'Employer', type: 'organisation_dropdown' },
        { id: 'organisation', label: 'Organisation', type: 'relationship_dropdown' },
      ],
    },
  };
  const output = resolveSubmissionEmailFieldDisplayValue({
    fields: [repeatable],
    fieldKey: 'contacts',
    rawValue: [],
    persistedSubmissionData: {
      contacts: [{ _row_id: 'private-row-id', name: 'Grace', employer: 'org-1', organisation: currentId }],
    },
    relationshipLabelsByRecordId: { [currentId]: 'Computing Society' },
    organisationNamesById: { 'org-1': 'Ada Systems' },
  });
  assert.equal(output, 'Row 1\nName: Grace\nEmployer: Ada Systems\nOrganisation: Computing Society');
  assert.equal(output.includes(currentId), false);
  assert.equal(output.includes('private-row-id'), false);
  assert.equal(output.includes('org-1'), false);
});

test('configured form-email placeholders retain repeatable not-listed labels', () => {
  const repeatable = {
    id: 'contacts',
    type: 'repeatable_row',
    children: [{
      id: 'employer',
      label: 'Employer',
      type: 'organisation_dropdown',
      not_listed_choice: { enabled: false, label: 'Renamed label' },
    }],
  };
  assert.equal(resolveSubmissionEmailFieldDisplayValue({
    fields: [repeatable],
    fieldKey: 'contacts',
    rawValue: [],
    persistedSubmissionData: {
      contacts: [{
        employer: '__form_not_listed__',
        __not_listed_choice_text: { employer: 'Independent organisation' },
      }],
      __not_listed_choice_labels: { contacts: { employer: 'Original employer label' } },
    },
    relationshipLabelsByRecordId: {},
    organisationNamesById: {},
  }), 'Row 1\nEmployer: Original employer label — Independent organisation');
});