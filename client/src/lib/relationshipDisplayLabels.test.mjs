import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  UNAVAILABLE_RELATIONSHIP_RECORD,
  collectRelationshipRecordIds,
  collectRelationshipRecordIdsFromSubmissions,
  formatRelationshipDisplayValue,
  getSubmissionFieldValue,
  resolveSubmissionField,
  resolveRelationshipDisplayLabel,
} from './relationshipDisplayLabels.js';

test('collects only stored relationship dropdown record IDs', () => {
  const fields = [
    { id: 'department', type: 'relationship_dropdown' },
    { id: 'notes', type: 'text' },
    { id: 'other', name: 'legacy_relationship', type: 'relationship_dropdown' },
  ];
  const values = {
    department: 'record-1',
    notes: 'must not be treated as an ID',
    legacy_relationship: 'record-2',
  };

  assert.deepEqual(collectRelationshipRecordIds(fields, values), ['record-1', 'record-2']);
});

test('resolves labels without exposing missing record IDs', () => {
  const labels = { 'record-1': 'Finance' };
  assert.equal(resolveRelationshipDisplayLabel('record-1', labels), 'Finance');
  assert.equal(
    resolveRelationshipDisplayLabel('private-record-uuid', labels),
    UNAVAILABLE_RELATIONSHIP_RECORD,
  );
  assert.equal(resolveRelationshipDisplayLabel('', labels), '');
});

test('formats arrays and safely falls back for archived records', () => {
  assert.equal(
    formatRelationshipDisplayValue(['active', 'archived'], new Map([['active', 'Operations']])),
    'Operations, Unavailable record',
  );
});

test('resolves a legacy name-keyed relationship value to its label', () => {
  const field = { id: 'relationship-id', name: 'legacy_relationship', type: 'relationship_dropdown' };
  const value = getSubmissionFieldValue({ legacy_relationship: 'record-1' }, field);

  assert.equal(formatRelationshipDisplayValue(value, { 'record-1': 'Finance' }), 'Finance');
});

test('legacy name-keyed relationships use a safe fallback and never expose the UUID', () => {
  const uuid = '63afb32d-4cf3-48d6-a7ab-d25d25f529e1';
  const field = { id: 'relationship-id', name: 'legacy_relationship', type: 'relationship_dropdown' };
  const value = getSubmissionFieldValue({ legacy_relationship: uuid }, field);
  const display = formatRelationshipDisplayValue(value, {});

  assert.equal(display, UNAVAILABLE_RELATIONSHIP_RECORD);
  assert.equal(display.includes(uuid), false);
});

test('linked-form report export resolves a current ID-keyed relationship answer', () => {
  const field = { id: 'relationship-id', name: 'legacy_relationship', type: 'relationship_dropdown' };
  const formsById = { 'form-1': { fields: [field] } };
  const submission = {
    id: 'submission-1',
    form_id: 'form-1',
    submission_data: { 'relationship-id': 'record-1' },
  };

  assert.deepEqual(
    collectRelationshipRecordIdsFromSubmissions(formsById, [submission]),
    ['record-1'],
  );
  assert.equal(
    formatRelationshipDisplayValue(
      getSubmissionFieldValue(submission.submission_data, field),
      { 'record-1': 'Finance' },
    ),
    'Finance',
  );
});

test('field values and metadata prefer IDs over names when ambiguous', () => {
  const fields = [
    { id: 'first-id', name: 'shared' },
    { id: 'shared', name: 'second-name' },
  ];
  assert.equal(resolveSubmissionField(fields, 'shared'), fields[1]);
  assert.equal(
    getSubmissionFieldValue({ 'first-id': null, shared: 'legacy-value' }, fields[0]),
    null,
  );
});

test('relationship collection prefers the field ID over a saved name fallback', () => {
  const field = {
    id: 'current-relationship-id',
    name: 'legacy_relationship_name',
    type: 'relationship_dropdown',
  };
  const values = {
    'current-relationship-id': 'current-record',
    legacy_relationship_name: 'stale-record',
  };

  assert.deepEqual(collectRelationshipRecordIds([field], values), ['current-record']);
  assert.equal(getSubmissionFieldValue(values, field), 'current-record');
});

test('brief copyright and case-study previews batch safe relationship labels', () => {
  const source = readFileSync(
    new URL('../pages/BriefDetail.jsx', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /collectRelationshipRecordIds\(\s*form\?\.fields \|\| \[\],\s*submission\?\.submission_data,\s*\)/,
  );
  assert.match(source, /submissionIds:\s*relationshipSubmissionIds/);
  assert.match(source, /context:\s*"form-submissions"/);
  assert.match(source, /credentials:\s*"include"/);
  assert.match(
    source,
    /field = resolveSubmissionField\(savedFields, key\)[\s\S]*?hasOwnProperty\.call\(data, field\.id\)/,
  );
  assert.match(
    source,
    /field\?\.type === 'relationship_dropdown'[\s\S]*?formatRelationshipDisplayValue\(value, relationshipLabelsByRecordId\)/,
  );
  assert.match(
    source,
    /renderCopyrightSubmissionData[\s\S]*?relationshipLabelsLoading[\s\S]*?processSubmissionData\([\s\S]*?relationshipLabelsByRecordId/,
  );
  assert.match(
    source,
    /renderSubmissionDataFor[\s\S]*?relationshipLabelsLoading[\s\S]*?processSubmissionData\([\s\S]*?relationshipLabelsByRecordId/,
  );
});

test('configured dashboard reference resolves metadata ID-first and safely formats relationships', () => {
  const fields = [
    { id: 'legacy-id', name: 'configured-reference', type: 'text' },
    { id: 'configured-reference', name: 'supplier', type: 'relationship_dropdown' },
  ];
  const field = resolveSubmissionField(fields, 'configured-reference');
  const uuid = '63afb32d-4cf3-48d6-a7ab-d25d25f529e1';
  const value = getSubmissionFieldValue({
    'configured-reference': uuid,
    supplier: 'wrong-name-fallback',
  }, field);

  assert.equal(field, fields[1]);
  assert.equal(value, uuid);
  assert.equal(
    formatRelationshipDisplayValue(value, {}),
    UNAVAILABLE_RELATIONSHIP_RECORD,
  );
});

test('due diligence dashboard batches scoped relationship labels and gates references', () => {
  const source = readFileSync(
    new URL('../pages/DueDiligenceDashboard.jsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /resolveSubmissionField\(formsById\[formId\]\?\.fields,\s*cardReferenceField\)/);
  assert.match(source, /getSubmissionFieldValue\(formValues,\s*configuredField\)/);
  assert.match(source, /formatRelationshipDisplayValue\(configuredValue,\s*relationshipLabelsByRecordId\)/);
  assert.match(source, /submissionIds:\s*batch\.submissionIds/);
  assert.match(source, /context:\s*'review-submission'/);
  assert.match(source, /submissionsLoading\s*\|\|\s*formsLoading\s*\|\|\s*relationshipLabelsLoading/);
  assert.match(source, /displayReference=\{getDisplayReference\(submission\)\}/);
  assert.match(source, /relationshipLabelsLoading[\s\S]*?'Loading related record…'[\s\S]*?getDisplayReference\(submissionToDelete\)/);
});

test('organisation submission preview wires scoped relationship labels and safe value resolution', () => {
  const source = readFileSync(
    new URL('../components/OrganisationDetailView.jsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /collectRelationshipRecordIdsFromSubmissions\(formsMap, orgFormSubmissions\)/);
  assert.match(source, /submissionIds:\s*submissionBatch\.map\(\(submission\) => submission\.id\)/);
  assert.match(source, /context:\s*'form-submissions'/);
  assert.match(source, /credentials:\s*'include'/);
  assert.match(source, /value:\s*getSubmissionFieldValue\(values, field\)/);
  assert.match(source, /formatRelationshipDisplayValue\(value, relationshipLabelsByRecordId\)/);
  assert.match(source, /relationshipLabelsLoading[\s\S]*?'Loading related record…'/);
});
