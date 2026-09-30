import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOrganisationCustomValueMap,
  deriveOrganisationSaveChanges,
  executeOrganisationSavePlan,
  normalizeOrganisationCustomValue,
  organisationCustomValuesEqual,
} from './myOrganisationSave.js';

const fields = [
  { id: 'scalar', field_type: 'text' },
  { id: 'choices', field_type: 'picklist' },
  { id: 'items', field_type: 'list' },
  { id: 'countries', field_type: 'countries' },
];
const editable = () => true;

test('description-only save invokes only the core organisation mutation', async () => {
  const changes = deriveOrganisationSaveChanges({
    formData: { description: 'New description' },
    persistedFormData: { description: 'Old description' },
    customFieldValues: { scalar: 'Loaded value', choices: ['One', 'Two'] },
    persistedCustomFieldValues: { scalar: 'Loaded value', choices: ['One', 'Two'] },
    customFields: fields,
    canEditField: editable,
  });

  const calls = [];
  await executeOrganisationSavePlan({
    changes,
    updateCore: async (value) => calls.push(['core', value]),
    updateCustom: async (value) => calls.push(['custom', value]),
    commitSnapshots: () => calls.push(['commit']),
  });
  assert.deepEqual(calls, [
    ['core', { description: 'New description' }],
    ['commit'],
  ]);
});

test('a genuine scalar custom-field edit invokes the correct preference mutation', async () => {
  const changes = deriveOrganisationSaveChanges({
    formData: { description: 'Same' },
    persistedFormData: { description: 'Same' },
    customFieldValues: { scalar: 'Changed' },
    persistedCustomFieldValues: { scalar: 'Original' },
    customFields: fields,
    canEditField: editable,
  });

  const calls = [];
  await executeOrganisationSavePlan({
    changes,
    updateCore: async (value) => calls.push(['core', value]),
    updateCustom: async (value) => calls.push(['custom', value]),
    commitSnapshots: () => calls.push(['commit']),
  });
  assert.deepEqual(calls, [
    ['custom', { fieldId: 'scalar', value: 'Changed' }],
    ['commit'],
  ]);
});

test('loaded list and picklist representations compare consistently', () => {
  const loaded = buildOrganisationCustomValueMap(fields, [
    { field_id: 'choices', value: '["One","Two"]' },
    { field_id: 'items', value: 'Solo' },
  ]);

  assert.deepEqual(loaded, { choices: ['One', 'Two'], items: ['Solo'] });
  assert.equal(organisationCustomValuesEqual(fields[1], '["One","Two"]', ['One', 'Two']), true);
  assert.equal(organisationCustomValuesEqual(fields[2], 'Solo', ['Solo']), true);
});

test('normalizes scalar, JSON-array, empty, and malformed option values safely', () => {
  const picklist = fields[1];
  assert.deepEqual(normalizeOrganisationCustomValue(picklist, 'Scotland'), ['Scotland']);
  assert.deepEqual(normalizeOrganisationCustomValue(picklist, '["Scotland"," Wales "]'), ['Scotland', 'Wales']);
  assert.deepEqual(normalizeOrganisationCustomValue(picklist, ''), []);
  assert.deepEqual(normalizeOrganisationCustomValue(picklist, '["Scotland"'), []);
  assert.deepEqual(normalizeOrganisationCustomValue(picklist, '{"region":"Scotland"}'), []);
});

test('loading and cancelling preserve a legacy scalar selection without creating a save change', () => {
  const persistedValues = [{ field_id: 'choices', value: 'Scotland' }];
  const loaded = buildOrganisationCustomValueMap(fields, persistedValues);
  const cancelled = buildOrganisationCustomValueMap(fields, persistedValues);

  assert.deepEqual(loaded.choices, ['Scotland']);
  assert.deepEqual(cancelled.choices, ['Scotland']);
  assert.deepEqual(deriveOrganisationSaveChanges({
    formData: {},
    persistedFormData: {},
    customFieldValues: cancelled,
    persistedCustomFieldValues: { choices: 'Scotland' },
    customFields: fields,
    canEditField: editable,
  }).custom, []);
});

test('genuine option edits save in canonical array form', () => {
  const changes = deriveOrganisationSaveChanges({
    formData: {},
    persistedFormData: {},
    customFieldValues: { choices: ['Scotland', 'Wales'] },
    persistedCustomFieldValues: { choices: 'Scotland' },
    customFields: fields,
    canEditField: editable,
  });

  assert.deepEqual(changes.custom, [{ fieldId: 'choices', value: ['Scotland', 'Wales'] }]);
});

test('a failed custom-field update does not commit snapshots and remains dirty for retry', async () => {
  const input = {
    formData: { description: 'Changed' },
    persistedFormData: { description: 'Persisted' },
    customFieldValues: { scalar: 'Changed custom' },
    persistedCustomFieldValues: { scalar: 'Persisted custom' },
    customFields: fields,
    canEditField: editable,
  };

  const firstAttempt = deriveOrganisationSaveChanges(input);
  let committed = false;
  await assert.rejects(executeOrganisationSavePlan({
    changes: firstAttempt,
    updateCore: async () => {},
    updateCustom: async () => { throw new Error('preference update failed'); },
    commitSnapshots: () => { committed = true; },
  }), /preference update failed/);
  assert.equal(committed, false);

  const retry = deriveOrganisationSaveChanges(input);
  assert.deepEqual(retry, firstAttempt);
  assert.deepEqual(retry.custom, [{ fieldId: 'scalar', value: 'Changed custom' }]);
});