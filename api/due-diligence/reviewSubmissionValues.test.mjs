import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { effectiveReviewSubmissionValues } from './reviewSubmissionValues.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(here, file), 'utf8');

test('effective review values use amended field IDs and preserve original ID/name fallbacks', () => {
  const form = {
    fields: [
      { id: 'organisation', name: 'Organisation', type: 'organisation_dropdown' },
      { id: 'unit', name: 'Unit', type: 'relationship_dropdown' },
    ],
  };
  assert.deepEqual(
    effectiveReviewSubmissionValues(
      form,
      { Organisation: 'org-original', unit: 'unit-original' },
      { organisation: 'org-amended', unit: undefined },
    ),
    { organisation: 'org-amended', unit: 'unit-original' },
  );
});

test('review saves validate effective relationship amendments before persistence', () => {
  const source = read('save-review.js');
  assert.match(source, /createFormRelationshipService/);
  assert.match(source, /effectiveReviewSubmissionValues/);
  assert.match(source, /validateSubmission\(\{ form, submissionData \}\)/);
  assert.ok(
    source.indexOf('validateSubmission({ form, submissionData })') < source.indexOf('.update(updateData)'),
    'relationship validation must happen before the review update',
  );
  assert.match(source, /status\(400\)\.json\(\{ error: 'Invalid relationship selection' \}\)/);
});

test('due-diligence submission reads include the form slug required by review relationship options', () => {
  assert.match(read('get-submission.js'), /\.select\('id, name, slug, fields, pages, due_diligence_required'\)/);
});
