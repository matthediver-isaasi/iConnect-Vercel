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