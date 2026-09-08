import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildPublicFormProcessingPayload } from '../_lib/publicFormProcessingPayload.js';
import {
  FORM_NOT_LISTED_TEXT_KEY,
  FORM_NOT_LISTED_VALUE,
} from '../../shared/formNotListedChoice.js';

test('ordinary submissions load persisted visibility context for repeatable validation', async () => {
  const source = await readFile(new URL('./form-submission.js', import.meta.url), 'utf8');
  assert.match(source, /\.select\('[^']*\bfields, pages, visibility_rules\b[^']*'\)/);
  assert.match(source, /validateRepeatableRowSubmission\(\{[\s\S]*?visibilityOptions: submissionVisibilityOptions,/);
});

test('survey submissions validate repeatable rows against the published visibility snapshot', async () => {
  const source = await readFile(new URL('./form-submission.js', import.meta.url), 'utf8');
  assert.match(source, /const relationshipForm = isSurvey \? \{[\s\S]*?fields: surveyVersion\?\.fields \|\| \[\],[\s\S]*?pages: surveyVersion\?\.pages \|\| \[\],[\s\S]*?visibility_rules: surveyVersion\?\.visibility_rules \|\| \[\]/);
  const validationStart = source.indexOf('await validateRepeatableRowSubmission({');
  const validationEnd = source.indexOf('});', validationStart);
  const validation = source.slice(validationStart, validationEnd);
  assert.match(validation, /form: relationshipForm/);
  assert.match(validation, /hiddenFieldIds: hiddenRelationshipFieldIds/);
});

test('public submissions normalize not-listed organisation targets before UUID-backed use', async () => {
  const source = await readFile(new URL('./form-submission.js', import.meta.url), 'utf8');
  const normalization = source.indexOf(
    'const prefill_organization_id = normalizeFormPrefillOrganizationId(requestedPrefillOrganizationId)',
  );
  const duplicateLookup = source.indexOf("organization_id.eq.${prefill_organization_id}");
  const submissionInsert = source.indexOf('...(prefill_organization_id && { organization_id: prefill_organization_id })');
  const pipelinePayload = source.indexOf('prefillOrganizationId: prefill_organization_id');
  assert.ok(normalization > -1);
  assert.ok(duplicateLookup > normalization);
  assert.ok(submissionInsert > normalization);
  assert.ok(pipelinePayload > normalization);
});

test('public pipeline handoff preserves persisted fields, mappings, sentinel, and nested companion text', async () => {
  const field = {
    id: 'organisation',
    type: 'organisation_dropdown',
    not_listed_choice: { enabled: true, label: 'My organisation is not listed' },
  };
  const pipeline = {
    organisations: [{
      id: 'primary-organisation',
      mappings: [{
        source_field_id: field.id,
        target_type: 'core',
        target_field: 'organisation_name',
      }],
    }],
  };
  const submissionData = {
    [field.id]: FORM_NOT_LISTED_VALUE,
    [FORM_NOT_LISTED_TEXT_KEY]: { [field.id]: 'Runtime Organisation Ltd' },
  };
  const payload = buildPublicFormProcessingPayload({
    form: {
      id: 'form-1',
      fields: [field],
      field_mappings: [],
      application_level: 'organization',
      entity_pipelines: pipeline,
    },
    submissionData,
    submissionId: 'submission-1',
    tenantId: 'tenant-1',
    verifiedSubmitterMemberId: null,
    verifiedAdminAccess: false,
  });
  assert.strictEqual(payload.form_values, submissionData);
  assert.strictEqual(payload.fields[0], field);
  assert.strictEqual(payload.entity_pipelines, pipeline);
  assert.equal(payload.form_values.organisation, FORM_NOT_LISTED_VALUE);
  assert.equal(payload.form_values[FORM_NOT_LISTED_TEXT_KEY].organisation, 'Runtime Organisation Ltd');

  const source = await readFile(new URL('./form-submission.js', import.meta.url), 'utf8');
  assert.match(source, /JSON\.stringify\(buildPublicFormProcessingPayload\(\{/);
});