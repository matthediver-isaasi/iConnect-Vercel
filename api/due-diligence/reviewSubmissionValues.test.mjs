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

test('effective review values preserve an original repeatable answer until an amendment replaces it', () => {
  const form = {
    fields: [{
      id: 'assets',
      name: 'Assets',
      type: 'repeatable_rows',
      children: [
        { id: 'type', type: 'relationship_dropdown' },
        { id: 'maker', type: 'relationship_dropdown' },
        { id: 'model', type: 'relationship_dropdown' },
      ],
    }],
  };
  const originalRows = [{
    _row_id: 'row-1',
    type: 'type-a',
    maker: 'Acme',
    model: 'model-a',
  }];
  assert.deepEqual(
    effectiveReviewSubmissionValues(form, { Assets: originalRows }, {}),
    { assets: originalRows },
  );
  const amendedRows = [{
    _row_id: 'row-1',
    type: 'type-a',
    maker: 'Beta',
    model: 'model-b',
  }];
  assert.deepEqual(
    effectiveReviewSubmissionValues(form, { Assets: originalRows }, { assets: amendedRows }),
    { assets: amendedRows },
  );
});

test('effective review values preserve not-listed text and clear it when the answer is amended away', () => {
  const form = {
    fields: [{
      id: 'organisation',
      type: 'organisation_dropdown',
      not_listed_choice: { enabled: true, label: 'Other organisation' },
    }],
  };
  assert.deepEqual(effectiveReviewSubmissionValues(
    form,
    {
      organisation: '__form_not_listed__',
      __not_listed_choice_text: { organisation: 'Independent organisation' },
    },
    {},
  ), {
    organisation: '__form_not_listed__',
    __not_listed_choice_text: { organisation: 'Independent organisation' },
  });
  assert.deepEqual(effectiveReviewSubmissionValues(
    form,
    {
      organisation: '__form_not_listed__',
      __not_listed_choice_text: { organisation: 'Independent organisation' },
    },
    { organisation: 'org-1' },
  ), { organisation: 'org-1' });
});

test('review saves validate effective relationship amendments before persistence', () => {
  const source = read('save-review.js');
  assert.match(source, /createFormRelationshipService/);
  assert.match(source, /validateRepeatableRowSubmission/);
  assert.match(source, /computeHiddenFieldIds/);
  assert.match(source, /effectiveReviewSubmissionValues/);
  assert.match(
    source,
    /validateRepeatableRowSubmission\(\{[\s\S]*?form,[\s\S]*?submissionData,[\s\S]*?hiddenFieldIds/,
  );
  assert.match(
    source,
    /validateSubmission\(\{[\s\S]*?form,[\s\S]*?submissionData,[\s\S]*?hiddenFieldIds/,
  );
  assert.ok(
    source.indexOf('validateRepeatableRowSubmission({') < source.indexOf('.update(updateData)'),
    'repeatable row-source validation must happen before the review update',
  );
  assert.ok(
    source.indexOf('.validateSubmission({') < source.indexOf('.update(updateData)'),
    'ordinary relationship validation must happen before the review update',
  );
  assert.match(source, /status\(400\)\.json\(\{ error: 'Invalid relationship selection' \}\)/);
});

test('due-diligence submission reads include the form slug required by review relationship options', () => {
  assert.match(read('get-submission.js'), /\.select\('id, name, slug, fields, pages, due_diligence_required'\)/);
});
