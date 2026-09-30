import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import handler, {
  buildSubmissionEmailRequestContext,
  certificateInvitationSideEffectRejection,
  certificateInvitationSideEffectValues,
  hasCurrentSetCommit,
} from './form-submission.js';
import { buildPublicFormProcessingPayload } from '../_lib/publicFormProcessingPayload.js';
import { certificateSurveyTokenHash } from '../_lib/certificateSurveyGrants.js';

test('booking invitations reject member/entity/communication pipelines and side-effect data trusts the server booking', () => {
  const form = { entity_pipelines: { members: [{ id: 'member-action' }] } };
  assert.ok(certificateInvitationSideEffectRejection(form, {}, false, null));
  assert.ok(certificateInvitationSideEffectRejection({ entity_pipelines: {} },
    { submitterCopyRequested: true, submitterCopyEmail: 'attacker@example.test' }, false, null));
  assert.ok(certificateInvitationSideEffectRejection({ entity_pipelines: {} },
    { brief_id: 'attacker-brief' }, false, null));
  const version = { fields: [{ id: 'email', type: 'email' }, { id: 'feedback', type: 'text' }] };
  const authoritative = { email: 'booking@example.test', feedback: 'Good session' };
  const forged = { email: 'attacker@example.test', feedback: 'Injected' };
  assert.deepEqual(certificateInvitationSideEffectValues({
    invitation: { grant: {} }, anonymous: false, surveyVersion: version,
    authoritativeData: authoritative, requestedData: forged,
  }), authoritative);
  const anonymous = certificateInvitationSideEffectValues({
    invitation: { grant: {} }, anonymous: true, surveyVersion: version,
    authoritativeData: authoritative, requestedData: forged,
  });
  assert.equal(anonymous.email, undefined);
  assert.equal(anonymous.feedback, 'Good session');
});

function certificateSurveyFixture() {
  const token = 'a'.repeat(43);
  const form = {
    ...affectedFormFixture(), form_type: 'survey', entity_action: 'none',
    require_authentication: true, entity_pipelines: { members: [], organisations: [] },
    survey_settings: { status: 'published', current_version: 1, response_identity: 'identified' },
    fields: [{ id: 'email', type: 'email' },
      { id: 'full_name', label: 'Full name', type: 'text' },
      { id: 'phone', type: 'tel' }, { id: 'feedback', type: 'text' },
      { id: 'rating', type: 'score', label: 'Session rating', score_style: 'stars',
        score_min: 1, score_max: 5, required: true }],
  };
  const assignment = { id: 'assignment-1', form_id: form.id, tenant_id: form.tenant_id,
    event_id: 'event-1', event_type: 'event', status: 'active', token: 'shared-token' };
  const grant = { id: 'entitlement-1', assignment_id: assignment.id, tenant_id: form.tenant_id,
    booking_source: 'standard', booking_id: 'booking-1', recipient_email: 'booking@example.test',
    expires_at: '2099-01-01T00:00:00Z' };
  const credential = { entitlement_id: grant.id, delivery_id: 'delivery-1',
    token_hash: certificateSurveyTokenHash(token), expires_at: grant.expires_at };
  const certificateSurvey = {
    event_survey_assignment: assignment,
    certificate_survey_entitlement: grant,
    certificate_survey_credential: credential,
    attendee_cpd_certificate_delivery: { id: 'delivery-1', tenant_id: form.tenant_id,
      booking_source: 'standard', booking_id: grant.booking_id, status: 'accepted' },
    booking: { id: grant.booking_id, tenant_id: form.tenant_id, event_id: assignment.event_id,
      status: 'confirmed', attendee_email: grant.recipient_email,
      attendee_first_name: 'Booked', attendee_last_name: 'Guest' },
  };
  const version = { id: 'version-1', form_id: form.id, tenant_id: form.tenant_id,
    version_number: 1, fields: form.fields, pages: [], visibility_rules: [],
    survey_settings: form.survey_settings };
  return { token, form, assignment, grant, certificateSurvey, version };
}

test('enhanced anonymous acceptance sends only answer attributes and trusted participation to its RPC', async () => {
  const settings = { status: 'published', current_version: 1,
    response_identity: 'anonymous', anonymous_completion_version: 1 };
  const form = { id: 'anonymous-form', tenant_id: 'tenant-1', name: 'Anonymous feedback',
    form_type: 'survey', is_active: true, allow_save_continue_later: false,
    fields: [{ id: 'rating', type: 'score', score_min: 1, score_max: 5, required: true },
      { id: 'feedback', type: 'text' }], survey_settings: settings };
  const version = { id: 'version-1', fields: form.fields, survey_settings: settings };
  const run = async ({ body = {}, member = null, rpcError = null } = {}) => {
    const db = makePublicSubmissionBoundaryDb(form, {
      surveyVersion: version, certificateSurveyRpcError: rpcError,
    });
    const { response, res } = makeResponseRecorder();
    await handler({ method: 'POST', headers: { host: 'survey.test' },
      body: { form_id: form.id, idempotency_key: 'retry-key-4864',
        source: 'private-member-id', form_name: 'private-name',
        submission_data: { rating: { score: 4, member_id: 'forged' },
          feedback: 'Helpful', unknown_attribute: 'private-value', email: 'forged@example.test' },
        ...body },
    }, res, { supabase: db.client, tenantData: { id: form.tenant_id, slug: 'survey', domain: 'survey.test' },
      getSessionMember: async () => member,
      fetchImpl: async () => { throw new Error('No effects allowed'); },
      sendSubmissionEmailsGuarded: async () => { throw new Error('No emails allowed'); },
    });
    return { db, response };
  };
  const accepted = await run({ member: { id: 'trusted-member', tenant_id: form.tenant_id, email: 'member@example.test' } });
  assert.equal(accepted.response.statusCode, 200);
  assert.equal(accepted.response.body.id, undefined);
  assert.equal(accepted.response.body.completion_recorded, true);
  const [rpc] = accepted.db.certificateSubmissionRpcs;
  assert.equal(rpc.p_member_id, 'trusted-member');
  assert.deepEqual(rpc.p_submission.submission_data, { rating: { score: 4 }, feedback: 'Helpful' });
  assert.equal(rpc.p_submission.idempotency_key, undefined);
  assert.equal(rpc.p_submission.survey_respondent_key, undefined);
  assert.doesNotMatch(JSON.stringify(rpc.p_submission), /trusted-member|member@example|private-|forged/);
  assert.equal(accepted.db.insertedSubmissions.length, 0);
  const publicResponse = await run({ member: { id: 'other-tenant', tenant_id: 'wrong', email: 'forged@example.test' } });
  assert.equal(publicResponse.response.statusCode, 200);
  assert.equal(publicResponse.db.certificateSubmissionRpcs[0].p_member_id, null);
  assert.equal(publicResponse.response.body.completion_recorded, false);
  for (const body of [{ member_id: 'forged' }, { prefill_organization_id: 'forged' },
    { submitterCopyRequested: true }, { resume_token: 'draft' }]) {
    const rejected = await run({ body });
    assert.equal(rejected.response.statusCode, 400);
    assert.equal(rejected.db.certificateSubmissionRpcs.length, 0);
  }
  const invalid = await run({ body: { submission_data: { rating: { score: 99 } } } });
  assert.equal(invalid.response.statusCode, 400);
  assert.equal(invalid.db.certificateSubmissionRpcs.length, 0);
  const failed = await run({ rpcError: { code: 'XX000', message: 'Rollback fixture' } });
  assert.equal(failed.response.statusCode, 500);
  assert.equal(failed.response.body.completion_recorded, undefined);
  const duplicate = await run({ rpcError: { code: '23505' } });
  assert.equal(duplicate.response.statusCode, 409);
});

test('enhanced verified invitations use completion transaction even on a completed entitlement retry', async () => {
  const fixture = certificateSurveyFixture();
  fixture.form.allow_save_continue_later = false;
  fixture.form.fields = fixture.form.fields.filter(field => ['feedback', 'rating'].includes(field.id));
  fixture.form.survey_settings = { ...fixture.form.survey_settings,
    anonymous_completion_version: 1, response_identity: 'anonymous' };
  fixture.version.fields = fixture.form.fields;
  fixture.version.survey_settings = fixture.form.survey_settings;
  fixture.grant.completed_at = '2026-09-01T00:00:00Z';
  const db = makePublicSubmissionBoundaryDb(fixture.form, {
    certificateSurvey: fixture.certificateSurvey, surveyVersion: fixture.version,
  });
  const { response, res } = makeResponseRecorder();
  await handler({ method: 'POST', headers: { host: 'survey.test' }, body: {
    form_id: fixture.form.id, assignment_token: fixture.assignment.token,
    certificate_survey_grant: fixture.token, idempotency_key: 'completed-retry-4864',
    submission_data: { feedback: 'Useful', rating: { score: 4 } },
  } }, res, { supabase: db.client,
    tenantData: { id: fixture.form.tenant_id, slug: 'survey', domain: 'survey.test' },
    getSessionMember: async () => null, getSession: async () => null });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.completion_recorded, true);
  assert.equal(response.body.id, undefined);
  const [rpc] = db.certificateSubmissionRpcs;
  assert.equal(rpc.p_token_hash, certificateSurveyTokenHash(fixture.token));
  assert.equal(rpc.p_member_id, null);
  assert.doesNotMatch(JSON.stringify(rpc.p_submission), /booking@example|entitlement-1|booking-1/);
});

test('guest invitation submission cannot run member pipelines and persists booking identity, never forged email', async () => {
  const { token, form, assignment, grant, certificateSurvey, version } = certificateSurveyFixture();
  const run = async () => {
    const db = makePublicSubmissionBoundaryDb(form, { certificateSurvey, surveyVersion: version });
    const { response, res } = makeResponseRecorder();
    let pipelineCalls = 0; let mailCalls = 0;
    await handler({
      method: 'POST', headers: { host: 'student-join.test' },
      body: { form_id: form.id, form_name: form.name, assignment_token: assignment.token,
        certificate_survey_grant: token, submission_data: {
          email: 'forged@example.test', full_name: 'Forged Person',
          phone: '+441234567890', feedback: 'Good session', rating: { score: 4 },
        } },
    }, res, {
      supabase: db.client, tenantData: { id: form.tenant_id, slug: 'student-join', domain: 'student-join.test' },
      getSessionMember: async () => null, getSession: async () => null,
      fetchImpl: async () => { pipelineCalls++; throw new Error('Pipeline must never run'); },
      sendSubmissionEmailsGuarded: async () => { mailCalls++; throw new Error('Email must never send'); },
    });
    return { db, response, pipelineCalls, mailCalls };
  };
  form.entity_pipelines.members = [{ id: 'forbidden' }];
  const blocked = await run();
  assert.equal(blocked.response.statusCode, 403);
  assert.equal(blocked.db.insertedSubmissions.length, 0);
  form.entity_pipelines.members = [];
  const accepted = await run();
  assert.equal(accepted.response.statusCode, 201);
  assert.equal(Object.hasOwn(accepted.db.insertedSubmissions[0], 'communication_finalization_state'), false);
  assert.equal(Object.hasOwn(accepted.db.certificateSubmissionRpcs[0].p_submission, 'communication_finalization_state'), false);
  assert.equal(accepted.db.insertedSubmissions[0].submission_data.email, grant.recipient_email);
  assert.equal(accepted.db.insertedSubmissions[0].submitted_by_email, grant.recipient_email);
  assert.equal(accepted.pipelineCalls, 0);
  assert.equal(accepted.mailCalls, 0);
  form.survey_settings.response_identity = 'anonymous';
  const anonymous = await run();
  assert.equal(anonymous.response.statusCode, 201);
  assert.equal(Object.hasOwn(anonymous.db.insertedSubmissions[0], 'communication_finalization_state'), false);
  assert.equal(Object.hasOwn(anonymous.db.certificateSubmissionRpcs[0].p_submission, 'communication_finalization_state'), false);
  assert.equal(anonymous.db.insertedSubmissions[0].submitted_by_email, null);
  assert.equal(anonymous.db.insertedSubmissions[0].submission_data.email, undefined);
  assert.equal(anonymous.db.insertedSubmissions[0].submission_data.full_name, undefined);
  assert.equal(anonymous.db.insertedSubmissions[0].submission_data.phone, undefined);
  assert.equal(anonymous.db.insertedSubmissions[0].submission_data.feedback, 'Good session');
  assert.deepEqual(anonymous.db.insertedSubmissions[0].submission_data.rating, { score: 4 });
  const [rpc] = anonymous.db.certificateSubmissionRpcs;
  assert.equal(rpc.p_submission.submission_data.feedback, 'Good session');
  assert.equal(rpc.p_submission.submission_data.rating.score, 4);
  assert.equal(rpc.p_answers.length, 1);
  assert.equal(rpc.p_answers[0].field_id, 'rating');
  assert.equal(rpc.p_answers[0].raw_score, 4);
  assert.doesNotMatch(JSON.stringify(rpc), /booking@example\.test|forged@example\.test|Booked Guest|Forged Person|\+441234567890/);
  assert.ok(rpc.p_answers.every(answer => answer.field_id === 'rating'));
  assert.equal(anonymous.mailCalls, 0);
});

test('ordinary form inserts retain communication finalization state', async () => {
  const form = {
    ...affectedFormFixture(),
    entity_action: 'none',
    entity_pipelines: { members: [], organisations: [] },
  };
  const db = makePublicSubmissionBoundaryDb(form);
  const { response, res } = makeResponseRecorder();
  await handler({
    method: 'POST', headers: { host: 'student-join.test' },
    body: { form_id: form.id, form_name: form.name, submission_data: { student_first_name: 'Student' } },
  }, res, {
    supabase: db.client,
    tenantData: { id: form.tenant_id, slug: 'student-join', domain: 'student-join.test' },
    sendSubmissionEmailsGuarded: async () => ({ success: true, durable: true, emails: [] }),
  });
  assert.equal(response.statusCode, 201);
  assert.equal(db.insertedSubmissions.length, 1);
  assert.equal(Object.hasOwn(db.insertedSubmissions[0], 'communication_finalization_state'), true);
});

test('certificate survey RPC errors classify only exact invitation conflicts and emit redacted diagnostics', async (t) => {
  const secretToken = 'sensitive-grant-token-4846';
  const secretAnswer = 'private-answer-4846';
  const secretDetail = 'raw-database-detail-4846';
  const scenarios = [
    { name: 'nested submission column error', error: {
      code: 'P0001', message: `Disallowed form_submission column: ${secretAnswer}`,
    }, status: 500, reason: 'submission_column_contract' },
    { name: 'nested answer column error', error: {
      code: 'P0001', message: `Disallowed survey_answer column: ${secretAnswer}`,
    }, status: 500, reason: 'answer_column_contract' },
    ...[
      'Certificate survey invitation unavailable',
      'Certificate survey invitation scope or publication changed',
      'Certificate survey booking event changed',
      'Certificate survey booking is no longer confirmed for this recipient',
    ].map(message => ({ name: message, error: { code: 'P0001', message },
      status: 409, reason: 'invitation_conflict' })),
    { name: 'P0001 invitation-like message with added text', error: {
      code: 'P0001', message: `Certificate survey invitation unavailable: ${secretAnswer}`,
    }, status: 500, reason: 'unexpected_validation' },
    { name: 'unrelated unique constraint', error: {
      code: '23505', message: `duplicate key value violates unique constraint ${secretAnswer}`,
    }, status: 500, reason: 'unique_constraint' },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { token, form, assignment, certificateSurvey, version } = certificateSurveyFixture();
      const db = makePublicSubmissionBoundaryDb(form, {
        certificateSurvey, surveyVersion: version,
        certificateSurveyRpcError: {
          ...scenario.error,
          details: `DETAIL: ${secretDetail}; token=${secretToken}`,
          hint: `answer=${secretAnswer}`,
        },
      });
      const { response, res } = makeResponseRecorder();
      const diagnostics = [];
      const originalError = console.error;
      console.error = (...args) => { diagnostics.push(args); };
      try {
        await handler({
          method: 'POST', headers: { host: 'student-join.test' },
          body: { form_id: form.id, form_name: form.name,
            assignment_token: assignment.token, certificate_survey_grant: token,
            submission_data: { feedback: secretAnswer, rating: { score: 4 } } },
        }, res, {
          supabase: db.client,
          tenantData: { id: form.tenant_id, slug: 'student-join', domain: 'student-join.test' },
          getSessionMember: async () => null, getSession: async () => null,
        });
      } finally {
        console.error = originalError;
      }
      assert.equal(db.certificateSubmissionRpcs.length, 1);
      assert.equal(response.statusCode, scenario.status);
      assert.deepEqual(response.body, scenario.status === 409
        ? { error: 'This invitation is no longer available or has already been answered' }
        : { error: 'Failed to save survey response. Please try again.', code: 'SURVEY_SUBMISSION_FAILED' });
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0][0], '[Public Form Submission] Survey RPC failed:');
      assert.deepEqual(diagnostics[0][1], {
        code: scenario.error.code, reason: scenario.reason,
        rpc: 'create_certificate_survey_submission',
        tenantId: form.tenant_id, formId: form.id, assignmentId: assignment.id,
      });
      const publicAndDiagnostic = JSON.stringify({ response: response.body, diagnostics });
      for (const secret of [token, secretToken, secretAnswer, secretDetail, 'details', 'hint']) {
        assert.equal(publicAndDiagnostic.includes(secret), false, `${scenario.name} leaked ${secret}`);
      }
    });
  }
});
import {
  FORM_NOT_LISTED_LABELS_KEY,
  FORM_NOT_LISTED_TEXT_KEY,
  FORM_NOT_LISTED_VALUE,
} from '../../shared/formNotListedChoice.js';
import { buildDepartmentCurrentSetCompatibilityContract } from '../_lib/departmentCurrentSetCompatibility.js';

const LIVE_ORGANISATION_FIELD_ID = 'field_1787065791684';
const LIVE_ORGANISATION_REGION_SOURCE_ID = 'student_org_region';
const LIVE_ORGANISATION_REGION_FIELD_ID = 'organization-region';
const CURRENT_SET_FORM_ID = '8b6f44d3-83f8-449e-9496-b10b1dc28e5f';
const CURRENT_SET_TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const CURRENT_SET_DEPARTMENT_ID = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f';
const CURRENT_SET_MEMBER_ID = '5e07a96c-cda1-4a0b-a6fe-951ffb62142';

// Internal processing signatures are deliberately required by the handler.
// Keep this test-only value stable; production still fails closed when absent.
process.env.SESSION_SECRET ||= 'current-set-test-session-secret';

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
    currentSetConfig = null,
    currentSetLoad = null,
    concurrentWinner = null,
    failReadyOnce = false,
    failCheckpointOnce = false,
    certificateSurvey = null,
    certificateSurveyRpcError = null,
    members = [],
  } = {},
) {
  const insertedSubmissions = [];
  const certificateSubmissionRpcs = [];
  const deletedSubmissionIds = [];
  const queriedTables = [];
  let submissionRow = existingSubmission ? structuredClone(existingSubmission) : null;
  let readyFailuresRemaining = failReadyOnce ? 1 : 0;
  let checkpointFailuresRemaining = failCheckpointOnce ? 1 : 0;

  class Query {
    constructor(table) {
      this.table = table;
      queriedTables.push(table);
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
    ilike(column, value) { this.filters.push(['ilike', column, value]); return this; }
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
        if (concurrentWinner) {
          submissionRow = structuredClone(concurrentWinner);
          return {
            data: null,
            error: {
              code: '23505',
              message: 'duplicate key value violates unique constraint form_submission_idempotency_key_idx',
            },
          };
        }
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
      if (certificateSurvey?.[this.table]) {
        return { data: structuredClone(certificateSurvey[this.table]), error: null };
      }
      if (this.table === 'department_current_set_config') {
        return { data: currentSetConfig ? { config: structuredClone(currentSetConfig) } : null, error: null };
      }
      if (this.table === 'form') return { data: form, error: null };
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
        const idempotencyKey = this.filters.find(
          filter => filter[0] === 'eq' && filter[1] === 'idempotency_key',
        )?.[2];
        if (idempotencyKey && submissionRow.idempotency_key !== undefined
          && submissionRow.idempotency_key !== idempotencyKey) {
          return { data: null, error: null };
        }
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
      if (this.table === 'member') {
        const matches = members.filter(member => this.filters.every(([op, column, value]) =>
          op === 'eq' ? member[column] === value
            : String(member[column] || '').toLowerCase() === String(value).toLowerCase()));
        return Promise.resolve({ data: matches, error: null }).then(resolve, reject);
      }
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
    certificateSubmissionRpcs,
    deletedSubmissionIds,
    queriedTables,
    getSubmissionRow() { return structuredClone(submissionRow); },
    client: {
      from(table) { return new Query(table); },
      async rpc(name, parameters) {
        if (name === 'accept_anonymous_survey_completion') {
          certificateSubmissionRpcs.push(structuredClone(parameters));
          return { data: { accepted: true, replayed: false }, error: certificateSurveyRpcError };
        }
        if (name === 'create_certificate_survey_submission' && certificateSurvey) {
          certificateSubmissionRpcs.push(structuredClone(parameters));
          if (certificateSurveyRpcError) {
            return { data: null, error: certificateSurveyRpcError };
          }
          insertedSubmissions.push(parameters.p_submission);
          submissionRow = { id: 'certificate-survey-response', ...structuredClone(parameters.p_submission) };
          return { data: [structuredClone(submissionRow)], error: null };
        }
        if (name === 'department_current_set_load_authenticated') {
          return { data: structuredClone(currentSetLoad), error: null };
        }
        return { data: null, error: null };
      },
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

function currentSetConfigFixture() {
  const config = {
    workforce_container_field_id: 'workforce',
    equipment_container_field_id: 'equipment',
    workforce_fields: {},
    equipment_fields: { serial: 'serial_number', installed: 'year_installed' },
    required_blank_policy: {
      existing_equipment_blank_required_field_ids: ['serial', 'installed'],
      new_equipment_required_field_ids: ['serial', 'installed'],
    },
    equipment_hidden_preserve: {},
  };
  return {
    ...config,
    form_compatibility: buildDepartmentCurrentSetCompatibilityContract({
      form: currentSetFormFixture(),
      configuration: config,
    }),
  };
}

function currentSetFormFixture() {
  return {
    ...affectedFormFixture(),
    id: CURRENT_SET_FORM_ID,
    tenant_id: CURRENT_SET_TENANT_ID,
    require_authentication: true,
    entity_action: 'none',
    member_entity_action: 'none',
    organization_entity_action: 'none',
    entity_pipelines: { members: [], organisations: [] },
    fields: [{
      id: 'workforce', type: 'repeatable_rows', min_rows: 0, max_rows: 20,
      first_row_required: false, child_fields: [{ id: 'workforce_note', type: 'text' }],
    }, {
      id: 'equipment', type: 'repeatable_rows', min_rows: 0, max_rows: 100,
      first_row_required: false, child_fields: [
        { id: 'serial', type: 'text', required: true },
        { id: 'installed', type: 'date', required: true, date_precision: 'year' },
      ],
    }],
  };
}

function currentSetAnswers(version = 'department-version-1') {
  return {
    workforce: [],
    equipment: [],
    __department_current_set: {
      department_id: CURRENT_SET_DEPARTMENT_ID,
      version,
      complete_sections: ['workforce', 'equipment'],
    },
  };
}

function currentSetLoadFixture(version = 'department-version-1') {
  return {
    version,
    department_id: CURRENT_SET_DEPARTMENT_ID,
    complete_sections: ['workforce', 'equipment'],
    form_values: currentSetAnswers(version),
  };
}

function jsonProcessingResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    async json() { return body; },
  };
}

test('public member signup slug admission allows fresh/owner but rejects forged, draft, and continuation before writes', async () => {
  for (const scenario of [
    { name: 'fresh anonymous', email: 'new@example.test', status: 201 },
    { name: 'existing anonymous', email: 'owner@example.test', status: 403 },
    { name: 'verified owner', email: 'owner@example.test', session: true, status: 201 },
    { name: 'forged other identity', email: 'other@example.test', session: true, status: 403 },
    { name: 'draft cannot confer authority', email: 'owner@example.test', resume_token: 'forged-draft', status: 403 },
    { name: 'continuation cannot confer authority', email: 'owner@example.test', applicant_continuation_token: 'forged-grant', status: 403 },
    { name: 'organisation prefill cannot confer authority', email: 'new@example.test', prefill_organization_id: 'org-1', status: 403 },
    { name: 'selected organisation remains a reference', email: 'new@example.test',
      prefill_organization_id: 'org-1', selectedOrganization: true, status: 201 },
    { name: 'owner organisation remains a reference', email: 'owner@example.test',
      prefill_organization_id: 'org-1', session: true, sessionOrganization: true, status: 201 },
  ]) {
    const form = {
      ...affectedFormFixture(),
      mutation_access_policy: { version: 1, mode: 'public_member_signup' },
      entity_pipelines: {
        members: affectedFormFixture().entity_pipelines.members,
        organisations: [],
      },
    };
    const db = makePublicSubmissionBoundaryDb(form, {
      organization: { id: 'org-1', tenant_id: form.tenant_id },
      members: [
      { id: 'member-owner', tenant_id: form.tenant_id, email: 'owner@example.test' },
      { id: 'member-other', tenant_id: form.tenant_id, email: 'other@example.test' },
      ],
    });
    const { response, res } = makeResponseRecorder();
    let processed = 0;
    await handler({
      method: 'POST', headers: { host: 'student-join.test' },
      body: { form_id: form.id, form_name: form.name,
        submission_data: { student_email: scenario.email, student_first_name: 'New',
          ...(scenario.selectedOrganization && { [LIVE_ORGANISATION_FIELD_ID]: 'org-1' }) },
        ...(scenario.resume_token && { resume_token: scenario.resume_token }),
        ...(scenario.applicant_continuation_token && { applicant_continuation_token: scenario.applicant_continuation_token }),
        ...(scenario.prefill_organization_id && { prefill_organization_id: scenario.prefill_organization_id }),
      },
    }, res, {
      supabase: db.client, tenantData: { id: form.tenant_id, slug: 'student-join', domain: 'student-join.test' },
      getSessionMember: async () => scenario.session
        ? { id: 'member-owner', tenant_id: form.tenant_id, email: 'owner@example.test',
          ...(scenario.sessionOrganization && { organization_id: 'org-1' }) } : null,
      internalApiBaseUrl: 'https://internal.example.test',
      fetchImpl: async () => { processed++; return jsonProcessingResponse(200, { member_id: 'member-owner' }); },
    });
    assert.equal(response.statusCode, scenario.status, scenario.name);
    if (scenario.status === 403) {
      assert.equal(response.body.code, 'FORM_MEMBER_OWNER_REQUIRED', scenario.name);
      assert.equal(db.insertedSubmissions.length, 0, scenario.name);
      assert.equal(processed, 0, scenario.name);
    }
  }
});

test('ordinary submissions load persisted visibility context for repeatable validation', async () => {
  const source = await readFile(new URL('./form-submission.js', import.meta.url), 'utf8');
  assert.match(source, /\.select\('[^']*\bfields, pages, visibility_rules\b[^']*'\)/);
  assert.match(source, /const hiddenRelationshipFieldIds = await computeAuthoritativeHiddenFieldIds\(/);
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

test('Department current-set submissions are authenticated, preflighted, and processed without generic pipelines', async () => {
  const source = await readFile(new URL('./form-submission.js', import.meta.url), 'utf8');
  const preflight = source.indexOf('assertCurrentSetFormValues({');
  const insert = source.indexOf('.insert(finalSubmissionRecord)');
  assert.ok(preflight > -1, 'current-set metadata is validated');
  assert.ok(preflight < insert, 'current-set authorization/preflight occurs before submission persistence');
  assert.match(source, /const isAuthedCurrentSet = hasCurrentSetProcessing && hasTenantSession/);
  assert.match(source, /if \(\(hasEntityPipelines \|\| hasCurrentSetProcessing\) && !surveyIsAnonymous\)/);
  assert.match(source, /hasCurrentSetCommit\(result\)/);
});

test('current-set retries retain the durable submission and replay processing before success', async () => {
  const source = await readFile(new URL('./form-submission.js', import.meta.url), 'utf8');
  assert.match(source, /if \(hasCurrentSetProcessing \|\| applicantGrant\) \{[\s\S]*?retry processing failed/);
  assert.match(source, /if \(!hasCurrentSetProcessing && !applicantGrant\) \{[\s\S]*?delete\(\)\.eq\('id', submission\.id\)/);
  assert.match(source, /!hasCurrentSetProcessing && form\.prevent_duplicate_email_submission/);
});

test('current-set form reports success only after the processor returns a durable commit marker', async () => {
  const form = currentSetFormFixture();
  const db = makePublicSubmissionBoundaryDb(form, {
    currentSetConfig: currentSetConfigFixture(),
    currentSetLoad: currentSetLoadFixture(),
  });
  const processingBodies = [];
  const { response, res } = makeResponseRecorder();
  await handler({
    method: 'POST',
    headers: { host: 'bnms.test' },
    body: {
      form_id: form.id,
      idempotency_key: 'current-set-commit-key',
      submission_data: currentSetAnswers(),
    },
  }, res, {
    supabase: db.client,
    tenantData: { id: CURRENT_SET_TENANT_ID, slug: 'bnms', domain: 'bnms.test' },
    internalApiBaseUrl: 'https://internal.example.test',
    getSessionMember: async () => ({ id: CURRENT_SET_MEMBER_ID, tenant_id: CURRENT_SET_TENANT_ID }),
    getActiveSession: async () => ({ id: 'current-set-session', data: { memberId: CURRENT_SET_MEMBER_ID } }),
    fetchImpl: async (_url, options) => {
      processingBodies.push(JSON.parse(options.body));
      return jsonProcessingResponse(200, {
        success: true,
        current_set: { status: 'committed', version: 'department-version-1' },
      });
    },
    sendSubmissionEmailsGuarded: async () => ({ success: true, durable: true, emails: [] }),
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.success, true);
  assert.deepEqual(response.body.current_set, {
    status: 'committed',
    version: 'department-version-1',
  });
  assert.equal(processingBodies.length, 1);
  assert.equal(processingBodies[0].submission_id, 'submission-student-join');
  assert.equal(db.insertedSubmissions[0].created_member_id, CURRENT_SET_MEMBER_ID);
  assert.equal(db.insertedSubmissions[0].processing_notes[0].status, 'pending');

  assert.equal(hasCurrentSetCommit({ success: true }), false);
  assert.equal(hasCurrentSetCommit({ current_set: { status: 'committed' } }), false);
  assert.equal(hasCurrentSetCommit({
    current_set: { status: 'committed', version: 'department-version-1' },
  }), true);
});

test('current-set processing without a verified commit marker remains retryable and never reports success', async () => {
  const form = currentSetFormFixture();
  const db = makePublicSubmissionBoundaryDb(form, {
    currentSetConfig: currentSetConfigFixture(),
    currentSetLoad: currentSetLoadFixture(),
  });
  const { response, res } = makeResponseRecorder();
  await handler({
    method: 'POST',
    headers: { host: 'bnms.test' },
    body: {
      form_id: form.id,
      idempotency_key: 'current-set-missing-marker-key',
      submission_data: currentSetAnswers(),
    },
  }, res, {
    supabase: db.client,
    tenantData: { id: CURRENT_SET_TENANT_ID, slug: 'bnms', domain: 'bnms.test' },
    internalApiBaseUrl: 'https://internal.example.test',
    getSessionMember: async () => ({ id: CURRENT_SET_MEMBER_ID, tenant_id: CURRENT_SET_TENANT_ID }),
    getActiveSession: async () => ({ id: 'current-set-session', data: { memberId: CURRENT_SET_MEMBER_ID } }),
    fetchImpl: async () => jsonProcessingResponse(200, { success: true }),
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.success, false);
  assert.equal(response.body.code, 'CURRENT_SET_PROCESSING_PENDING');
  assert.equal(response.body.current_set, undefined);
});

for (const failure of [
  { status: 409, code: 'CURRENT_SET_CONFLICT', error: 'Current Department data changed' },
  { status: 503, code: 'CURRENT_SET_UNAVAILABLE', error: 'Department save date could not be stored' },
]) {
test(`failed current-set processing (${failure.code}) preserves its durable submission without confirming a save`, async () => {
  const form = currentSetFormFixture();
  const db = makePublicSubmissionBoundaryDb(form, {
    currentSetConfig: currentSetConfigFixture(),
    currentSetLoad: currentSetLoadFixture(),
  });
  const { response, res } = makeResponseRecorder();
  await handler({
    method: 'POST',
    headers: { host: 'bnms.test' },
    body: {
      form_id: form.id,
      idempotency_key: 'current-set-conflict-key',
      submission_data: currentSetAnswers(),
    },
  }, res, {
    supabase: db.client,
    tenantData: { id: CURRENT_SET_TENANT_ID, slug: 'bnms', domain: 'bnms.test' },
    internalApiBaseUrl: 'https://internal.example.test',
    getSessionMember: async () => ({ id: CURRENT_SET_MEMBER_ID, tenant_id: CURRENT_SET_TENANT_ID }),
    getActiveSession: async () => ({ id: 'current-set-session', data: { memberId: CURRENT_SET_MEMBER_ID } }),
    fetchImpl: async () => jsonProcessingResponse(failure.status, {
      error: failure.error,
      code: failure.code,
    }),
    sendSubmissionEmailsGuarded: async () => ({ success: true, durable: true, emails: [] }),
  });
  assert.equal(response.statusCode, failure.status);
  assert.equal(response.body.code, failure.code);
  assert.notEqual(response.body.success, true);
  assert.equal(response.body.current_set, undefined);
  assert.equal(hasCurrentSetCommit(response.body), false);
  assert.equal(db.deletedSubmissionIds.length, 0);
  assert.equal(db.insertedSubmissions.length, 1);
});
}

test('a committed current-set submission replays before an idempotent duplicate is acknowledged', async () => {
  const form = currentSetFormFixture();
  const existingSubmission = {
    id: 'current-set-existing-submission',
    idempotency_key: 'current-set-replay-key',
    submission_data: currentSetAnswers(),
    communication_finalization_state: null,
    processing_notes: [],
  };
  const db = makePublicSubmissionBoundaryDb(form, {
    currentSetConfig: currentSetConfigFixture(),
    currentSetLoad: currentSetLoadFixture(),
    existingSubmission,
  });
  const { response, res } = makeResponseRecorder();
  let calls = 0;
  await handler({
    method: 'POST',
    headers: { host: 'bnms.test' },
    body: {
      form_id: form.id,
      idempotency_key: 'current-set-replay-key',
      submission_data: currentSetAnswers(),
    },
  }, res, {
    supabase: db.client,
    tenantData: { id: CURRENT_SET_TENANT_ID, slug: 'bnms', domain: 'bnms.test' },
    internalApiBaseUrl: 'https://internal.example.test',
    getSessionMember: async () => ({ id: CURRENT_SET_MEMBER_ID, tenant_id: CURRENT_SET_TENANT_ID }),
    getActiveSession: async () => ({ id: 'current-set-session', data: { memberId: CURRENT_SET_MEMBER_ID } }),
    fetchImpl: async () => {
      calls += 1;
      return jsonProcessingResponse(200, {
        success: true,
        current_set: { status: 'replayed', version: 'department-version-1' },
      });
    },
    sendSubmissionEmailsGuarded: async () => ({ success: true, durable: true, emails: [] }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.duplicate, true);
  assert.deepEqual(response.body.current_set, {
    status: 'replayed',
    version: 'department-version-1',
  });
  assert.equal(calls, 1);
  assert.equal(db.insertedSubmissions.length, 0);
});

test('a current-set idempotency key cannot replay a saved row for altered answers', async () => {
  const form = currentSetFormFixture();
  const existingSubmission = {
    id: 'current-set-existing-submission',
    idempotency_key: 'current-set-altered-key',
    submission_data: currentSetAnswers(),
    communication_finalization_state: null,
    processing_notes: [],
  };
  const db = makePublicSubmissionBoundaryDb(form, {
    currentSetConfig: currentSetConfigFixture(),
    currentSetLoad: currentSetLoadFixture(),
    existingSubmission,
  });
  const altered = currentSetAnswers();
  altered.equipment = [{ _row_id: 'forged-row', serial: 'changed', installed: '2025' }];
  const { response, res } = makeResponseRecorder();
  let processingCalls = 0;
  await handler({
    method: 'POST',
    headers: { host: 'bnms.test' },
    body: {
      form_id: form.id,
      idempotency_key: existingSubmission.idempotency_key,
      submission_data: altered,
    },
  }, res, {
    supabase: db.client,
    tenantData: { id: CURRENT_SET_TENANT_ID, slug: 'bnms', domain: 'bnms.test' },
    getSessionMember: async () => ({ id: CURRENT_SET_MEMBER_ID, tenant_id: CURRENT_SET_TENANT_ID }),
    getActiveSession: async () => ({ id: 'current-set-session', data: { memberId: CURRENT_SET_MEMBER_ID } }),
    fetchImpl: async () => {
      processingCalls += 1;
      return jsonProcessingResponse(200, {
        current_set: { status: 'replayed', version: 'department-version-1' },
      });
    },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(processingCalls, 0);
  assert.equal(db.insertedSubmissions.length, 0);
});

test('a concurrent current-set idempotency winner is authenticated, replayed, and returns only its verified commit marker', async () => {
  const form = currentSetFormFixture();
  const winner = {
    id: 'current-set-race-winner',
    idempotency_key: 'current-set-race-key',
    submission_data: currentSetAnswers(),
    communication_finalization_state: null,
    processing_notes: [{
      // Processing notes are deliberately not response authority.
      kind: 'department_current_set_commit',
      status: 'committed',
      version: 'untrusted-note-version',
    }],
  };
  const db = makePublicSubmissionBoundaryDb(form, {
    currentSetConfig: currentSetConfigFixture(),
    currentSetLoad: currentSetLoadFixture(),
    concurrentWinner: winner,
  });
  const { response, res } = makeResponseRecorder();
  let processingCalls = 0;
  await handler({
    method: 'POST',
    headers: { host: 'bnms.test' },
    body: {
      form_id: form.id,
      idempotency_key: winner.idempotency_key,
      submission_data: currentSetAnswers(),
    },
  }, res, {
    supabase: db.client,
    tenantData: { id: CURRENT_SET_TENANT_ID, slug: 'bnms', domain: 'bnms.test' },
    internalApiBaseUrl: 'https://internal.example.test',
    getSessionMember: async () => ({ id: CURRENT_SET_MEMBER_ID, tenant_id: CURRENT_SET_TENANT_ID }),
    getActiveSession: async () => ({ id: 'current-set-session', data: { memberId: CURRENT_SET_MEMBER_ID } }),
    fetchImpl: async () => {
      processingCalls += 1;
      return jsonProcessingResponse(200, {
        current_set: { status: 'replayed', version: 'verified-race-version' },
      });
    },
    sendSubmissionEmailsGuarded: async () => ({ success: true, durable: true, emails: [] }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.duplicate, true);
  assert.deepEqual(response.body.current_set, {
    status: 'replayed',
    version: 'verified-race-version',
  });
  assert.equal(JSON.stringify(response.body).includes('untrusted-note-version'), false);
  assert.equal(processingCalls, 1);
});

test('a revoked respondent cannot replay a pending current-set submission', async () => {
  const form = currentSetFormFixture();
  const existingSubmission = {
    id: 'current-set-pending-submission',
    idempotency_key: 'current-set-revoked-key',
    submission_data: currentSetAnswers(),
    communication_finalization_state: null,
    processing_notes: [],
  };
  const db = makePublicSubmissionBoundaryDb(form, {
    currentSetConfig: currentSetConfigFixture(),
    currentSetLoad: currentSetLoadFixture(),
    existingSubmission,
  });
  const { response, res } = makeResponseRecorder();
  let fetchCalls = 0;
  await handler({
    method: 'POST',
    headers: { host: 'bnms.test' },
    body: {
      form_id: form.id,
      idempotency_key: 'current-set-revoked-key',
      submission_data: currentSetAnswers(),
    },
  }, res, {
    supabase: db.client,
    tenantData: { id: CURRENT_SET_TENANT_ID, slug: 'bnms', domain: 'bnms.test' },
    getSessionMember: async () => null,
    getActiveSession: async () => null,
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonProcessingResponse(200, { success: true });
    },
    sendSubmissionEmailsGuarded: async () => ({ success: true, durable: true, emails: [] }),
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'CURRENT_SET_AUTHENTICATION_REQUIRED');
  assert.equal(fetchCalls, 0);
});

test('current-set users can make separate normal edits and forged metadata on other forms does not invoke reconciliation', async () => {
  const form = currentSetFormFixture();
  const db = makePublicSubmissionBoundaryDb(form, {
    currentSetConfig: currentSetConfigFixture(),
    currentSetLoad: currentSetLoadFixture(),
  });
  const dependencies = {
    supabase: db.client,
    tenantData: { id: CURRENT_SET_TENANT_ID, slug: 'bnms', domain: 'bnms.test' },
    internalApiBaseUrl: 'https://internal.example.test',
    getSessionMember: async () => ({ id: CURRENT_SET_MEMBER_ID, tenant_id: CURRENT_SET_TENANT_ID }),
    getActiveSession: async () => ({ id: 'current-set-session', data: { memberId: CURRENT_SET_MEMBER_ID } }),
    fetchImpl: async () => jsonProcessingResponse(200, {
      success: true,
      current_set: { status: 'committed', version: 'department-version-1' },
    }),
    sendSubmissionEmailsGuarded: async () => ({ success: true, durable: true, emails: [] }),
  };
  for (const key of ['current-set-first-edit', 'current-set-second-edit']) {
    const recorder = makeResponseRecorder();
    await handler({
      method: 'POST', headers: { host: 'bnms.test' },
      body: { form_id: form.id, idempotency_key: key, submission_data: currentSetAnswers() },
    }, recorder.res, dependencies);
    assert.equal(recorder.response.statusCode, 201);
  }
  assert.equal(db.insertedSubmissions.length, 2);

  const ordinaryForm = { ...affectedFormFixture(), entity_action: 'none', entity_pipelines: { members: [], organisations: [] } };
  const ordinaryDb = makePublicSubmissionBoundaryDb(ordinaryForm);
  const ordinaryRecorder = makeResponseRecorder();
  let forgedFetches = 0;
  await handler({
    method: 'POST', headers: { host: 'student-join.test' },
    body: {
      form_id: ordinaryForm.id,
      submission_data: {
        student_email: 'student@example.test',
        __department_current_set: currentSetAnswers().__department_current_set,
      },
    },
  }, ordinaryRecorder.res, {
    supabase: ordinaryDb.client,
    tenantData: { id: ordinaryForm.tenant_id, slug: 'student-join', domain: 'student-join.test' },
    fetchImpl: async () => { forgedFetches += 1; return jsonProcessingResponse(200, { success: true }); },
    sendSubmissionEmailsGuarded: async () => ({ success: true, durable: true, emails: [] }),
  });
  assert.equal(ordinaryRecorder.response.statusCode, 201);
  assert.equal(forgedFetches, 0);
  assert.equal(ordinaryDb.queriedTables.includes('department_current_set_config'), false);
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

function repeatableDateForm(children, overrides = {}) {
  return {
    ...affectedFormFixture(),
    id: 'repeatable-date-form',
    name: 'Repeatable date form',
    entity_action: 'none',
    entity_pipelines: { members: [], organisations: [] },
    fields: [{
      id: 'dates',
      type: 'repeatable_rows',
      min_rows: 1,
      max_rows: 3,
      children,
    }],
    ...overrides,
  };
}

async function postRepeatableDate(form, submissionData, options = {}) {
  const db = makePublicSubmissionBoundaryDb(form, options);
  const { response, res } = makeResponseRecorder();
  await handler({
    method: 'POST',
    headers: { host: 'student-join.test' },
    body: {
      form_id: form.id,
      form_name: form.name,
      ...options.body,
      submission_data: submissionData,
    },
  }, res, {
    supabase: db.client,
    tenantData: { id: form.tenant_id, slug: 'student-join', domain: 'student-join.test' },
    sendSubmissionEmailsGuarded: async () => ({ success: true, emails: [] }),
  });
  return { response, db };
}

test('normal endpoint validates row visibility from raw rows but persists hidden cells unchanged', async () => {
  const form = repeatableDateForm([
    { id: 'mode', type: 'select', options: ['show', 'hide'], required: true },
    {
      id: 'organisation',
      type: 'organisation_dropdown',
      required: true,
      unique_across_rows: true,
      row_visibility: { mode: 'show_when', source_field_id: 'mode', value: 'show' },
    },
    {
      id: 'date',
      type: 'date',
      required: true,
      future_only: true,
      row_visibility: { mode: 'show_when', source_field_id: 'mode', value: 'show' },
    },
  ]);
  const hiddenRows = [
    { _row_id: 'row-1', mode: 'hide', organisation: 'forged-duplicate', date: '2000-01-01' },
    { _row_id: 'row-2', mode: 'hide', organisation: 'forged-duplicate', date: '2000-01-01' },
  ];
  const accepted = await postRepeatableDate(form, { dates: hiddenRows });
  assert.equal(accepted.response.statusCode, 201);
  // The endpoint stores the raw response for later show/hide restoration; the
  // effective view is reserved for validation and downstream side effects.
  assert.deepEqual(accepted.db.insertedSubmissions[0].submission_data.dates, hiddenRows);

  const rejected = await postRepeatableDate(form, {
    dates: [{ _row_id: 'visible', mode: 'show', date: '2999-01-01' }],
  });
  assert.equal(rejected.response.statusCode, 400);
  assert.equal(rejected.response.body.code, 'required_child');
  assert.equal(rejected.db.insertedSubmissions.length, 0);
});

test('normal endpoint skips row-hidden forged group and group-dependent organisation values', async () => {
  const form = repeatableDateForm([{
    id: 'mode',
    type: 'select',
    options: ['show', 'hide'],
  }, {
    id: 'group',
    type: 'organisation_group_dropdown',
    row_visibility: { mode: 'show_when', source_field_id: 'mode', value: 'show' },
  }, {
    id: 'organisation',
    type: 'organisation_dropdown',
    organisation_group_parent_field_id: 'group',
    row_visibility: { mode: 'show_when', source_field_id: 'mode', value: 'show' },
  }]);
  const { response, db } = await postRepeatableDate(form, {
    dates: [{
      _row_id: 'hidden-group-row',
      mode: 'hide',
      group: 'forged-hidden-group',
      organisation: 'forged-hidden-organisation',
    }],
  });
  assert.equal(response.statusCode, 201);
  assert.equal(db.insertedSubmissions.length, 1);
});

test('normal endpoint preserves hidden repeatable Not-listed country answers but rejects visible missing text', async () => {
  const form = repeatableDateForm([
    { id: 'mode', type: 'select', options: ['show', 'hide'] },
    {
      id: 'country',
      type: 'countries',
      not_listed_choice: { enabled: true, label: 'Country not listed' },
      row_visibility: { mode: 'show_when', source_field_id: 'mode', value: 'show' },
    },
  ]);
  const acceptedRows = [
    { _row_id: 'absent-companion', mode: 'hide', country: FORM_NOT_LISTED_VALUE },
    {
      _row_id: 'stale-companion',
      mode: 'hide',
      country: FORM_NOT_LISTED_VALUE,
      __not_listed_choice_text: { country: 'Stale hidden country text' },
      __not_listed_choice_labels: { country: 'Stale hidden country label' },
    },
  ];
  const accepted = await postRepeatableDate(form, { dates: acceptedRows });
  assert.equal(accepted.response.statusCode, 201);
  assert.deepEqual(accepted.db.insertedSubmissions[0].submission_data.dates, acceptedRows);

  const rejected = await postRepeatableDate(form, {
    dates: [{ _row_id: 'visible-missing-text', mode: 'show', country: FORM_NOT_LISTED_VALUE }],
  });
  assert.equal(rejected.response.statusCode, 400);
  assert.match(rejected.response.body.error, /Invalid relationship selection/);
});

test('public submission accepts each repeatable date precision and unrestricted/future/past policy', async () => {
  const cases = [
    ['day-any', { id: 'answer', type: 'date', date_precision: 'day', date_restriction: 'any' }, '2024-02-29'],
    ['month-any', { id: 'answer', type: 'date', date_precision: 'month', date_restriction: 'any' }, '2024-02'],
    ['year-any', { id: 'answer', type: 'date', date_precision: 'year', date_restriction: 'any' }, '2024'],
    ['day-future', { id: 'answer', type: 'date', date_precision: 'day', date_restriction: 'future' }, '2099-02-01'],
    ['month-future', { id: 'answer', type: 'date', date_precision: 'month', date_restriction: 'future' }, '2099-02'],
    ['year-future', { id: 'answer', type: 'date', date_precision: 'year', date_restriction: 'future' }, '2099'],
    ['day-past', { id: 'answer', type: 'date', date_precision: 'day', date_restriction: 'past' }, '2001-02-01'],
    ['month-past', { id: 'answer', type: 'date', date_precision: 'month', date_restriction: 'past' }, '2001-02'],
    ['year-past', { id: 'answer', type: 'date', date_precision: 'year', date_restriction: 'past' }, '2001'],
  ];
  for (const [name, child, value] of cases) {
    const form = repeatableDateForm([child]);
    const { response, db } = await postRepeatableDate(form, {
      dates: [{ _row_id: 'row-1', answer: value }],
    });
    assert.equal(response.statusCode, 201, name);
    assert.equal(db.insertedSubmissions.length, 1, name);
    assert.equal(db.insertedSubmissions[0].submission_data.dates[0].answer, value, name);
  }
});

test('public submission accepts current UTC past-only periods and rejects later periods for canonical and legacy settings', async (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2024-02-29T23:59:59.999Z'),
  });
  const cases = [
    {
      precision: 'day',
      current: '2024-02-29',
      later: '2024-03-01',
      message: 'Date must be today or earlier (UTC).',
    },
    {
      precision: 'month',
      current: '2024-02',
      later: '2024-03',
      message: 'Month must be the current month or earlier (UTC).',
    },
    {
      precision: 'year',
      current: '2024',
      later: '2025',
      message: 'Year must be the current year or earlier (UTC).',
    },
  ];

  for (const legacy of [false, true]) {
    for (const { precision, current, later, message } of cases) {
      const field = {
        id: 'answer',
        type: 'date',
        date_precision: precision,
        ...(legacy ? { past_only: true } : { date_restriction: 'past' }),
      };
      const form = repeatableDateForm([field]);
      const accepted = await postRepeatableDate(form, {
        dates: [{ _row_id: 'row-current', answer: current }],
      });
      assert.equal(accepted.response.statusCode, 201, `${legacy ? 'legacy/' : ''}${precision} current`);
      assert.equal(accepted.db.insertedSubmissions.length, 1, `${legacy ? 'legacy/' : ''}${precision} current`);

      const rejected = await postRepeatableDate(form, {
        dates: [{ _row_id: 'row-later', answer: later }],
      });
      assert.equal(rejected.response.statusCode, 400, `${legacy ? 'legacy/' : ''}${precision} later`);
      assert.equal(rejected.response.body.code, 'FUTURE_DATE_INVALID');
      assert.deepEqual(rejected.response.body.details[0], {
        field_id: 'dates',
        child_id: 'answer',
        row: 0,
        message,
      });
      assert.equal(rejected.db.insertedSubmissions.length, 0, `${legacy ? 'legacy/' : ''}${precision} later`);
    }
  }
});

test('public submission rejects malformed repeatable partial dates before persistence', async () => {
  const cases = [
    [{ id: 'answer', type: 'date', date_precision: 'day', date_restriction: 'any' }, '2024-02'],
    [{ id: 'answer', type: 'date', date_precision: 'month', date_restriction: 'any' }, '2024-02-29'],
    [{ id: 'answer', type: 'date', date_precision: 'year', date_restriction: 'any' }, '2024-01'],
    [{ id: 'answer', type: 'date', date_precision: 'month', date_restriction: 'any' }, '2024-13'],
  ];
  for (const [child, value] of cases) {
    const form = repeatableDateForm([child]);
    const { response, db } = await postRepeatableDate(form, {
      dates: [{ _row_id: 'row-1', answer: value }],
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.code, 'FUTURE_DATE_INVALID');
    assert.equal(response.body.details[0].child_id, 'answer');
    assert.equal(db.insertedSubmissions.length, 0);
  }
});

test('public submission ignores invalid repeatable dates in hidden containers', async () => {
  const form = repeatableDateForm([{
    id: 'answer',
    type: 'date',
    date_precision: 'day',
    date_restriction: 'future',
  }]);
  form.fields[0].starts_hidden = true;
  const { response, db } = await postRepeatableDate(form, {
    dates: [{ _row_id: 'row-1', answer: '2001-01-01' }],
  });
  assert.equal(response.statusCode, 201);
  assert.equal(db.insertedSubmissions.length, 1);
});

test('public idempotent retry returns an accepted repeatable future answer after UTC boundary without revalidation', async () => {
  const form = repeatableDateForm([{
    id: 'answer',
    type: 'date',
    date_precision: 'month',
    date_restriction: 'future',
  }]);
  const values = { dates: [{ _row_id: 'row-1', answer: '2001-01' }] };
  const db = makePublicSubmissionBoundaryDb(form, {
    existingSubmission: {
      id: 'accepted-repeatable-date',
      idempotency_key: 'accepted-repeatable-date-key',
      submission_data: values,
      submission_email_state: { status: 'sent' },
      communication_finalization_state: { status: 'completed' },
      processing_notes: [],
    },
  });
  const { response, res } = makeResponseRecorder();
  await handler({
    method: 'POST',
    headers: { host: 'student-join.test' },
    body: {
      form_id: form.id,
      idempotency_key: 'accepted-repeatable-date-key',
      submission_data: values,
    },
  }, res, {
    supabase: db.client,
    tenantData: { id: form.tenant_id, slug: 'student-join', domain: 'student-join.test' },
    sendSubmissionEmailsGuarded: async () => ({ success: true, emails: [] }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.duplicate, true);
  assert.equal(response.body.id, 'accepted-repeatable-date');
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
    'let prefill_organization_id = normalizeFormPrefillOrganizationId(requestedPrefillOrganizationId)',
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