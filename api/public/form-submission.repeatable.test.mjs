import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import handler from './form-submission.js';
import { buildPublicFormProcessingPayload } from '../_lib/publicFormProcessingPayload.js';
import {
  FORM_NOT_LISTED_LABELS_KEY,
  FORM_NOT_LISTED_TEXT_KEY,
  FORM_NOT_LISTED_VALUE,
} from '../../shared/formNotListedChoice.js';

const LIVE_ORGANISATION_FIELD_ID = 'field_1787065791684';

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
        mappings: [{
          source_type: 'field',
          source_field_id: organisationField.id,
          target_type: 'core',
          target_field: 'name',
          target_entity: 'organization',
        }],
      }],
    },
    structured_actions: null,
    allow_submitter_email_copy: false,
    prevent_duplicate_email_submission: false,
    is_event_related: false,
    form_type: null,
  };
}

function makePublicSubmissionBoundaryDb(form, { organization = null } = {}) {
  const insertedSubmissions = [];
  const deletedSubmissionIds = [];

  class Query {
    constructor(table) {
      this.table = table;
      this.selected = '';
      this.insertPayload = null;
      this.deleteOperation = false;
      this.filters = [];
    }
    select(columns = '*') { this.selected = columns; return this; }
    insert(payload) {
      this.insertPayload = payload;
      if (this.table === 'form_submission') insertedSubmissions.push(payload);
      return this;
    }
    update() { return this; }
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
        return {
          data: {
            id: 'submission-student-join',
            ...structuredClone(this.insertPayload),
          },
          error: null,
        };
      }
      return { data: null, error: null };
    }
    async maybeSingle() {
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
      return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
    }
  }

  return {
    insertedSubmissions,
    deletedSubmissionIds,
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
  const { response, res } = makeResponseRecorder();
  const req = {
    method: 'POST',
    headers: { host: 'student-join.test' },
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
  assert.equal(capturedProcessingBodies[0].verified_admin_access, false);
  assert.equal(capturedProcessingBodies[0].verified_submitter_member_id, null);
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