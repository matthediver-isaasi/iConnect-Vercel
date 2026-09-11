import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import handler, { buildSubmissionEmailRequestContext } from './form-submission.js';
import { buildPublicFormProcessingPayload } from '../_lib/publicFormProcessingPayload.js';
import {
  FORM_NOT_LISTED_LABELS_KEY,
  FORM_NOT_LISTED_TEXT_KEY,
  FORM_NOT_LISTED_VALUE,
} from '../../shared/formNotListedChoice.js';

const LIVE_ORGANISATION_FIELD_ID = 'field_1787065791684';
const LIVE_ORGANISATION_REGION_SOURCE_ID = 'student_org_region';
const LIVE_ORGANISATION_REGION_FIELD_ID = 'organization-region';

function affectedFormFixture() {
  const organisationField = {
    id: LIVE_ORGANISATION_FIELD_ID,
    type: 'organisation_dropdown',
    not_listed_choice: { enabled: true, label: 'Not listed' },
  };
  return {
    id: '7a173155-7932-4f80-bac3-12644920b9a0',
    name: 'Student join',
    tenant_id: 'tenant-student-join',
    require_authentication: false,
    access_policy: null,
    fields: [
      { id: 'student_email', type: 'email' },
      { id: 'student_first_name', type: 'text' },
      { id: 'student_last_name', type: 'text' },
      organisationField,
      { id: LIVE_ORGANISATION_REGION_SOURCE_ID, type: 'select' },
      { id: 'student_org_address_1', type: 'text' },
      { id: 'student_org_address_2', type: 'text' },
    ],
    pages: [],
    visibility_rules: [],
    field_mappings: [],
    application_level: 'member',
    create_entity_type: 'member',
    entity_action: 'create',
    member_entity_action: 'none',
    organization_entity_action: 'none',
    additional_member_creations: [],
    entity_pipelines: {
      members: [{
        id: 'member-primary',
        isPrimary: true,
        mappings: [
          { source_type: 'field', source_field_id: 'student_email', target_type: 'core', target_field: 'email', target_entity: 'member' },
          { source_type: 'field', source_field_id: 'student_first_name', target_type: 'core', target_field: 'first_name', target_entity: 'member' },
          { source_type: 'field', source_field_id: 'student_last_name', target_type: 'core', target_field: 'last_name', target_entity: 'member' },
        ],
      }],
      organisations: [{
        id: 'org-primary',
        isPrimary: true,
        uniqueness_key: 'name',
        mappings: [
          {
            source_type: 'field',
            source_field_id: organisationField.id,
            target_type: 'core',
            target_field: 'name',
            target_entity: 'organization',
          },
          {
            source_type: 'field',
            source_field_id: LIVE_ORGANISATION_REGION_SOURCE_ID,
            target_type: 'custom',
            target_field: LIVE_ORGANISATION_REGION_FIELD_ID,
            target_entity: 'organization',
          },
          {
            source_type: 'field',
            source_field_id: 'student_org_address_1',
            target_type: 'core',
            target_field: 'address',
            target_entity: 'organization',
          },
          {
            source_type: 'field',
            source_field_id: 'student_org_address_2',
            target_type: 'core',
            target_field: 'invoicing_address',
            target_entity: 'organization',
          },
        ],
      }],
    },
    structured_actions: null,
    allow_submitter_email_copy: false,
    prevent_duplicate_email_submission: false,
    is_event_related: false,
    form_type: null,
  };
}

function makePublicSubmissionBoundaryDb(
  form,
  {
    organization = null,
    surveyVersion = null,
    surveySnapshots = null,
    existingSubmission = null,
    failReadyOnce = false,
    failCheckpointOnce = false,
  } = {},
) {
  const insertedSubmissions = [];
  const deletedSubmissionIds = [];
  let submissionRow = existingSubmission ? structuredClone(existingSubmission) : null;
  let readyFailuresRemaining = failReadyOnce ? 1 : 0;
  let checkpointFailuresRemaining = failCheckpointOnce ? 1 : 0;

  class Query {
    constructor(table) {
      this.table = table;
      this.selected = '';
      this.insertPayload = null;
      this.updatePayload = null;
      this.deleteOperation = false;
      this.filters = [];
    }
    select(columns = '*') { this.selected = columns; return this; }
    insert(payload) {
      this.insertPayload = payload;
      if (this.table === 'form_submission') insertedSubmissions.push(payload);
      return this;
    }
    update(payload) { this.updatePayload = payload; return this; }
    delete() { this.deleteOperation = true; return this; }
    eq(column, value) { this.filters.push(['eq', column, value]); return this; }
    neq() { return this; }
    ilike() { return this; }
    in() { return this; }
    is() { return this; }
    not() { return this; }
    or() { return this; }
    gt() { return this; }
    gte() { return this; }
    lt() { return this; }
    lte() { return this; }
    contains() { return this; }
    order() { return this; }
    limit() { return this; }
    range() { return this; }
    async single() {
      if (this.table === 'form') return { data: form, error: null };
      if (this.table === 'form_submission' && this.insertPayload) {
        submissionRow = {
          id: 'submission-student-join',
          ...structuredClone(this.insertPayload),
        };
        return {
          data: structuredClone(submissionRow),
          error: null,
        };
      }
      return { data: null, error: null };
    }
    async maybeSingle() {
      if (this.table === 'survey_version') {
        const snapshotId = this.filters.find(
          filter => filter[0] === 'eq' && filter[1] === 'id',
        )?.[2];
        return {
          data: (snapshotId && surveySnapshots?.[snapshotId]) || surveyVersion,
          error: null,
        };
      }
      if (this.table === 'form_submission' && submissionRow) {
        return { data: structuredClone(submissionRow), error: null };
      }
      if (this.table === 'organization') {
        const id = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'id')?.[2];
        const tenantId = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'tenant_id')?.[2];
        if (organization?.id === id && organization?.tenant_id === tenantId) {
          return { data: organization, error: null };
        }
      }
      return { data: null, error: null };
    }
    then(resolve, reject) {
      if (this.table === 'form_submission' && this.deleteOperation) {
        const id = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'id')?.[2];
        if (id) deletedSubmissionIds.push(id);
      }
      if (this.table === 'form_submission' && this.updatePayload && submissionRow) {
        const id = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'id')?.[2];
        const expectedStatus = this.filters.find(
          filter => filter[0] === 'eq' && filter[1] === 'submission_email_state->>status',
        )?.[2];
        const matches = (!id || submissionRow.id === id)
          && (!expectedStatus || submissionRow.submission_email_state?.status === expectedStatus);
        if (matches) {
          if (
            this.updatePayload.submission_email_state?.status === 'ready'
            && readyFailuresRemaining > 0
          ) {
            readyFailuresRemaining -= 1;
            return Promise.resolve({
              data: null,
              error: { code: 'TRANSIENT', message: 'Temporary ready-state write failure' },
            }).then(resolve, reject);
          }
          if (
            this.updatePayload.submission_email_state?.status === 'pending'
            && this.updatePayload.submission_email_state?.post_processing_completed_at
            && checkpointFailuresRemaining > 0
          ) {
            checkpointFailuresRemaining -= 1;
            return Promise.resolve({
              data: null,
              error: { code: 'TRANSIENT', message: 'Temporary checkpoint write failure' },
            }).then(resolve, reject);
          }
          submissionRow = { ...submissionRow, ...structuredClone(this.updatePayload) };
          return Promise.resolve({ data: [{ id: submissionRow.id }], error: null }).then(resolve, reject);
        }
      }
      return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
    }
  }

  return {
    insertedSubmissions,
    deletedSubmissionIds,
    getSubmissionRow() { return structuredClone(submissionRow); },
    client: {
      from(table) { return new Query(table); },
      async rpc() { return { data: null, error: null }; },
    },
  };
}

function makeResponseRecorder() {
  const response = { statusCode: 200, body: null, headers: {} };
  return {
    response,
    res: {
      setHeader(name, value) { response.headers[name] = value; },
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return body; },
    },
  };
}

test('ordinary submissions load persisted visibility context for repeatable validation', async () => {
  const source = await readFile(new URL('./form-submission.js', import.meta.url), 'utf8');
  assert.match(source, /\.select\('[^']*\bfields, pages, visibility_rules\b[^']*'\)/);
  assert.match(source, /validateRepeatableRowSubmission\(\{[\s\S]*?visibilityOptions: submissionVisibilityOptions,/);
});

test('ordinary submissions validate persisted row-source answers before the first submission write', async () => {
  const source = await readFile(new URL('./form-submission.js', import.meta.url), 'utf8');
  const validation = source.indexOf('await validateRepeatableRowSubmission({');
  const insert = source.indexOf('.insert(finalSubmissionRecord)');
  assert.ok(validation > -1, 'shared repeatable row-source validator is invoked');
  assert.ok(insert > validation, 'row-source validation completes before submission persistence');
  const validationBlock = source.slice(validation, source.indexOf('});', validation));
  assert.match(validationBlock, /form: relationshipForm/);
  assert.match(validationBlock, /submissionData: submission_data \|\| \{\}/);
  assert.doesNotMatch(validationBlock, /req\.body\.(?:fields|option_source)/);
});

test('submission email diagnostics normalize token-bearing paths and ignore unknown surfaces', () => {
  const diagnostics = buildSubmissionEmailRequestContext({
    headers: {
      host: 'tenant.iconn.app',
      referer: 'https://tenant.iconn.app/survey/private-assignment-token?draft_token=secret',
    },
  }, 'attacker-controlled');
  assert.equal(diagnostics.surface, 'native-or-api');
  assert.equal(diagnostics.referrer_route, '/survey/:token');
  assert.equal(JSON.stringify(diagnostics).includes('private-assignment-token'), false);
  assert.equal(JSON.stringify(diagnostics).includes('draft_token'), false);
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

test('public submission rejects future-only dates before inserting and uses the published survey snapshot', async () => {
  const liveDateField = {
    id: 'future-date',
    type: 'date',
    future_only: false,
  };
  const snapshotDateField = {
    ...liveDateField,
    future_only: true,
  };
  const form = {
    ...affectedFormFixture(),
    fields: [liveDateField],
    entity_action: 'none',
    entity_pipelines: { members: [], organisations: [] },
    form_type: 'survey',
    survey_settings: {
      status: 'published',
      current_version: 3,
      response_identity: 'identified',
    },
  };
  const db = makePublicSubmissionBoundaryDb(form, {
    surveyVersion: {
      id: 'survey-version-3',
      version_number: 3,
      fields: [snapshotDateField],
      pages: [],
      visibility_rules: [],
      survey_settings: form.survey_settings,
    },
  });
  const { response, res } = makeResponseRecorder();

  await handler({
    method: 'POST',
    headers: { host: 'student-join.test' },
    body: {
      form_id: form.id,
      form_name: form.name,
      submission_data: { [snapshotDateField.id]: '2020-01-01' },
    },
  }, res, {
    supabase: db.client,
    tenantData: { id: form.tenant_id, slug: 'student-join', domain: 'student-join.test' },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'FUTURE_DATE_INVALID');
  assert.equal(response.body.details[0].field_id, snapshotDateField.id);
  assert.equal(db.insertedSubmissions.length, 0);
});

test('anonymous survey retries after republish use the original redaction snapshot', async () => {
  const form = {
    ...affectedFormFixture(),
    fields: [
      { id: 'respondent-email', type: 'email' },
      { id: 'answer', type: 'text' },
    ],
    entity_action: 'none',
    entity_pipelines: { members: [], organisations: [] },
    form_type: 'survey',
    survey_settings: {
      status: 'published',
      current_version: 5,
      response_identity: 'anonymous',
    },
  };
  const originalSurveyVersion = {
    id: 'survey-version-4',
    version_number: 4,
    fields: form.fields,
    pages: [],
    visibility_rules: [],
    survey_settings: {
      ...form.survey_settings,
      current_version: 4,
    },
  };
  const db = makePublicSubmissionBoundaryDb(form, {
    existingSubmission: {
      id: 'anonymous-survey-submission',
      is_anonymous: true,
      survey_version_id: 'survey-version-4',
      submission_data: { answer: 'same' },
      communication_finalization_state: null,
      processing_notes: [],
    },
    surveyVersion: {
      id: 'survey-version-5',
      version_number: 5,
      fields: [
        { id: 'respondent-email', type: 'text' },
        { id: 'answer', type: 'text' },
      ],
      pages: [],
      visibility_rules: [],
      survey_settings: form.survey_settings,
    },
    surveySnapshots: { 'survey-version-4': originalSurveyVersion },
  });
  const { response, res } = makeResponseRecorder();

  await handler({
    method: 'POST',
    headers: { host: 'student-join.test' },
    body: {
      form_id: form.id,
      idempotency_key: 'anonymous-survey-retry-key',
      submission_data: {
        'respondent-email': 'new-private@example.test',
        answer: 'same',
      },
    },
  }, res, {
    supabase: db.client,
    tenantData: { id: form.tenant_id, slug: 'student-join', domain: 'student-join.test' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.duplicate, true);
  assert.equal(response.body.id, 'anonymous-survey-submission');
  assert.equal(db.insertedSubmissions.length, 0);
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
    submission: {
      id: 'submission-1',
      submission_data: submissionData,
    },
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
  assert.match(source, /buildPublicFormProcessingPayload\(\{[\s\S]*?form,[\s\S]*?submission,[\s\S]*?tenantId:/);
});

test('real public endpoint inserts and hands off the affected mixed-pipeline not-listed submission intact', async () => {
  const form = affectedFormFixture();
  const requestSubmissionData = {
    student_email: 'student@example.test',
    student_first_name: 'Test',
    student_last_name: 'Student',
    [LIVE_ORGANISATION_FIELD_ID]: FORM_NOT_LISTED_VALUE,
    [FORM_NOT_LISTED_TEXT_KEY]: {
      [LIVE_ORGANISATION_FIELD_ID]: '  Runtime University  ',
    },
  };
  const db = makePublicSubmissionBoundaryDb(form);
  const capturedProcessingBodies = [];
  const capturedEmailCalls = [];
  const { response, res } = makeResponseRecorder();
  const req = {
    method: 'POST',
    headers: {
      host: 'student-join.test',
      referer: 'https://student-join.test/embed/form/student-join?draft_token=must-not-persist',
    },
    body: {
      form_id: form.id,
      form_name: form.name,
      submission_data: requestSubmissionData,
    },
  };

  await handler(req, res, {
    supabase: db.client,
    tenantData: { id: form.tenant_id, slug: 'student-join', domain: 'student-join.test' },
    internalApiBaseUrl: 'https://internal.example.test',
    sendSubmissionEmailsGuarded: async (options) => {
      capturedEmailCalls.push(options);
      return { success: true, emails: [{ success: true }] };
    },
    fetchImpl: async (_url, options) => {
      capturedProcessingBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        async json() {
          return {
            member_id: 'created-member',
            organization_id: 'created-organization',
          };
        },
      };
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(db.insertedSubmissions.length, 1);
  assert.equal(capturedProcessingBodies.length, 1);
  assert.equal(capturedEmailCalls.length, 1);
  assert.equal(capturedEmailCalls[0].submissionId, 'submission-student-join');
  assert.equal(capturedEmailCalls[0].trigger, 'server');
  assert.equal(capturedEmailCalls[0].baseUrl, 'https://student-join.test');
  assert.equal(capturedEmailCalls[0].diagnostics.surface, 'embed');
  assert.equal(capturedEmailCalls[0].diagnostics.referrer_host, 'student-join.test');
  assert.equal(capturedEmailCalls[0].diagnostics.referrer_route, '/embed/form/:form');
  assert.equal(
    JSON.stringify(capturedEmailCalls[0].diagnostics).includes('draft_token'),
    false,
  );
  const persistedData = db.insertedSubmissions[0].submission_data;
  assert.notDeepEqual(persistedData, requestSubmissionData);
  assert.equal(persistedData[LIVE_ORGANISATION_FIELD_ID], FORM_NOT_LISTED_VALUE);
  assert.equal(
    persistedData[FORM_NOT_LISTED_TEXT_KEY][LIVE_ORGANISATION_FIELD_ID],
    '  Runtime University  ',
  );
  assert.equal(
    persistedData[FORM_NOT_LISTED_LABELS_KEY][LIVE_ORGANISATION_FIELD_ID],
    'Not listed',
  );
  assert.deepEqual(capturedProcessingBodies[0].form_values, persistedData);
  assert.notDeepEqual(capturedProcessingBodies[0].form_values, requestSubmissionData);
  assert.equal(
    capturedProcessingBodies[0].entity_pipelines.organisations[0].mappings[0].target_field,
    'name',
  );
});

test('real public endpoint hands off the affected anonymous listed-organization selection intact', async () => {
  const form = affectedFormFixture();
  const organizationId = '7dc51049-90dc-42cf-9567-2b128321c21c';
  const requestSubmissionData = {
    student_email: 'student@example.test',
    student_first_name: 'Test',
    student_last_name: 'Student',
    [LIVE_ORGANISATION_FIELD_ID]: organizationId,
    [LIVE_ORGANISATION_REGION_SOURCE_ID]: 'London',
    student_org_address_1: '',
    student_org_address_2: '',
  };
  const db = makePublicSubmissionBoundaryDb(form, {
    organization: { id: organizationId, tenant_id: form.tenant_id, name: 'Existing University' },
  });
  const capturedProcessingBodies = [];
  const { response, res } = makeResponseRecorder();

  await handler({
    method: 'POST',
    headers: { host: 'student-join.test' },
    body: {
      form_id: form.id,
      form_name: form.name,
      submission_data: requestSubmissionData,
    },
  }, res, {
    supabase: db.client,
    tenantData: { id: form.tenant_id, slug: 'student-join', domain: 'student-join.test' },
    internalApiBaseUrl: 'https://internal.example.test',
    fetchImpl: async (_url, options) => {
      capturedProcessingBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        async json() {
          return { member_id: 'created-member', organization_id: organizationId };
        },
      };
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(db.deletedSubmissionIds.length, 0);
  assert.equal(
    db.insertedSubmissions[0].submission_data[LIVE_ORGANISATION_FIELD_ID],
    organizationId,
  );
  assert.equal(
    capturedProcessingBodies[0].form_values[LIVE_ORGANISATION_FIELD_ID],
    organizationId,
  );
  assert.equal(
    capturedProcessingBodies[0].form_values[LIVE_ORGANISATION_REGION_SOURCE_ID],
    'London',
  );
  assert.equal(capturedProcessingBodies[0].verified_admin_access, false);
  assert.equal(capturedProcessingBodies[0].verified_submitter_member_id, null);
});

test('embed and standalone browser provenance cannot bypass saved organization eligibility', async (t) => {
  const pendingOrganizationId = '7dc51049-90dc-42cf-9567-2b128321c21c';
  const missingOrganizationId = '95310450-4ddc-4ffc-86ef-5e28f017dc7f';
  const crossTenantOrganizationId = '41652bd5-c04a-4a58-b267-5ea0f8ddd82d';
  const surfaces = [
    {
      name: 'embed',
      referer: 'https://student-join.test/embed/form/student-join',
    },
    {
      name: 'standalone form view',
      referer: 'https://student-join.test/form/student-join',
    },
  ];
  const rejectionCases = [
    {
      name: 'pending organization excluded by the approved saved filter',
      organizationId: pendingOrganizationId,
      organization: {
        id: pendingOrganizationId,
        tenant_id: 'tenant-student-join',
        name: 'Pending University',
        status: 'pending',
      },
    },
    {
      name: 'missing organization',
      organizationId: missingOrganizationId,
      organization: null,
    },
    {
      name: 'cross-tenant organization',
      organizationId: crossTenantOrganizationId,
      organization: {
        id: crossTenantOrganizationId,
        tenant_id: 'another-tenant',
        name: 'Another Tenant University',
        status: 'approved',
      },
    },
  ];

  for (const surface of surfaces) {
    for (const provenanceLocation of ['top-level', 'nested']) {
      for (const rejectionCase of rejectionCases) {
        await t.test(
          `${surface.name}: ${provenanceLocation} provenance rejects ${rejectionCase.name}`,
          async () => {
            const form = affectedFormFixture();
            form.fields.find(field => field.id === LIVE_ORGANISATION_FIELD_ID).org_filter = {
              type: 'core',
              field: 'status',
              values: ['approved'],
            };
            const db = makePublicSubmissionBoundaryDb(form, {
              organization: rejectionCase.organization,
            });
            const processingHandoffs = [];
            const submissionData = {
              student_email: 'student@example.test',
              student_first_name: 'Test',
              student_last_name: 'Student',
              [LIVE_ORGANISATION_FIELD_ID]: rejectionCase.organizationId,
            };
            const forgedProvenance = {
              [LIVE_ORGANISATION_FIELD_ID]: rejectionCase.organizationId,
            };
            const body = {
              form_id: form.id,
              form_name: form.name,
              submission_data: submissionData,
            };
            if (provenanceLocation === 'top-level') {
              body.serverCreatedOrganizations = forgedProvenance;
            } else {
              submissionData.serverCreatedOrganizations = forgedProvenance;
            }
            const { response, res } = makeResponseRecorder();

            await handler({
              method: 'POST',
              headers: {
                host: 'student-join.test',
                referer: surface.referer,
              },
              body,
            }, res, {
              supabase: db.client,
              tenantData: {
                id: form.tenant_id,
                slug: 'student-join',
                domain: 'student-join.test',
              },
              internalApiBaseUrl: 'https://internal.example.test',
              fetchImpl: async (...args) => {
                processingHandoffs.push(args);
                throw new Error('Invalid organization selection reached processing handoff');
              },
            });

            assert.equal(response.statusCode, 400);
            assert.equal(response.body.error, 'Invalid relationship selection');
            assert.equal(db.insertedSubmissions.length, 0);
            assert.equal(processingHandoffs.length, 0);
          },
        );
      }
    }
  }
});

test('cached embed retries invoke the server sender with persisted tenant-scoped answers', async () => {
  const form = {
    ...affectedFormFixture(),
    entity_action: 'none',
    entity_pipelines: { members: [], organisations: [] },
  };
  const existingSubmission = {
    id: 'existing-embedded-submission',
    created_member_id: null,
    created_organization_id: null,
    organization_id: null,
    submission_data: {
      student_email: 'persisted@example.test',
      student_first_name: 'Persisted',
    },
    communication_finalization_state: null,
    processing_notes: [],
  };
  const db = makePublicSubmissionBoundaryDb(form, { existingSubmission });
  const capturedEmailCalls = [];
  const { response, res } = makeResponseRecorder();

  await handler({
    method: 'POST',
    headers: {
      host: 'wrong-tenant.dev.iconn.app',
      referer: 'https://wrong-tenant.dev.iconn.app/embed/form/student-join',
    },
    body: {
      form_id: form.id,
      form_name: form.name,
      tenant: 'attacker-controlled-tenant',
      idempotency_key: 'cached-client-idempotency-key',
      submission_data: {
        student_email: 'persisted@example.test',
        student_first_name: 'Persisted',
      },
    },
  }, res, {
    supabase: db.client,
    tenantData: {
      id: form.tenant_id,
      slug: 'student-join',
      domain: 'student-join.example.test',
    },
    sendSubmissionEmailsGuarded: async (options) => {
      capturedEmailCalls.push(options);
      return { success: true, emails: [{ success: true }] };
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.duplicate, true);
  assert.equal(response.body.id, existingSubmission.id);
  assert.equal(db.insertedSubmissions.length, 0);
  assert.equal(capturedEmailCalls.length, 1);
  assert.equal(capturedEmailCalls[0].trigger, 'server-retry');
  assert.deepEqual(capturedEmailCalls[0].formValues, existingSubmission.submission_data);
  assert.equal(capturedEmailCalls[0].form.tenant_id, form.tenant_id);
  assert.equal(capturedEmailCalls[0].baseUrl, 'https://student-join.dev.iconn.app');
});

test('a public idempotency key cannot recover a row for altered answers', async () => {
  const form = {
    ...affectedFormFixture(),
    entity_action: 'none',
    entity_pipelines: { members: [], organisations: [] },
  };
  const existingSubmission = {
    id: 'existing-idempotency-submission',
    submission_data: { student_email: 'persisted@example.test' },
    communication_finalization_state: null,
    processing_notes: [],
  };
  const db = makePublicSubmissionBoundaryDb(form, { existingSubmission });
  const { response, res } = makeResponseRecorder();

  await handler({
    method: 'POST',
    headers: { host: 'student-join.test' },
    body: {
      form_id: form.id,
      idempotency_key: 'altered-client-idempotency-key',
      submission_data: { student_email: 'changed@example.test' },
    },
  }, res, {
    supabase: db.client,
    tenantData: { id: form.tenant_id, slug: 'student-join', domain: 'student-join.test' },
    sendSubmissionEmailsGuarded: async () => ({ success: true, emails: [] }),
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(db.insertedSubmissions.length, 0);
});

test('public idempotency race winners recheck the submitted payload before replay', async () => {
  const source = await readFile(new URL('./form-submission.js', import.meta.url), 'utf8');
  const raceStart = source.indexOf("if (insertError && insertError.code === '23505' && idemKey)");
  const raceBlock = source.slice(raceStart, raceStart + 1400);
  assert.match(raceBlock, /if \(winner\)/);
  assert.match(raceBlock, /sameIdempotencyAnswers\(/);
  assert.match(source, /anonymousSurveyIdempotency/);
  assert.match(source, /redactIdentityAnswers\(surveyFields, requestedValues \|\| \{\}\)/);
});

test('a duplicate embed request cannot send while original post-processing is pending', async () => {
  const form = {
    ...affectedFormFixture(),
    entity_action: 'none',
    entity_pipelines: { members: [], organisations: [] },
  };
  const existingSubmission = {
    id: 'pending-embedded-submission',
    created_member_id: null,
    created_organization_id: null,
    organization_id: null,
    submission_data: { student_email: 'persisted@example.test' },
    submission_email_state: { status: 'pending', trigger: 'server' },
    communication_finalization_state: null,
    processing_notes: [],
  };
  const db = makePublicSubmissionBoundaryDb(form, { existingSubmission });
  const capturedEmailCalls = [];
  const { response, res } = makeResponseRecorder();

  await handler({
    method: 'POST',
    headers: {
      host: 'student-join.test',
      referer: 'https://student-join.test/embed/form/student-join',
    },
    body: {
      form_id: form.id,
      form_name: form.name,
      idempotency_key: 'pending-client-idempotency-key',
      submission_data: { student_email: 'persisted@example.test' },
    },
  }, res, {
    supabase: db.client,
    tenantData: { id: form.tenant_id, slug: 'student-join', domain: 'student-join.test' },
    sendSubmissionEmailsGuarded: async (options) => {
      capturedEmailCalls.push(options);
      return { success: true, durable: true, emails: [] };
    },
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'SUBMISSION_EMAIL_PENDING');
  assert.equal(capturedEmailCalls.length, 0);
});

test('a retry can promote checkpointed pending email state after a transient ready-state failure', async () => {
  const form = {
    ...affectedFormFixture(),
    entity_action: 'none',
    entity_pipelines: { members: [], organisations: [] },
  };
  const db = makePublicSubmissionBoundaryDb(form, { failReadyOnce: true });
  const capturedEmailCalls = [];
  const request = {
    method: 'POST',
    headers: {
      host: 'student-join.test',
      referer: 'https://student-join.test/embed/form/student-join',
    },
    body: {
      form_id: form.id,
      form_name: form.name,
      idempotency_key: 'ready-retry-idempotency-key',
      submission_data: {
        student_email: 'persisted@example.test',
        student_first_name: 'Persisted',
      },
    },
  };
  const dependencies = {
    supabase: db.client,
    tenantData: { id: form.tenant_id, slug: 'student-join', domain: 'student-join.test' },
    sendSubmissionEmailsGuarded: async (options) => {
      capturedEmailCalls.push(options);
      return { success: true, durable: true, emails: [{ success: true }] };
    },
  };

  const firstRecorder = makeResponseRecorder();
  await handler(request, firstRecorder.res, dependencies);
  assert.equal(firstRecorder.response.statusCode, 503);
  assert.equal(firstRecorder.response.body.code, 'SUBMISSION_EMAIL_PENDING');
  assert.equal(capturedEmailCalls.length, 0);

  const retryRecorder = makeResponseRecorder();
  await handler(request, retryRecorder.res, dependencies);
  assert.equal(retryRecorder.response.statusCode, 200);
  assert.equal(retryRecorder.response.body.duplicate, true);
  assert.equal(capturedEmailCalls.length, 1);
  assert.equal(capturedEmailCalls[0].trigger, 'server-retry');
});

test('a member-pipeline communication failure checkpoints first so a retry sends without rerunning records', async () => {
  const form = affectedFormFixture();
  const db = makePublicSubmissionBoundaryDb(form);
  const processingCalls = [];
  const emailCalls = [];
  let promotionCalls = 0;
  const request = {
    method: 'POST',
    headers: {
      host: 'student-join.test',
      referer: 'https://student-join.test/embed/form/student-join',
    },
    body: {
      form_id: form.id,
      form_name: form.name,
      idempotency_key: 'communication-retry-key',
      submission_data: {
        student_email: 'persisted@example.test',
        student_first_name: 'Persisted',
      },
    },
  };
  const dependencies = {
    supabase: db.client,
    tenantData: { id: form.tenant_id, slug: 'student-join', domain: 'student-join.test' },
    internalApiBaseUrl: 'https://internal.example.test',
    promoteAwaitingMemberCommunicationSnapshot: async () => {
      promotionCalls += 1;
      if (promotionCalls === 1) throw new Error('Temporary communication write failure');
      return { status: 'completed' };
    },
    fetchImpl: async (_url, options) => {
      processingCalls.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        async json() {
          return { member_id: 'created-member', organization_id: 'created-organization' };
        },
      };
    },
    sendSubmissionEmailsGuarded: async (options) => {
      emailCalls.push(options);
      return { success: true, durable: true, emails: [{ success: true }] };
    },
  };

  const firstRecorder = makeResponseRecorder();
  await handler(request, firstRecorder.res, dependencies);
  assert.equal(firstRecorder.response.statusCode, 503);
  assert.equal(firstRecorder.response.body.code, 'COMMUNICATION_FINALIZATION_PENDING');
  assert.ok(db.getSubmissionRow().submission_email_state.post_processing_completed_at);
  assert.equal(processingCalls.length, 1);
  assert.equal(emailCalls.length, 0);

  const retryRecorder = makeResponseRecorder();
  await handler(request, retryRecorder.res, dependencies);
  assert.equal(retryRecorder.response.statusCode, 200);
  assert.equal(processingCalls.length, 1);
  assert.equal(emailCalls.length, 1);
  assert.equal(emailCalls[0].trigger, 'server-retry');
});

test('checkpoint write failure records an actionable terminal email failure', async () => {
  const form = {
    ...affectedFormFixture(),
    entity_action: 'none',
    entity_pipelines: { members: [], organisations: [] },
  };
  const db = makePublicSubmissionBoundaryDb(form, { failCheckpointOnce: true });
  const emailCalls = [];
  const { response, res } = makeResponseRecorder();

  await handler({
    method: 'POST',
    headers: {
      host: 'student-join.test',
      referer: 'https://student-join.test/embed/form/student-join',
    },
    body: {
      form_id: form.id,
      form_name: form.name,
      idempotency_key: 'checkpoint-failure-key',
      submission_data: { student_email: 'persisted@example.test' },
    },
  }, res, {
    supabase: db.client,
    tenantData: { id: form.tenant_id, slug: 'student-join', domain: 'student-join.test' },
    sendSubmissionEmailsGuarded: async (options) => {
      emailCalls.push(options);
      return { success: true, durable: true, emails: [] };
    },
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'SUBMISSION_EMAIL_FAILED');
  assert.equal(response.body.retryable, false);
  assert.equal(emailCalls.length, 0);
  assert.equal(db.getSubmissionRow().submission_email_state.status, 'failed');
  assert.match(
    db.getSubmissionRow().submission_email_state.reason,
    /checkpoint failed/i,
  );
});

test('public endpoint rolls back the affected submission when organization mutation is forbidden', async () => {
  const form = affectedFormFixture();
  const organizationId = '7dc51049-90dc-42cf-9567-2b128321c21c';
  const db = makePublicSubmissionBoundaryDb(form, {
    organization: { id: organizationId, tenant_id: form.tenant_id, name: 'Existing University' },
  });
  const { response, res } = makeResponseRecorder();

  await handler({
    method: 'POST',
    headers: { host: 'student-join.test' },
    body: {
      form_id: form.id,
      form_name: form.name,
      submission_data: {
        student_email: 'student@example.test',
        student_first_name: 'Test',
        student_last_name: 'Student',
        [LIVE_ORGANISATION_FIELD_ID]: organizationId,
        [LIVE_ORGANISATION_REGION_SOURCE_ID]: 'Scotland',
        student_org_address_1: '',
        student_org_address_2: '',
      },
    },
  }, res, {
    supabase: db.client,
    tenantData: { id: form.tenant_id, slug: 'student-join', domain: 'student-join.test' },
    internalApiBaseUrl: 'https://internal.example.test',
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      headers: new Headers({ 'content-type': 'application/json' }),
      async json() {
        return {
          error: 'Updating the selected organization record requires administrator access or verified ownership',
          code: 'STRUCTURED_ACTION_FORBIDDEN',
        };
      },
    }),
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, 'STRUCTURED_ACTION_FORBIDDEN');
  assert.deepEqual(db.deletedSubmissionIds, ['submission-student-join']);
});