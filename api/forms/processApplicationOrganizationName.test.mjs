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

function makeSupabase({
  form,
  submission,
  existingOrganization = null,
  submitterMember = null,
  preferenceFields = [],
  organizationPreferenceValues = [],
  pipelineEntityLinks = [],
  idempotencyLookupError = null,
}) {
  const inserts = [];
  const updates = [];
  const deletes = [];
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
    upsert(payload) {
      this.insertPayload = payload;
      inserts.push({ table: this.table, payload });
      return this;
    }
    update(payload) {
      this.updatePayload = payload;
      updates.push({ table: this.table, payload });
      return this;
    }
    delete() { deletes.push({ table: this.table, filters: this.filters }); return this; }
    async maybeSingle() {
      if (this.table === 'form') return { data: this.selected === 'tenant_id' ? { tenant_id: form.tenant_id } : form, error: null };
      if (this.table === 'form_submission') {
        if (
          idempotencyLookupError
          && this.selected === 'created_member_id, created_organization_id, entity_processing_completed_at'
        ) {
          return { data: null, error: idempotencyLookupError };
        }
        if (this.selected === 'organization_id') return { data: { organization_id: submission.organization_id || null }, error: null };
        return { data: submission, error: null };
      }
      if (this.table === 'organization') {
        const id = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'id')?.[2];
        const name = this.filters.find(filter => filter[0] === 'ilike' && filter[1] === 'name')?.[2];
        const matchesId = id && existingOrganization?.id === id;
        const matchesName = name && existingOrganization?.name?.toLowerCase() === String(name).toLowerCase();
        return { data: matchesId || matchesName ? existingOrganization : null, error: null };
      }
      if (this.table === 'member') {
        const id = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'id')?.[2];
        return { data: submitterMember?.id === id ? submitterMember : null, error: null };
      }
      return { data: null, error: null };
    }
    async single() {
      if (this.table === 'organization' && this.insertPayload) {
        insertedOrganization = { id: 'created-organization', ...this.insertPayload };
        return { data: insertedOrganization, error: null };
      }
      if (this.table === 'organization' && existingOrganization) {
        const id = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'id')?.[2];
        if (id === existingOrganization.id) {
          return { data: existingOrganization, error: null };
        }
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
      if (this.table === 'preference_field') data = preferenceFields;
      if (this.table === 'form_submission_pipeline_entity') data = pipelineEntityLinks;
      if (this.table === 'organization_preference_value') {
        const organizationId = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'organization_id')?.[2];
        const fieldIds = this.filters.find(filter => filter[0] === 'in' && filter[1] === 'field_id')?.[2];
        data = organizationPreferenceValues.filter(row => (
          row.organization_id === organizationId
          && (!fieldIds || fieldIds.includes(row.field_id))
        ));
      }
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
    deletes,
    client: {
      from(table) { return new Query(table); },
      async rpc() { return { data: null, error: null }; },
    },
  };
}

async function invokeProcessor(payload, {
  existingOrganization = null,
  requestFormValues = payload.form_values,
  verifiedAdminAccess = true,
  submitterMember = null,
  preferenceFields = [],
  organizationPreferenceValues = [],
  pipelineEntityLinks = [],
  persistedCreatedOrganizationId = null,
  idempotencyLookupError = null,
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
    submitted_by_email: submitterMember?.email || null,
    organization_id: null,
    created_member_id: null,
    created_organization_id: persistedCreatedOrganizationId,
    payment_reference: null,
    payment_status: null,
    payment_meta: {},
    processing_notes: [],
  };
  const db = makeSupabase({
    form,
    submission,
    existingOrganization,
    submitterMember,
    preferenceFields,
    organizationPreferenceValues,
    pipelineEntityLinks,
    idempotencyLookupError,
  });
  const ids = {
    tenantId: form.tenant_id,
    formId: form.id,
    submissionId: submission.id,
    verifiedSubmitterMemberId: submitterMember?.id || null,
    verifiedAdminAccess,
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
      verified_submitter_member_id: submitterMember?.id || null,
      verified_admin_access: verifiedAdminAccess,
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
  return { response, inserts: db.inserts, updates: db.updates, deletes: db.deletes };
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

test('anonymous affected-form selection links a new member without mutating the existing organization', async () => {
  const regionFieldId = 'organization-region';
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
      { id: 'org_region', type: 'select' },
      { id: 'org_address_1', type: 'text' },
      { id: 'org_address_2', type: 'text' },
    ],
    form_values: {
      student_email: 'student@example.test',
      student_first_name: 'Test',
      student_last_name: 'Student',
      field_1787065791684: '7dc51049-90dc-42cf-9567-2b128321c21c',
      org_region: 'London',
      org_address_1: '',
      org_address_2: '',
    },
    application_level: 'member',
    create_entity_type: 'member',
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
        mappings: [
          {
            source_type: 'field',
            source_field_id: 'field_1787065791684',
            target_type: 'core',
            target_field: 'name',
            target_entity: 'organization',
          },
          {
            source_type: 'field',
            source_field_id: 'org_region',
            target_type: 'custom',
            target_field: regionFieldId,
            target_entity: 'organization',
          },
          {
            source_type: 'field',
            source_field_id: 'org_address_1',
            target_type: 'core',
            target_field: 'address',
            target_entity: 'organization',
          },
          {
            source_type: 'field',
            source_field_id: 'org_address_2',
            target_type: 'core',
            target_field: 'invoicing_address',
            target_entity: 'organization',
          },
        ],
      }],
    },
  });
  const organizationId = payload.form_values.field_1787065791684;
  const result = await invokeProcessor(payload, {
    existingOrganization: { id: organizationId, tenant_id: 'tenant-runtime-org', name: 'Existing University' },
    verifiedAdminAccess: false,
    preferenceFields: [{ id: regionFieldId, entity_scope: 'organization', field_type: 'select' }],
    organizationPreferenceValues: [{
      id: 'saved-region',
      organization_id: organizationId,
      field_id: regionFieldId,
      value: 'London',
    }],
  });

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.response.body.organization_id, organizationId);
  assert.equal(result.inserts.some(entry => entry.table === 'organization'), false);
  assert.equal(result.updates.some(entry => entry.table === 'organization'), false);
  assert.equal(result.updates.some(entry => entry.table === 'organization_preference_value'), false);
  assert.equal(result.inserts.some(entry => entry.table === 'organization_preference_value'), false);
  assert.equal(result.deletes.some(entry => entry.table === 'organization_preference_value'), false);
  assert.equal(
    result.inserts.find(entry => entry.table === 'member')?.payload.organization_id,
    organizationId,
  );
});

test('anonymous selection cannot mutate an existing organization core field', async () => {
  const payload = publicPayload();
  const organizationId = '7dc51049-90dc-42cf-9567-2b128321c21c';
  payload.fields.push({ id: 'org_phone', type: 'text' });
  payload.form_values.organisation = organizationId;
  payload.form_values.org_phone = '020 0000 0000';
  payload.entity_pipelines.organisations[0].mappings.push({
    source_type: 'field',
    source_field_id: 'org_phone',
    target_type: 'core',
    target_entity: 'organization',
    target_field: 'phone',
  });

  const result = await invokeProcessor(payload, {
    existingOrganization: { id: organizationId, tenant_id: 'tenant-runtime-org', name: 'Existing Org' },
    verifiedAdminAccess: false,
  });

  assert.equal(result.response.statusCode, 403);
  assert.equal(result.response.body.code, 'STRUCTURED_ACTION_FORBIDDEN');
  assert.equal(result.updates.some(entry => entry.table === 'organization'), false);
});

test('anonymous selection skips an unchanged existing organization core field', async () => {
  const payload = publicPayload();
  const organizationId = '7dc51049-90dc-42cf-9567-2b128321c21c';
  payload.fields.push({ id: 'org_phone', type: 'text' });
  payload.form_values.organisation = organizationId;
  payload.form_values.org_phone = '020 0000 0000';
  payload.entity_pipelines.organisations[0].mappings.push({
    source_type: 'field',
    source_field_id: 'org_phone',
    target_type: 'core',
    target_entity: 'organization',
    target_field: 'phone',
  });

  const result = await invokeProcessor(payload, {
    existingOrganization: {
      id: organizationId,
      tenant_id: 'tenant-runtime-org',
      name: 'Existing Org',
      phone: '020 0000 0000',
    },
    verifiedAdminAccess: false,
  });

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.updates.some(entry => entry.table === 'organization'), false);
});

test('anonymous Student join cannot change the authoritative organization Region', async () => {
  const payload = publicPayload();
  const organizationId = '7dc51049-90dc-42cf-9567-2b128321c21c';
  const regionFieldId = 'organization-region';
  payload.fields.push({ id: 'org_region', type: 'select' });
  payload.form_values.organisation = organizationId;
  payload.form_values.org_region = 'Scotland';
  payload.entity_pipelines.organisations[0].mappings.push({
    source_type: 'field',
    source_field_id: 'org_region',
    target_type: 'custom',
    target_entity: 'organization',
    target_field: regionFieldId,
  });

  const result = await invokeProcessor(payload, {
    existingOrganization: { id: organizationId, tenant_id: 'tenant-runtime-org', name: 'Existing University' },
    verifiedAdminAccess: false,
    preferenceFields: [{ id: regionFieldId, entity_scope: 'organization', field_type: 'select' }],
    organizationPreferenceValues: [{
      id: 'saved-region',
      organization_id: organizationId,
      field_id: regionFieldId,
      value: 'London',
    }],
  });

  assert.equal(result.response.statusCode, 403);
  assert.equal(result.response.body.code, 'STRUCTURED_ACTION_FORBIDDEN');
  assert.equal(result.updates.some(entry => entry.table === 'organization_preference_value'), false);
});

test('anonymous clear of an already-absent organization custom field is a no-op', async () => {
  const payload = publicPayload();
  const organizationId = '7dc51049-90dc-42cf-9567-2b128321c21c';
  const fieldId = 'organization-custom-field';
  payload.fields.push({ id: 'clear_org_value', type: 'text' });
  payload.form_values.organisation = organizationId;
  payload.form_values.clear_org_value = '';
  payload.entity_pipelines.organisations[0].mappings.push({
    source_type: 'field',
    source_field_id: 'clear_org_value',
    target_type: 'custom',
    target_entity: 'organization',
    target_field: fieldId,
  });

  const result = await invokeProcessor(payload, {
    existingOrganization: { id: organizationId, tenant_id: 'tenant-runtime-org', name: 'Existing Org' },
    verifiedAdminAccess: false,
    preferenceFields: [{ id: fieldId, entity_scope: 'organization', field_type: 'text' }],
  });

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.deletes.some(entry => entry.table === 'organization_preference_value'), false);
});

test('an existing-organization checkpoint cannot authorize anonymous core mutation on retry', async () => {
  const payload = publicPayload();
  const organizationId = '7dc51049-90dc-42cf-9567-2b128321c21c';
  payload.fields.push({ id: 'org_phone', type: 'text' });
  payload.form_values.organisation = organizationId;
  payload.form_values.org_phone = '020 0000 0000';
  payload.entity_pipelines.organisations[0].mappings.push({
    source_type: 'field',
    source_field_id: 'org_phone',
    target_type: 'core',
    target_entity: 'organization',
    target_field: 'phone',
  });

  const result = await invokeProcessor(payload, {
    existingOrganization: { id: organizationId, tenant_id: 'tenant-runtime-org', name: 'Existing Org' },
    verifiedAdminAccess: false,
    pipelineEntityLinks: [{
      pipeline_id: 'org-primary',
      entity_type: 'organization',
      entity_id: organizationId,
    }],
  });

  assert.equal(result.response.statusCode, 403);
  assert.equal(result.response.body.code, 'STRUCTURED_ACTION_FORBIDDEN');
  assert.equal(result.updates.some(entry => entry.table === 'organization'), false);
});

test('a referenced created_organization_id cannot authorize anonymous mutation when retry lookup fails open', async () => {
  const payload = publicPayload();
  const organizationId = '7dc51049-90dc-42cf-9567-2b128321c21c';
  payload.fields.push({ id: 'org_phone', type: 'text' });
  payload.form_values.organisation = organizationId;
  payload.form_values.org_phone = '020 0000 0000';
  payload.entity_pipelines.organisations[0].mappings.push({
    source_type: 'field',
    source_field_id: 'org_phone',
    target_type: 'core',
    target_entity: 'organization',
    target_field: 'phone',
  });

  const result = await invokeProcessor(payload, {
    existingOrganization: { id: organizationId, tenant_id: 'tenant-runtime-org', name: 'Existing Org' },
    verifiedAdminAccess: false,
    persistedCreatedOrganizationId: organizationId,
    idempotencyLookupError: { code: 'TEST_LOOKUP_FAILURE', message: 'simulated retry lookup failure' },
  });

  assert.equal(result.response.statusCode, 403);
  assert.equal(result.response.body.code, 'STRUCTURED_ACTION_FORBIDDEN');
  assert.equal(result.updates.some(entry => entry.table === 'organization'), false);
});

test('administrator retains existing organization update behavior', async () => {
  const payload = publicPayload();
  const organizationId = '7dc51049-90dc-42cf-9567-2b128321c21c';
  payload.fields.push({ id: 'org_phone', type: 'text' });
  payload.form_values.organisation = organizationId;
  payload.form_values.org_phone = '020 0000 0000';
  payload.entity_pipelines.organisations[0].mappings.push({
    source_type: 'field',
    source_field_id: 'org_phone',
    target_type: 'core',
    target_entity: 'organization',
    target_field: 'phone',
  });

  const result = await invokeProcessor(payload, {
    existingOrganization: { id: organizationId, tenant_id: 'tenant-runtime-org', name: 'Existing Org' },
    verifiedAdminAccess: true,
  });

  assert.equal(result.response.statusCode, 200);
  assert.equal(
    result.updates.find(entry => entry.table === 'organization')?.payload.phone,
    '020 0000 0000',
  );
});

test('verified organization owner retains existing organization update behavior', async () => {
  const payload = publicPayload();
  const organizationId = '7dc51049-90dc-42cf-9567-2b128321c21c';
  payload.fields.push({ id: 'org_phone', type: 'text' });
  payload.form_values.organisation = organizationId;
  payload.form_values.org_phone = '020 0000 0000';
  payload.entity_pipelines.organisations[0].mappings.push({
    source_type: 'field',
    source_field_id: 'org_phone',
    target_type: 'core',
    target_entity: 'organization',
    target_field: 'phone',
  });

  const result = await invokeProcessor(payload, {
    existingOrganization: { id: organizationId, tenant_id: 'tenant-runtime-org', name: 'Existing Org' },
    verifiedAdminAccess: false,
    submitterMember: {
      id: 'verified-owner',
      tenant_id: 'tenant-runtime-org',
      email: 'owner@example.test',
      organization_id: organizationId,
    },
  });

  assert.equal(result.response.statusCode, 200);
  assert.equal(
    result.updates.find(entry => entry.table === 'organization')?.payload.phone,
    '020 0000 0000',
  );
});

test('anonymous selection cannot clear an existing organization custom field', async () => {
  const payload = publicPayload();
  const organizationId = '7dc51049-90dc-42cf-9567-2b128321c21c';
  const fieldId = 'organization-custom-field';
  payload.fields.push({ id: 'clear_org_value', type: 'text' });
  payload.form_values.organisation = organizationId;
  payload.form_values.clear_org_value = '';
  payload.entity_pipelines.organisations[0].mappings.push({
    source_type: 'field',
    source_field_id: 'clear_org_value',
    target_type: 'custom',
    target_entity: 'organization',
    target_field: fieldId,
  });

  const result = await invokeProcessor(payload, {
    existingOrganization: { id: organizationId, tenant_id: 'tenant-runtime-org', name: 'Existing Org' },
    verifiedAdminAccess: false,
    preferenceFields: [{ id: fieldId, entity_scope: 'organization', field_type: 'text' }],
    organizationPreferenceValues: [{
      id: 'saved-value',
      organization_id: organizationId,
      field_id: fieldId,
      value: 'existing value',
    }],
  });

  assert.equal(result.response.statusCode, 403);
  assert.equal(result.response.body.code, 'STRUCTURED_ACTION_FORBIDDEN');
  assert.equal(
    result.updates.some(entry => entry.table === 'organization_preference_value'),
    false,
  );
});

test('anonymous selection cannot upsert an existing organization custom field', async () => {
  const payload = publicPayload();
  const organizationId = '7dc51049-90dc-42cf-9567-2b128321c21c';
  const fieldId = 'organization-custom-field';
  payload.fields.push({ id: 'org_value', type: 'text' });
  payload.form_values.organisation = organizationId;
  payload.form_values.org_value = 'attempted update';
  payload.entity_pipelines.organisations[0].mappings.push({
    source_type: 'field',
    source_field_id: 'org_value',
    target_type: 'custom',
    target_entity: 'organization',
    target_field: fieldId,
  });

  const result = await invokeProcessor(payload, {
    existingOrganization: { id: organizationId, tenant_id: 'tenant-runtime-org', name: 'Existing Org' },
    verifiedAdminAccess: false,
    preferenceFields: [{ id: fieldId, entity_scope: 'organization', field_type: 'text' }],
  });

  assert.equal(result.response.statusCode, 403);
  assert.equal(result.response.body.code, 'STRUCTURED_ACTION_FORBIDDEN');
  assert.equal(
    result.inserts.some(entry => entry.table === 'organization_preference_value'),
    false,
  );
});

test('not-listed organization creation persists mapped custom values', async () => {
  const payload = publicPayload();
  const fieldId = 'organization-region';
  payload.fields.push(
    { id: 'org_region', type: 'select' },
    { id: 'org_address', type: 'text' },
    { id: 'org_invoicing_address', type: 'text' },
  );
  payload.form_values.org_region = 'London';
  payload.form_values.org_address = '1 Student Street';
  payload.form_values.org_invoicing_address = 'Accounts\n2 Finance Road';
  payload.entity_pipelines.organisations[0].mappings.push(
    {
      source_type: 'field',
      source_field_id: 'org_region',
      target_type: 'custom',
      target_entity: 'organization',
      target_field: fieldId,
    },
    {
      source_type: 'field',
      source_field_id: 'org_address',
      target_type: 'core',
      target_entity: 'organization',
      target_field: 'address',
    },
    {
      source_type: 'field',
      source_field_id: 'org_invoicing_address',
      target_type: 'core',
      target_entity: 'organization',
      target_field: 'invoicing_address',
    },
  );

  const result = await invokeProcessor(payload, {
    verifiedAdminAccess: false,
    preferenceFields: [{ id: fieldId, entity_scope: 'organization', field_type: 'select' }],
  });

  assert.equal(result.response.statusCode, 200);
  assert.equal(
    result.inserts.find(entry => entry.table === 'organization')?.payload.address,
    '1 Student Street',
  );
  assert.equal(
    result.inserts.find(entry => entry.table === 'organization')?.payload.invoicing_address,
    'Accounts\n2 Finance Road',
  );
  assert.deepEqual(
    result.inserts.find(entry => entry.table === 'organization_preference_value')?.payload,
    {
      organization_id: 'created-organization',
      field_id: fieldId,
      value: 'London',
    },
  );
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