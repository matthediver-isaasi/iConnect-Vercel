import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./MemberGroupDetail.jsx', import.meta.url), 'utf8');

test('vacancy previews batch only loaded submissions backed by saved forms', () => {
  assert.match(source, /Object\.values\(submissionsByVacancy\)/);
  assert.match(source, /submission\.form_id[\s\S]*?vacancyFormsById\[submission\.form_id\]/);
  assert.match(
    source,
    /collectRelationshipRecordIdsFromSubmissions\(\s*vacancyFormsById,\s*relationshipSubmissionBatch/,
  );
  assert.match(source, /submissionIds: submissionBatch\.map\(\(submission\) => submission\.id\)/);
  assert.match(source, /context: "form-submissions"/);
  assert.match(source, /credentials: "include"/);
});

test('vacancy previews resolve saved metadata ID-first and never flash relationship IDs', () => {
  assert.match(source, /resolveSubmissionField\(\s*submissionsForm\?\.fields,\s*fieldId/);
  assert.match(source, /getSubmissionFieldValue\(data, field\)/);
  assert.match(
    source,
    /field\?\.type === "relationship_dropdown"[\s\S]*?formatRelationshipDisplayValue\(\s*savedValue,\s*relationshipLabelsByRecordId/,
  );
  assert.match(
    source,
    /field\?\.type === "relationship_dropdown"[\s\S]*?relationshipLabelsLoading[\s\S]*?"Loading related record…"/,
  );
});