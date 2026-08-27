import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDdSubmissionFieldValues } from './email-placeholder-dd-submission.js';

const currentId = '33333333-3333-4333-8333-333333333333';
const missingId = '44444444-4444-4444-8444-444444444444';
const fields = [
  { id: 'relationship-id', name: 'Current relationship', type: 'relationship_dropdown' },
  { id: 'legacy-relationship', name: 'Legacy relationship', type: 'relationship_dropdown' },
];

test('DD placeholder preview renders current and missing ID-keyed relationship labels safely', () => {
  const values = buildDdSubmissionFieldValues(
    fields,
    { 'relationship-id': currentId, 'legacy-relationship': missingId },
    { [currentId]: 'Current DD record' },
  );
  assert.equal(values.byId['relationship-id'], 'Current DD record');
  assert.equal(values.byId['legacy-relationship'], 'Unavailable record');
  assert.equal(JSON.stringify(values).includes(missingId), false);
});

test('DD placeholder preview renders current and missing legacy name-keyed relationship labels safely', () => {
  const values = buildDdSubmissionFieldValues(
    fields,
    { 'Current relationship': currentId, 'Legacy relationship': missingId },
    { [currentId]: 'Legacy DD record' },
  );
  assert.equal(values.byLabel['Current relationship'], 'Legacy DD record');
  assert.equal(values.byLabel['Legacy relationship'], 'Unavailable record');
  assert.equal(JSON.stringify(values).includes(missingId), false);
});