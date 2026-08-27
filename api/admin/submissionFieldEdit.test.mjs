import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import {
  effectiveSubmissionFieldEdit,
  normalizeSubmissionFieldIds,
  validateSubmissionFieldEditCandidates,
} from './submissionFieldEdit.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function relationshipValidator(validSelections) {
  return {
    async validateSubmission({ submissionData }) {
      if (submissionData.relationship
        && validSelections[submissionData.organisation] !== submissionData.relationship) {
        throw new Error('Invalid relationship selection');
      }
    },
  };
}

const form = {
  fields: [
    { id: 'organisation', type: 'organisation_dropdown' },
    {
      id: 'relationship',
      type: 'relationship_dropdown',
      parent_field_id: 'organisation',
    },
    { id: 'notes', type: 'text' },
  ],
};

test('relationship field edits validate the complete submission and reject forged IDs', async () => {
  const submissionData = effectiveSubmissionFieldEdit({
    organisation: 'org-1',
    relationship: 'related-1',
    notes: 'saved',
  }, 'relationship', 'forged-related-id');
  await assert.rejects(
    () => relationshipValidator({ 'org-1': 'related-1' })
      .validateSubmission({ form, submissionData }),
    /Invalid relationship selection/,
  );
});

test('organisation edits retain and validate an existing dependent relationship value', async () => {
  const submissionData = effectiveSubmissionFieldEdit({
    organisation: 'org-1',
    relationship: 'related-1',
    notes: 'saved',
  }, 'organisation', 'org-2');
  await assert.rejects(
    () => relationshipValidator({
        'org-1': 'related-1',
        'org-2': 'related-2',
      }).validateSubmission({ form, submissionData }),
    /Invalid relationship selection/,
  );
});

test('valid edits return all saved values with only the requested field changed', async () => {
  const updated = effectiveSubmissionFieldEdit({
    organisation: 'org-1',
    relationship: 'related-1',
    notes: 'before',
  }, 'notes', 'after');
  await relationshipValidator({ 'org-1': 'related-1' })
    .validateSubmission({ form, submissionData: updated });

  assert.deepEqual(updated, {
    organisation: 'org-1',
    relationship: 'related-1',
    notes: 'after',
  });
});

test('legacy name-keyed main and DD values are normalized before both validations', async () => {
  const legacyForm = {
    fields: [
      { id: 'organisation', name: 'Organisation', type: 'organisation_dropdown' },
      { id: 'relationship', name: 'Department', type: 'relationship_dropdown' },
      { id: 'notes', name: 'Notes', type: 'text' },
    ],
  };
  const validated = [];
  const result = await validateSubmissionFieldEditCandidates({
    relationshipService: {
      async validateSubmission({ submissionData }) {
        validated.push(submissionData);
      },
    },
    form: legacyForm,
    submissionData: {
      Organisation: 'org-legacy',
      Department: 'related-legacy',
      mainOnly: 'preserved',
    },
    originalFormValues: {
      Organisation: 'org-dd-legacy',
      Department: 'related-dd-legacy',
      ddOnly: 'preserved',
    },
    hasDueDiligenceRecord: true,
    fieldId: 'notes',
    value: 'edited',
  });

  assert.deepEqual(
    validated,
    [
      {
        organisation: 'org-legacy',
        relationship: 'related-legacy',
        notes: 'edited',
      },
      {
        organisation: 'org-dd-legacy',
        relationship: 'related-dd-legacy',
        notes: 'edited',
      },
    ],
  );
  assert.deepEqual(
    normalizeSubmissionFieldIds(legacyForm, result.updatedSubmissionData),
    {
      organisation: 'org-legacy',
      relationship: 'related-legacy',
      notes: 'edited',
    },
  );
  assert.equal(result.updatedSubmissionData.mainOnly, 'preserved');
  assert.equal(result.updatedOriginalValues.ddOnly, 'preserved');
});

test('divergent DD values must validate after the main candidate before persistence', async () => {
  const validated = [];
  const relationshipService = {
    async validateSubmission({ submissionData }) {
      validated.push(submissionData);
      if (submissionData.relationship === 'dd-unrelated') {
        throw new Error('Invalid relationship selection');
      }
    },
  };

  await assert.rejects(
    () => validateSubmissionFieldEditCandidates({
      relationshipService,
      form,
      submissionData: {
        organisation: 'org-1',
        relationship: 'related-1',
        mainOnly: 'keep-main',
      },
      originalFormValues: {
        organisation: 'org-1',
        relationship: 'dd-unrelated',
        ddOnly: 'keep-dd',
      },
      hasDueDiligenceRecord: true,
      fieldId: 'notes',
      value: 'edited',
    }),
    /Invalid relationship selection/,
  );
  assert.equal(validated.length, 2);
  assert.equal(validated[0].relationship, 'related-1');
  assert.equal(validated[1].relationship, 'dd-unrelated');
});

test('candidate persistence preserves unrelated main and DD stored keys', async () => {
  const result = await validateSubmissionFieldEditCandidates({
    relationshipService: relationshipValidator({ 'org-1': 'related-1' }),
    form,
    submissionData: {
      organisation: 'org-1', relationship: 'related-1', mainOnly: 'keep-main',
    },
    originalFormValues: {
      organisation: 'org-1', relationship: 'related-1', ddOnly: 'keep-dd',
    },
    hasDueDiligenceRecord: true,
    fieldId: 'notes',
    value: 'edited',
  });
  assert.equal(result.updatedSubmissionData.mainOnly, 'keep-main');
  assert.equal(result.updatedOriginalValues.ddOnly, 'keep-dd');
});

test('update endpoint fetches DD and validates both candidates before any write', () => {
  const source = readFileSync(path.join(here, 'update-submission-field.js'), 'utf8');
  const accessCheck = source.indexOf("isResourceExcluded(exclusions, 'page_FormSubmissions')");
  const submissionRead = source.indexOf(".from('form_submission')");
  assert.ok(accessCheck > -1 && accessCheck < submissionRead, 'authorization must run before submission reads');
  assert.match(source, /if \(!context\.tenantUserId\)/);
  assert.match(source, /if \(!context\.roleId\)[\s\S]*?status\(403\)/);
  assert.match(
    source,
    /\.from\('role'\)[\s\S]*?\.eq\('id', context\.roleId\)[\s\S]*?\.eq\('tenant_id', context\.tenantId\)/,
  );
  assert.match(source, /context\.memberExcludedFeatures/);
  assert.match(
    source,
    /\.from\('form_submission'\)[\s\S]*?\.select\('id, form_id, submission_data'\)[\s\S]*?\.eq\('id', submission_id\)[\s\S]*?\.eq\('tenant_id', session\.tenant_id\)[\s\S]*?\.single\(\)/,
  );
  assert.match(source, /\.from\('form'\)[\s\S]*?\.eq\('tenant_id', session\.tenant_id\)/);
  assert.match(source, /createFormRelationshipService\(\{[\s\S]*?tenantId: session\.tenant_id/);
  assert.match(source, /validateSubmissionFieldEditCandidates\(/);
  const ddFetch = source.indexOf(".from('form_submission_due_diligence')");
  const validation = source.indexOf('validateSubmissionFieldEditCandidates({');
  const firstUpdate = source.indexOf('.update({ submission_data:');
  assert.ok(ddFetch > -1 && ddFetch < validation, 'DD values must be fetched before validation');
  assert.ok(
    validation < firstUpdate,
    'both candidate validations must complete before the first write',
  );
  assert.match(source, /error instanceof FormRelationshipError && error\.status < 500/);
  assert.match(source, /status\(400\)\.json\(\{ error: 'Invalid relationship selection' \}\)/);
  assert.match(source, /status\(500\)\.json\(\{ error: 'Failed to validate submission' \}\)/);
  assert.match(
    source,
    /\.update\(\{ submission_data: updatedSubmissionData \}\)[\s\S]*?\.eq\('id', submission_id\)[\s\S]*?\.eq\('tenant_id', session\.tenant_id\)/,
  );
});