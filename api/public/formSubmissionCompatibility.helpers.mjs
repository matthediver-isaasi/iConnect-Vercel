import publicSubmissionHandler from './form-submission.js';
import {
  applicantConfigurationDigest,
  hashApplicantToken,
} from '../_lib/formApplicantContinuation.js';

const { invokeProcessor } = await import('../forms/processApplicationOrganizationName.test.mjs');

export const TENANT_ID = 'tenant-runtime-org';
export const FORM_ID = 'form-runtime-org';
export const SUBMISSION_ID = 'submission-runtime-org';

export function compatibilityForm({ legacy = false, mutatePhone = false, hidden = false } = {}) {
  const fields = [{
    id: 'organisation',
    type: 'organisation_dropdown',
    starts_hidden: hidden,
    not_listed_choice: { enabled: true, label: 'Not listed' },
  }];
  const mappings = [{
    id: 'organization-name',
    source_type: 'field',
    source_field_id: 'organisation',
    target_type: 'core',
    target_entity: 'organization',
    target_field: legacy ? 'organisation_name' : 'name',
    ...(hidden ? { ignore_if_hidden: true } : {}),
  }];
  if (mutatePhone) {
    fields.push({ id: 'org_phone', type: 'text' });
    mappings.push({
      id: 'organization-phone',
      source_type: 'field',
      source_field_id: 'org_phone',
      target_type: 'core',
      target_entity: 'organization',
      target_field: 'phone',
    });
  }
  return {
    id: FORM_ID,
    name: legacy ? 'Legacy organization form' : 'Current organization form',
    tenant_id: TENANT_ID,
    require_authentication: false,
    access_policy: null,
    fields,
    pages: [],
    visibility_rules: [],
    field_mappings: [],
    application_level: 'organization',
    create_entity_type: 'organization',
    entity_action: legacy ? 'create' : 'none',
    member_entity_action: 'none',
    organization_entity_action: 'upsert',
    additional_member_creations: [],
    entity_pipelines: {
      members: [],
      organisations: [{
        id: 'organization-primary',
        isPrimary: true,
        mappings,
      }],
    },
    structured_actions: null,
    allow_submitter_email_copy: false,
    prevent_duplicate_email_submission: false,
    is_event_related: false,
    form_type: null,
  };
}

function makeBoundaryDatabase(form, organization = null, {
  continuationGrant = null,
  draft = null,
} = {}) {
  const insertedSubmissions = [];
  const deletedSubmissionIds = [];
  let submission = null;

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.insertPayload = null;
      this.updatePayload = null;
      this.deleteRequested = false;
    }
    select() { return this; }
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
    contains(column, value) { this.filters.push(['contains', column, value]); return this; }
    order() { return this; }
    limit() { return this; }
    range() { return this; }
    insert(payload) {
      this.insertPayload = payload;
      if (this.table === 'form_submission') insertedSubmissions.push(payload);
      return this;
    }
    update(payload) { this.updatePayload = payload; return this; }
    delete() { this.deleteRequested = true; return this; }
    async single() {
      if (this.table === 'form') return { data: structuredClone(form), error: null };
      if (this.table === 'form_submission' && this.insertPayload) {
        submission = { id: SUBMISSION_ID, ...structuredClone(this.insertPayload) };
        return { data: structuredClone(submission), error: null };
      }
      return { data: null, error: null };
    }
    async maybeSingle() {
      if (this.table === 'form') return { data: structuredClone(form), error: null };
      if (this.table === 'organization') {
        const id = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'id')?.[2];
        const tenantId = this.filters.find(
          filter => filter[0] === 'eq' && filter[1] === 'tenant_id',
        )?.[2];
        if (organization?.id === id && organization?.tenant_id === tenantId) {
          return { data: structuredClone(organization), error: null };
        }
      }
      if (this.table === 'form_applicant_continuation') {
        const tokenHash = this.filters.find(
          filter => filter[0] === 'eq' && filter[1] === 'token_hash',
        )?.[2];
        const grantId = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'id')?.[2];
        const submissionId = this.filters.find(
          filter => filter[0] === 'eq' && filter[1] === 'submission_id',
        )?.[2];
        const requiredDraftHashes = this.filters.find(
          filter => filter[0] === 'contains' && filter[1] === 'draft_token_hashes',
        )?.[2];
        const matches = continuationGrant
          && (!tokenHash || continuationGrant.token_hash === tokenHash)
          && (!grantId || continuationGrant.id === grantId)
          && (!submissionId || continuationGrant.submission_id === submissionId)
          && (!requiredDraftHashes || requiredDraftHashes.every(
            hash => continuationGrant.draft_token_hashes?.includes(hash),
          ));
        return { data: matches ? structuredClone(continuationGrant) : null, error: null };
      }
      if (this.table === 'form_draft_submission') {
        const resumeHash = this.filters.find(
          filter => filter[0] === 'eq' && filter[1] === 'resume_token_hash',
        )?.[2];
        return {
          data: draft?.resume_token_hash === resumeHash ? structuredClone(draft) : null,
          error: null,
        };
      }
      if (this.table === 'form_submission' && submission) {
        return { data: submission, error: null };
      }
      return { data: null, error: null };
    }
    then(resolve, reject) {
      if (this.table === 'form_submission' && this.deleteRequested && submission) {
        deletedSubmissionIds.push(submission.id);
        submission = null;
      }
      if (this.table === 'form_submission' && this.updatePayload && submission) {
        submission = { ...submission, ...structuredClone(this.updatePayload) };
        return Promise.resolve({ data: [{ id: submission.id }], error: null }).then(resolve, reject);
      }
      return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
    }
  }

  return {
    insertedSubmissions,
    deletedSubmissionIds,
    patchSubmission(patch) {
      if (submission) Object.assign(submission, structuredClone(patch));
    },
    client: {
      from(table) { return new Query(table); },
      async rpc(name, args) {
        if (name === 'bind_form_applicant_continuation') {
          if (!continuationGrant || continuationGrant.id !== args.p_grant_id
            || (continuationGrant.submission_id
              && continuationGrant.submission_id !== args.p_submission_id)) {
            return { data: false, error: null };
          }
          continuationGrant.submission_id = args.p_submission_id;
          continuationGrant.bound_at = new Date().toISOString();
          return { data: true, error: null };
        }
        return { data: null, error: null };
      },
    },
  };
}

function responseRecorder() {
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

function processorResponse(result) {
  return {
    ok: result.response.statusCode >= 200 && result.response.statusCode < 300,
    status: result.response.statusCode,
    headers: new Headers({ 'content-type': 'application/json' }),
    async json() { return result.response.body; },
  };
}

export async function submitThroughRealProcessor({
  form,
  submissionData,
  sessionMember = null,
  adminTenantId = null,
  processorOptions = {},
  tamperProcessorBody = null,
  applicantContinuationToken = null,
  resumeToken = null,
  continuationGrant = null,
  draft = null,
  prefillOrganizationId = null,
  idempotencyKey = null,
  attempts = 1,
  failProcessorOnce = false,
}) {
  const boundary = makeBoundaryDatabase(form, processorOptions.existingOrganization, {
    continuationGrant,
    draft,
  });
  const recorder = responseRecorder();
  const handoffs = [];
  const processorResults = [];
  let processorFailuresRemaining = failProcessorOnce ? 1 : 0;
  let emailInvocations = 0;
  let emailDeliveries = 0;

  const request = {
    method: 'POST',
    headers: { host: 'compatibility.test' },
    body: {
      form_id: form.id,
      form_name: form.name,
      submission_data: submissionData,
      applicant_continuation_token: applicantContinuationToken,
      resume_token: resumeToken,
      prefill_organization_id: prefillOrganizationId,
      idempotency_key: idempotencyKey,
    },
  };
  const dependencies = {
    supabase: boundary.client,
    tenantData: { id: form.tenant_id, slug: 'compatibility', domain: 'compatibility.test' },
    publicBaseUrl: 'https://compatibility.test',
    internalApiBaseUrl: 'https://processor.invalid',
    getSessionMember: async () => sessionMember,
    getTenantContext: async () => adminTenantId ? { tenantId: adminTenantId } : null,
    hasAdminAccess: async () => !!adminTenantId,
    sendSubmissionEmailsGuarded: async () => {
      emailInvocations += 1;
      if (emailDeliveries === 0) {
        emailDeliveries += 1;
        return { success: true, durable: true, emails: [{ status: 'sent' }] };
      }
      return { success: true, durable: true, skipped: true, emails: [] };
    },
    promoteAwaitingMemberCommunicationSnapshot: async () => ({ status: 'completed' }),
    fetchImpl: async (_url, options) => {
      const handoff = JSON.parse(options.body);
      handoffs.push(handoff);
      if (processorFailuresRemaining > 0) {
        processorFailuresRemaining -= 1;
        return {
          ok: false,
          status: 503,
          headers: new Headers({ 'content-type': 'application/json' }),
          async json() { return { error: 'Injected processor outage' }; },
        };
      }
      const payload = {
        ...form,
        ...handoff,
        id: handoff.form_id,
        fields: handoff.fields,
        form_values: handoff.form_values,
        entity_pipelines: handoff.entity_pipelines,
      };
      const overrides = tamperProcessorBody?.(structuredClone(handoff)) || {};
      const completed = processorResults.at(-1)?.response?.body;
      const result = await invokeProcessor(payload, {
        ...processorOptions,
        applicantContinuationGrant: continuationGrant,
        ...(completed?.success ? {
          persistedCreatedMemberId: completed.created_member_id || completed.member_id || null,
          persistedCreatedOrganizationId:
            completed.created_organization_id || completed.organization_id || null,
          entityProcessingCompletedAt: new Date().toISOString(),
        } : {}),
        submitterMember: processorOptions.submitterMember ?? sessionMember,
        verifiedAdminAccess: handoff.verified_admin_access,
        requestBodyOverrides: overrides,
      });
      processorResults.push(result);
      for (const update of result.updates.filter(({ table }) => table === 'form_submission')) {
        boundary.patchSubmission(update.payload);
      }
      return processorResponse(result);
    },
  };
  const responses = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const attemptRecorder = attempt === 0 ? recorder : responseRecorder();
    await publicSubmissionHandler(request, attemptRecorder.res, dependencies);
    responses.push(attemptRecorder.response);
  }

  return {
    response: recorder.response,
    responses,
    handoffs,
    processorResults,
    insertedSubmissions: boundary.insertedSubmissions,
    deletedSubmissionIds: boundary.deletedSubmissionIds,
    emailInvocations,
    emailDeliveries,
  };
}

export function makeContinuationGrant({
  form,
  token = 'A'.repeat(43),
  organizationId,
  overrides = {},
}) {
  return {
    id: 'compatibility-continuation-grant',
    tenant_id: form.tenant_id,
    form_id: form.id,
    organization_id: organizationId,
    token_hash: hashApplicantToken(token),
    configuration_digest: applicantConfigurationDigest(form),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    revoked_at: null,
    submission_id: null,
    draft_token_hashes: [],
    ...overrides,
  };
}

export async function invokePersistedContinuation({
  form,
  submissionData,
  grant,
  processorOptions = {},
}) {
  return invokeProcessor({
    ...form,
    id: form.id,
    form_id: form.id,
    tenant_id: form.tenant_id,
    form_values: submissionData,
    fields: form.fields,
    entity_pipelines: form.entity_pipelines,
  }, {
    ...processorOptions,
    applicantContinuationGrant: grant,
    verifiedAdminAccess: false,
  });
}