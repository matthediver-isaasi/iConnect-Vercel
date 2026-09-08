import assert from 'node:assert/strict';
import test from 'node:test';
import handler from './process-application.js';
import { buildFormProcessingHeaders } from '../_lib/formProcessingAuth.js';
import {
  ORGANIZATION_CORE_FIELD_MAPPINGS,
  resolveOrganizationCoreField,
  resolveOrganizationDropdownAssignment,
  resolvePrimaryOrganizationPipeline,
} from '../_lib/formPrimaryOrganizationPipeline.js';
import {
  FORM_NOT_LISTED_TEXT_KEY,
  FORM_NOT_LISTED_VALUE,
} from '../../shared/formNotListedChoice.js';

const dropdown = {
  id: 'organisation',
  type: 'organisation_dropdown',
  not_listed_choice: { enabled: true, label: 'My organisation is not listed' },
};

function publicPayload(overrides = {}) {
  return {
    fields: [dropdown],
    form_values: {
      organisation: FORM_NOT_LISTED_VALUE,
      [FORM_NOT_LISTED_TEXT_KEY]: { organisation: '  Runtime Organisation Ltd  ' },
    },
    entity_pipelines: {
      organisations: [{
        id: 'org-primary',
        isPrimary: true,
        mappings: [{
          source_type: 'field',
          source_field_id: 'organisation',
          target_type: 'core',
          target_entity: 'organization',
          target_field: 'organisation_name',
        }],
      }],
    },
    ...overrides,
  };
}

function makeSupabase({ form, submission, existingOrganization = null }) {
  const inserts = [];
  const updates = [];
  let insertedOrganization = null;

  class Query {
    constructor(table) {
      this.table = table;
      this.selected = '';
      this.filters = [];
      this.insertPayload = null;
      this.updatePayload = null;
    }
    select(columns = '*') { this.selected = columns; return this; }
    eq(column, value) { this.filters.push(['eq', column, value]); return this; }
    neq(column, value) { this.filters.push(['neq', column, value]); return this; }
    ilike(column, value) { this.filters.push(['ilike', column, value]); return this; }
    in(column, value) { this.filters.push(['in', column, value]); return this; }
    is(column, value) { this.filters.push(['is', column, value]); return this; }
    or(value) { this.filters.push(['or', value]); return this; }
    order() { return this; }
    limit() { return this; }
    insert(payload) {
      this.insertPayload = payload;
      inserts.push({ table: this.table, payload });
      return this;
    }
    update(payload) {
      this.updatePayload = payload;
      updates.push({ table: this.table, payload });
      return this;
    }
    delete() { return this; }
    async maybeSingle() {
      if (this.table === 'form') return { data: this.selected === 'tenant_id' ? { tenant_id: form.tenant_id } : form, error: null };
      if (this.table === 'form_submission') {
        if (this.selected === 'organization_id') return { data: { organization_id: submission.organization_id || null }, error: null };
        return { data: submission, error: null };
      }
      if (this.table === 'organization') {
        const id = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'id')?.[2];
        return { data: existingOrganization?.id === id ? existingOrganization : null, error: null };
      }
      return { data: null, error: null };
    }
    async single() {
      if (this.table === 'organization' && this.insertPayload) {
        insertedOrganization = { id: 'created-organization', ...this.insertPayload };
        return { data: insertedOrganization, error: null };
      }
      if (this.table === 'organization' && insertedOrganization) {
        return { data: insertedOrganization, error: null };
      }
      if (this.table === 'member' && this.insertPayload) {
        return { data: { id: 'created-member', ...this.insertPayload }, error: null };
      }
      return { data: null, error: null };
    }
    then(resolve, reject) {
      let data = [];
      if (this.table === 'organization' && !this.insertPayload && existingOrganization) {
        const id = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'id')?.[2];
        if (id === existingOrganization.id) data = [existingOrganization];
      }
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    }
  }

  return {
    inserts,
    updates,
    client: {
      from(table) { return new Query(table); },
      async rpc() { return { data: null, error: null }; },
    },
  };
}

async function invokeProcessor(payload, {
  existingOrganization = null,
  requestFormValues = payload.form_values,
} = {}) {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'runtime-org-name-test-secret';
  const form = {
    id: 'form-runtime-org',
    tenant_id: 'tenant-runtime-org',
    pages: [],
    visibility_rules: [],
    field_mappings: [],
    application_level: 'organization',
    create_entity_type: 'organization',
    entity_action: 'create',
    member_entity_action: 'none',
    organization_entity_action: 'upsert',
    additional_member_creations: [],
    ...payload,
    fields: payload.fields,
    entity_pipelines: payload.entity_pipelines,
  };
  const submission = {
    id: 'submission-runtime-org',
    form_id: form.id,
    tenant_id: form.tenant_id,
    submission_data: payload.form_values,
    submitted_by_email: null,
    organization_id: null,
    created_member_id: null,
    created_organization_id: null,
    payment_reference: null,
    payment_status: null,
    payment_meta: {},
    processing_notes: [],
  };
  const db = makeSupabase({ form, submission, existingOrganization });
  const ids = {
    tenantId: form.tenant_id,
    formId: form.id,
    submissionId: submission.id,
    verifiedSubmitterMemberId: null,
    verifiedAdminAccess: true,
  };
  const req = {
    method: 'POST',
    headers: buildFormProcessingHeaders(ids),
    body: {
      form_id: form.id,
      submission_id: submission.id,
      tenant_id: form.tenant_id,
      form_values: requestFormValues,
      fields: payload.fields,
      entity_pipelines: payload.entity_pipelines,
      verified_admin_access: true,
    },
  };
  const response = { statusCode: 200, body: null };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(body) { response.body = body; return body; },
  };
  try {
    await handler(req, res, { supabase: db.client });
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
  return { response, inserts: db.inserts, updates: db.updates };
}

test('public endpoint payload resolves nested not-listed text through canonical Organisation Name', async () => {
  const result = await invokeProcessor(publicPayload());
  const insert = result.inserts.find(entry => entry.table === 'organization');
  assert.equal(result.response.statusCode, 200);
  assert.equal(insert?.payload.name, 'Runtime Organisation Ltd');
  assert.equal(resolveOrganizationCoreField('organisation_name'), 'name');
});

test('affected mixed-pipeline form uses persisted not-listed text with its saved core name mapping', async () => {
  const payload = publicPayload({
    fields: [
      { id: 'student_email', type: 'email' },
      { id: 'student_first_name', type: 'text' },
      { id: 'student_last_name', type: 'text' },
      {
        id: 'field_1787065791684',
        type: 'organisation_dropdown',
        not_listed_choice: { enabled: true, label: 'Not listed' },
      },
    ],
    form_values: {
      student_email: 'student@example.test',
      student_first_name: 'Test',
      student_last_name: 'Student',
      field_1787065791684: FORM_NOT_LISTED_VALUE,
      [FORM_NOT_LISTED_TEXT_KEY]: {
        field_1787065791684: '  Runtime University  ',
      },
    },
    application_level: 'member',
    create_entity_type: 'member',
    entity_action: 'create',
    member_entity_action: 'none',
    organization_entity_action: 'none',
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
          source_field_id: 'field_1787065791684',
          target_type: 'core',
          target_field: 'name',
          target_entity: 'organization',
        }],
      }],
    },
  });
  const staleRequestValues = {
    ...payload.form_values,
    [FORM_NOT_LISTED_TEXT_KEY]: {
      field_1787065791684: '   ',
    },
  };
  const result = await invokeProcessor(payload, {
    requestFormValues: staleRequestValues,
  });

  assert.equal(result.response.statusCode, 200);
  assert.equal(
    result.inserts.find(entry => entry.table === 'organization')?.payload.name,
    'Runtime University',
  );
  assert.equal(
    result.inserts.find(entry => entry.table === 'member')?.payload.email,
    'student@example.test',
  );
});

test('listed organization UUID is selected and never written into the name column', async () => {
  const payload = publicPayload();
  const organizationId = '7dc51049-90dc-42cf-9567-2b128321c21c';
  payload.form_values.organisation = organizationId;
  const result = await invokeProcessor(payload, {
    existingOrganization: { id: organizationId, tenant_id: 'tenant-runtime-org', name: 'Existing Org' },
  });
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.response.body.organization_id, organizationId);
  assert.equal(result.inserts.some(entry => entry.table === 'organization'), false);
  const orgUpdate = result.updates.find(entry => entry.table === 'organization');
  assert.notEqual(orgUpdate?.payload?.name, organizationId);
});

test('blank not-listed companion text returns the real MISSING_ORG_NAME validation', async () => {
  const payload = publicPayload();
  payload.form_values[FORM_NOT_LISTED_TEXT_KEY].organisation = '   ';
  const result = await invokeProcessor(payload);
  assert.equal(result.response.statusCode, 400);
  assert.equal(result.response.body.code, 'MISSING_ORG_NAME');
  assert.equal(result.inserts.some(entry => entry.table === 'organization'), false);
});

test('legacy object mappings and legacy primary marker resolve the companion name', async () => {
  const payload = publicPayload();
  payload.entity_pipelines.organisations = [{
    id: 'legacy-org',
    primary: true,
    field_mappings: { organization_name: 'organisation' },
  }];
  const result = await invokeProcessor(payload);
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.inserts.find(entry => entry.table === 'organization')?.payload.name, 'Runtime Organisation Ltd');
});

test('a sole organization pipeline is safely primary without an explicit marker', async () => {
  const payload = publicPayload();
  delete payload.entity_pipelines.organisations[0].isPrimary;
  assert.equal(resolvePrimaryOrganizationPipeline(payload.entity_pipelines.organisations)?.id, 'org-primary');
  const result = await invokeProcessor(payload);
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.inserts.find(entry => entry.table === 'organization')?.payload.name, 'Runtime Organisation Ltd');
});

test('multiple organization pipelines without exactly one primary stay explicit', () => {
  assert.equal(resolvePrimaryOrganizationPipeline([{ id: 'one' }, { id: 'two' }]), null);
  assert.equal(resolvePrimaryOrganizationPipeline([
    { id: 'one', isPrimary: true },
    { id: 'two', is_primary: true },
  ]), null);
  assert.equal(ORGANIZATION_CORE_FIELD_MAPPINGS.website, 'website_url');
});