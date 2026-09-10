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
  existingMember = null,
  submitterMember = null,
  preferenceFields = [],
  organizationPreferenceValues = [],
  memberPreferenceValues = [],
  pipelineEntityLinks = [],
  customObjectDefinitions = [],
  customObjectRecords = [],
  relationshipDefinitions = [],
  relationshipEdges = [],
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
      this.deleteRequested = false;
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
    delete() {
      this.deleteRequested = true;
      deletes.push({ table: this.table, filters: this.filters });
      return this;
    }
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
        const insertedMatchesId = id && insertedOrganization?.id === id;
        return { data: matchesId || matchesName ? existingOrganization : insertedMatchesId ? insertedOrganization : null, error: null };
      }
      if (this.table === 'member') {
        const id = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'id')?.[2];
        const email = this.filters.find(filter => filter[0] === 'ilike' && filter[1] === 'email')?.[2];
        const candidate = existingMember || submitterMember;
        return {
          data: (id && candidate?.id === id)
            || (email && candidate?.email?.toLowerCase() === String(email).toLowerCase())
            ? candidate
            : null,
          error: null,
        };
      }
      if (this.table === 'organization_preference_value') {
        const organizationId = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'organization_id')?.[2];
        const fieldId = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'field_id')?.[2];
        return {
          data: organizationPreferenceValues.find(row =>
            row.organization_id === organizationId && row.field_id === fieldId) || null,
          error: null,
        };
      }
      if (this.table === 'member_preference_value') {
        const memberId = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'member_id')?.[2];
        const fieldId = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'field_id')?.[2];
        return {
          data: memberPreferenceValues.find(row =>
            row.member_id === memberId && row.field_id === fieldId) || null,
          error: null,
        };
      }
      const rows = {
        preference_field: preferenceFields,
        custom_object_definition: customObjectDefinitions,
        custom_object_record: customObjectRecords,
        custom_object_relationship_definition: relationshipDefinitions,
        custom_object_relationship: relationshipEdges,
      }[this.table];
      if (rows) {
        const match = rows.find(row => this.filters.every(([operator, column, value]) => {
          if (operator === 'eq') return String(row[column]) === String(value);
          if (operator === 'is') return row[column] === value;
          if (operator === 'in') return value.map(String).includes(String(row[column]));
          return true;
        }));
        return { data: match || null, error: null };
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
      if (this.table === 'member') {
        const id = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'id')?.[2];
        const email = this.filters.find(filter => filter[0] === 'ilike' && filter[1] === 'email')?.[2];
        const candidate = existingMember || submitterMember;
        if ((id && candidate?.id === id)
            || (email && candidate?.email?.toLowerCase() === String(email).toLowerCase())) {
          return { data: candidate, error: null };
        }
      }
      return { data: null, error: null };
    }
    then(resolve, reject) {
      let data = [];
      if (this.table === 'preference_field') data = preferenceFields;
      if (this.table === 'form_submission_pipeline_entity') data = pipelineEntityLinks;
      if (this.table === 'custom_object_relationship') data = relationshipEdges;
      if (this.table === 'organization_preference_value') {
        const organizationId = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'organization_id')?.[2];
        const fieldIds = this.filters.find(filter => filter[0] === 'in' && filter[1] === 'field_id')?.[2];
        const fieldId = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'field_id')?.[2];
        if (this.deleteRequested) {
          for (let index = organizationPreferenceValues.length - 1; index >= 0; index -= 1) {
            const row = organizationPreferenceValues[index];
            if (row.organization_id === organizationId
                && (!fieldId || row.field_id === fieldId)
                && (!fieldIds || fieldIds.includes(row.field_id))) {
              organizationPreferenceValues.splice(index, 1);
            }
          }
        }
        data = organizationPreferenceValues.filter(row => (
          row.organization_id === organizationId
          && (!fieldId || row.field_id === fieldId)
          && (!fieldIds || fieldIds.includes(row.field_id))
        ));
      }
      if (this.table === 'member_preference_value') {
        const memberId = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'member_id')?.[2];
        const fieldId = this.filters.find(filter => filter[0] === 'eq' && filter[1] === 'field_id')?.[2];
        if (this.deleteRequested) {
          for (let index = memberPreferenceValues.length - 1; index >= 0; index -= 1) {
            const row = memberPreferenceValues[index];
            if (row.member_id === memberId && (!fieldId || row.field_id === fieldId)) {
              memberPreferenceValues.splice(index, 1);
            }
          }
        }
        data = memberPreferenceValues.filter(row =>
          row.member_id === memberId && (!fieldId || row.field_id === fieldId));
      }
      if (this.table === 'member' && this.updatePayload) {
        const candidate = existingMember || submitterMember;
        data = candidate ? [{ ...candidate, ...this.updatePayload }] : [];
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
  existingMember = null,
  requestFormValues = payload.form_values,
  verifiedAdminAccess = true,
  submitterMember = null,
  preferenceFields = [],
  organizationPreferenceValues = [],
  memberPreferenceValues = [],
  pipelineEntityLinks = [],
  customObjectDefinitions = [],
  customObjectRecords = [],
  relationshipDefinitions = [],
  relationshipEdges = [],
  persistedCreatedOrganizationId = null,
  persistedCreatedMemberId = null,
  entityProcessingCompletedAt = null,
  idempotencyLookupError = null,
  requestBodyOverrides = {},
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
    created_member_id: persistedCreatedMemberId,
    created_organization_id: persistedCreatedOrganizationId,
    entity_processing_completed_at: entityProcessingCompletedAt,
    payment_reference: null,
    payment_status: null,
    payment_meta: {},
    processing_notes: [],
  };
  const db = makeSupabase({
    form,
    submission,
    existingOrganization,
    existingMember,
    submitterMember,
    preferenceFields,
    organizationPreferenceValues,
    memberPreferenceValues,
    pipelineEntityLinks,
    customObjectDefinitions,
    customObjectRecords,
    relationshipDefinitions,
    relationshipEdges,
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
      ...requestBodyOverrides,
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

function relatedDepartmentPayload({
  primaryOrganizationValue = FORM_NOT_LISTED_VALUE,
  primaryOrganizationName = 'New Approved Applicant',
} = {}) {
  const approvedOnly = {
    type: 'core',
    field: 'status',
    values: ['Approved'],
    mode: 'include',
  };
  return publicPayload({
    fields: [
      {
        ...dropdown,
        org_filter: approvedOnly,
      },
      {
        id: 'department_parent_organization',
        type: 'organisation_dropdown',
        org_filter: approvedOnly,
      },
      {
        id: 'department',
        type: 'relationship_dropdown',
        parent_field_id: 'department_parent_organization',
        relationship_definition_id: 'organization-department',
        relationship_parent_kind: 'organization',
        relationship_parent_side: 'source',
        related_kind: 'custom_object',
        related_custom_object_id: 'department-object',
        related_primary_display_field_id: 'department-name',
      },
    ],
    form_values: {
      organisation: primaryOrganizationValue,
      department_parent_organization: 'approved-parent-organization',
      department: 'department-radiology',
      [FORM_NOT_LISTED_TEXT_KEY]: primaryOrganizationValue === FORM_NOT_LISTED_VALUE
        ? { organisation: primaryOrganizationName }
        : {},
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
        related_records: [{
          id: 'primary-organization-department',
          relationship_definition_id: 'organization-department',
          source_field_id: 'department',
        }],
      }],
    },
  });
}

function relatedDepartmentDatabase() {
  return {
    preferenceFields: [{
      id: 'department-name',
      tenant_id: 'tenant-runtime-org',
      custom_object_id: 'department-object',
      entity_scope: 'custom_object',
      is_active: true,
      name: 'name',
      field_type: 'text',
    }],
    customObjectDefinitions: [{
      id: 'department-object',
      tenant_id: 'tenant-runtime-org',
      status: 'active',
      primary_display_field_id: 'department-name',
    }],
    customObjectRecords: [{
      id: 'department-radiology',
      tenant_id: 'tenant-runtime-org',
      custom_object_id: 'department-object',
      archived_at: null,
      data: { name: 'Radiology' },
    }],
    relationshipDefinitions: [{
      id: 'organization-department',
      tenant_id: 'tenant-runtime-org',
      status: 'active',
      source_kind: 'organization',
      source_custom_object_id: null,
      target_kind: 'custom_object',
      target_custom_object_id: 'department-object',
      show_on_source: true,
    }],
    relationshipEdges: [{
      id: 'approved-parent-radiology',
      tenant_id: 'tenant-runtime-org',
      relationship_definition_id: 'organization-department',
      source_record_id: 'approved-parent-organization',
      target_record_id: 'department-radiology',
      archived_at: null,
    }],
  };
}

for (const [surface, requestBodyOverrides] of [
  ['embedded signed handoff', {}],
  ['standalone signed handoff on the same server', {
    // The standalone runner carries request copies too, but persisted form and
    // submission state remains authoritative at the handler boundary.
    form_values: {},
    fields: [],
    entity_pipelines: {},
  }],
]) {
  test(`${surface} creates a filtered not-listed organization and links its valid Department`, async () => {
    const payload = relatedDepartmentPayload();
    const result = await invokeProcessor(payload, {
      existingOrganization: {
        id: 'approved-parent-organization',
        tenant_id: 'tenant-runtime-org',
        name: 'Approved Teaching Hospital',
        status: 'Approved',
      },
      ...relatedDepartmentDatabase(),
      requestBodyOverrides,
    });

    assert.equal(result.response.statusCode, 200);
    assert.equal(
      result.inserts.find(entry => entry.table === 'organization')?.payload.name,
      'New Approved Applicant',
    );
    assert.deepEqual(
      result.inserts.find(entry =>
        entry.table === 'custom_object_relationship'
        && entry.payload.source_record_id === 'created-organization')?.payload,
      {
        tenant_id: 'tenant-runtime-org',
        relationship_definition_id: 'organization-department',
        source_record_id: 'created-organization',
        target_record_id: 'department-radiology',
      },
    );
    assert.equal(result.response.body.related_records?.success, true);
    assert.equal(result.response.body.related_records?.failed_count, 0);
    assert.equal(
      result.response.body.related_records?.outcomes.some(outcome => outcome.status === 'failed'),
      false,
    );
  });
}

function threeDepartmentMemberFixture() {
  const organizationId = 'approved-parent-organization';
  const departmentIds = ['department-radiology', 'department-cardiology', 'department-neurology'];
  const organizationTypeFieldId = 'organization-type';
  const payload = publicPayload({
    fields: [
      { id: 'member_email', type: 'email' },
      {
        ...dropdown,
        id: 'organisation',
        org_filter: {
          type: 'custom',
          field: organizationTypeFieldId,
          values: ['Eligible'],
          mode: 'include',
        },
      },
      {
        id: 'implicit_org_type',
        type: 'select',
        starts_hidden: true,
        custom_field_id: organizationTypeFieldId,
      },
      {
        id: 'departments',
        type: 'relationship_dropdown',
        selection_mode: 'multiple',
        parent_field_id: 'organisation',
        relationship_definition_id: 'organization-department',
        relationship_parent_kind: 'organization',
        relationship_parent_side: 'source',
        related_kind: 'custom_object',
        related_custom_object_id: 'department-object',
        related_primary_display_field_id: 'department-name',
      },
    ],
    form_values: {
      member_email: 'three-departments@example.test',
      organisation: organizationId,
      implicit_org_type: '',
      departments: departmentIds,
    },
    application_level: 'member',
    create_entity_type: 'member',
    member_entity_action: 'upsert',
    organization_entity_action: 'upsert',
    entity_pipelines: {
      members: [{
        id: 'member-primary',
        isPrimary: true,
        mappings: [{
          source_type: 'field',
          source_field_id: 'member_email',
          target_type: 'core',
          target_entity: 'member',
          target_field: 'email',
        }],
        related_records: [{
          id: 'member-departments',
          relationship_definition_id: 'department-member',
          source_field_id: 'departments',
        }],
      }],
      organisations: [{
        id: 'org-primary',
        isPrimary: true,
        mappings: [{
          source_type: 'field',
          source_field_id: 'organisation',
          target_type: 'core',
          target_entity: 'organization',
          target_field: 'name',
        }],
      }],
    },
  });
  const database = relatedDepartmentDatabase();
  database.preferenceFields.push({
    id: organizationTypeFieldId,
    tenant_id: 'tenant-runtime-org',
    entity_scope: 'organization',
    is_active: true,
    name: 'Organisation type',
    field_type: 'select',
  });
  database.customObjectRecords.push(
    {
      id: 'department-cardiology',
      tenant_id: 'tenant-runtime-org',
      custom_object_id: 'department-object',
      archived_at: null,
      data: { name: 'Cardiology' },
    },
    {
      id: 'department-neurology',
      tenant_id: 'tenant-runtime-org',
      custom_object_id: 'department-object',
      archived_at: null,
      data: { name: 'Neurology' },
    },
  );
  database.relationshipDefinitions.push({
    id: 'department-member',
    tenant_id: 'tenant-runtime-org',
    status: 'active',
    source_kind: 'custom_object',
    source_custom_object_id: 'department-object',
    target_kind: 'member',
    target_custom_object_id: null,
    show_on_source: true,
  });
  database.relationshipEdges.push(
    {
      id: 'approved-parent-cardiology',
      tenant_id: 'tenant-runtime-org',
      relationship_definition_id: 'organization-department',
      source_record_id: organizationId,
      target_record_id: 'department-cardiology',
      archived_at: null,
    },
    {
      id: 'approved-parent-neurology',
      tenant_id: 'tenant-runtime-org',
      relationship_definition_id: 'organization-department',
      source_record_id: organizationId,
      target_record_id: 'department-neurology',
      archived_at: null,
    },
  );
  return {
    payload,
    departmentIds,
    options: {
      existingOrganization: {
        id: organizationId,
        tenant_id: 'tenant-runtime-org',
        name: 'Approved Teaching Hospital',
        status: 'Approved',
      },
      ...database,
      organizationPreferenceValues: [{
        id: 'saved-organization-type',
        organization_id: organizationId,
        field_id: organizationTypeFieldId,
        value: 'Eligible',
      }],
    },
  };
}

for (const [surface, requestBodyOverrides] of [
  ['embedded signed handoff', {}],
  ['standalone signed handoff', { form_values: {}, fields: [], entity_pipelines: {} }],
]) {
  test(`${surface} preserves hidden organization type and links three Departments to the primary Member`, async () => {
    const fixture = threeDepartmentMemberFixture();
    const result = await invokeProcessor(fixture.payload, {
      ...fixture.options,
      requestBodyOverrides,
    });
    const links = result.inserts.filter(entry =>
      entry.table === 'custom_object_relationship'
      && entry.payload.relationship_definition_id === 'department-member');

    assert.equal(result.response.statusCode, 200);
    assert.equal(result.response.body.related_records?.success, true,
      JSON.stringify(result.response.body.related_records));
    assert.equal(result.deletes.some(entry =>
      entry.table === 'organization_preference_value'), false);
    assert.equal(
      fixture.options.organizationPreferenceValues.some(row =>
        row.field_id === 'organization-type' && row.value === 'Eligible'),
      true,
    );
    assert.deepEqual(
      links.map(entry => entry.payload.source_record_id).sort(),
      [...fixture.departmentIds].sort(),
    );
    assert.equal(links.every(entry => entry.payload.target_record_id === 'created-member'), true);
    assert.equal(result.response.body.related_records?.failed_count, 0);
    const persistedNotes = result.updates
      .filter(entry => entry.table === 'form_submission')
      .flatMap(entry => entry.payload.processing_notes || []);
    assert.equal(
      persistedNotes.filter(note =>
        note.kind === 'primary_pipeline_related_record'
        && note.status === 'linked').length,
      3,
    );
  });
}

test('completed-primary replay creates only missing Department links and reports a durable success', async () => {
  const fixture = threeDepartmentMemberFixture();
  const result = await invokeProcessor(fixture.payload, {
    ...fixture.options,
    persistedCreatedMemberId: 'created-member',
    persistedCreatedOrganizationId: 'approved-parent-organization',
    entityProcessingCompletedAt: '2026-09-10T08:00:00.000Z',
  });
  const links = result.inserts.filter(entry =>
    entry.table === 'custom_object_relationship'
    && entry.payload.relationship_definition_id === 'department-member');

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.response.body.already_processed, true);
  assert.equal(result.response.body.related_records?.success, true,
    JSON.stringify(result.response.body.related_records));
  assert.equal(result.inserts.some(entry => entry.table === 'member'), false);
  assert.equal(result.inserts.some(entry => entry.table === 'organization'), false);
  assert.deepEqual(
    links.map(entry => entry.payload.source_record_id).sort(),
    [...fixture.departmentIds].sort(),
  );
  assert.equal(result.response.body.related_records?.failed_count, 0);
});

test('completed-primary Department replay is idempotent when all three links already exist', async () => {
  const fixture = threeDepartmentMemberFixture();
  fixture.options.relationshipEdges.push(...fixture.departmentIds.map((departmentId, index) => ({
    id: `existing-member-department-${index}`,
    tenant_id: 'tenant-runtime-org',
    relationship_definition_id: 'department-member',
    source_record_id: departmentId,
    target_record_id: 'created-member',
    archived_at: null,
  })));
  const result = await invokeProcessor(fixture.payload, {
    ...fixture.options,
    persistedCreatedMemberId: 'created-member',
    persistedCreatedOrganizationId: 'approved-parent-organization',
    entityProcessingCompletedAt: '2026-09-10T08:00:00.000Z',
  });

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.response.body.already_processed, true);
  assert.equal(result.response.body.related_records?.success, true,
    JSON.stringify(result.response.body.related_records));
  assert.equal(result.inserts.some(entry =>
    entry.table === 'custom_object_relationship'
    && entry.payload.relationship_definition_id === 'department-member'), false);
  assert.equal(
    result.response.body.related_records?.outcomes.every(outcome =>
      outcome.status === 'already_linked'),
    true,
  );
});

test('cross-tenant Department selection remains rejected without creating any links', async () => {
  const fixture = threeDepartmentMemberFixture();
  const crossTenant = fixture.options.customObjectRecords.find(record =>
    record.id === 'department-neurology');
  crossTenant.tenant_id = 'different-tenant';
  const result = await invokeProcessor(fixture.payload, fixture.options);

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.response.body.related_records?.success, false);
  assert.equal(result.response.body.related_records?.failed_count, 1);
  assert.equal(
    result.response.body.related_records?.outcomes[0]?.reason,
    'submitted_relationship_invalid',
  );
  assert.equal(result.inserts.some(entry =>
    entry.table === 'custom_object_relationship'
    && entry.payload.relationship_definition_id === 'department-member'), false);
});

test('same-name not-listed fields materialize only the final winning organization-name source', async () => {
  const approvedOnly = {
    type: 'core',
    field: 'status',
    values: ['Approved'],
    mode: 'include',
  };
  const sameName = 'Same Name Applicant';
  const payload = relatedDepartmentPayload({
    primaryOrganizationName: sameName,
  });
  payload.fields = [
    {
      ...dropdown,
      id: 'nonwinning_organisation',
      org_filter: approvedOnly,
    },
    {
      ...payload.fields.find(field => field.id === 'department'),
      parent_field_id: 'nonwinning_organisation',
    },
    {
      ...dropdown,
      id: 'organisation',
      org_filter: approvedOnly,
    },
  ];
  payload.form_values = {
    nonwinning_organisation: FORM_NOT_LISTED_VALUE,
    department: 'department-radiology',
    organisation: FORM_NOT_LISTED_VALUE,
    [FORM_NOT_LISTED_TEXT_KEY]: {
      nonwinning_organisation: sameName,
      organisation: sameName,
    },
  };
  payload.entity_pipelines.organisations[0].mappings = [
    {
      source_type: 'field',
      source_field_id: 'nonwinning_organisation',
      target_type: 'core',
      target_entity: 'organization',
      target_field: 'organisation_name',
    },
    {
      source_type: 'field',
      source_field_id: 'organisation',
      target_type: 'core',
      target_entity: 'organization',
      target_field: 'organisation_name',
    },
  ];

  const result = await invokeProcessor(payload, relatedDepartmentDatabase());

  assert.equal(result.response.statusCode, 200);
  assert.equal(
    result.inserts.find(entry => entry.table === 'organization')?.payload.name,
    sameName,
  );
  assert.equal(result.response.body.related_records?.success, false);
  assert.equal(result.response.body.related_records?.failed_count, 1);
  assert.equal(
    result.response.body.related_records?.outcomes[0]?.reason,
    'submitted_relationship_invalid',
  );
  assert.equal(
    result.inserts.some(entry => entry.table === 'custom_object_relationship'),
    false,
  );
});

test('same-text static overwrite clears not-listed organization-name provenance', async () => {
  const sameName = 'Static Final Applicant';
  const payload = relatedDepartmentPayload({
    primaryOrganizationName: sameName,
  });
  payload.fields = [
    payload.fields.find(field => field.id === 'organisation'),
    {
      ...payload.fields.find(field => field.id === 'department'),
      parent_field_id: 'organisation',
    },
  ];
  delete payload.form_values.department_parent_organization;
  payload.entity_pipelines.organisations[0].mappings.push({
    source_type: 'static',
    static_value: sameName,
    target_type: 'core',
    target_entity: 'organization',
    target_field: 'organisation_name',
  });

  const result = await invokeProcessor(payload, relatedDepartmentDatabase());

  assert.equal(result.response.statusCode, 200);
  assert.equal(
    result.inserts.find(entry => entry.table === 'organization')?.payload.name,
    sameName,
  );
  assert.equal(result.response.body.related_records?.success, false);
  assert.equal(
    result.response.body.related_records?.outcomes[0]?.reason,
    'submitted_relationship_invalid',
  );
  assert.equal(
    result.inserts.some(entry => entry.table === 'custom_object_relationship'),
    false,
  );
});

test('already-completed full-handler replay accepts an existing edge without inferring creation provenance', async () => {
  const payload = relatedDepartmentPayload();
  const database = relatedDepartmentDatabase();
  database.relationshipEdges.push({
    id: 'created-organization-radiology',
    tenant_id: 'tenant-runtime-org',
    relationship_definition_id: 'organization-department',
    source_record_id: 'created-organization',
    target_record_id: 'department-radiology',
    archived_at: null,
  });
  const result = await invokeProcessor(payload, {
    existingOrganization: {
      id: 'approved-parent-organization',
      tenant_id: 'tenant-runtime-org',
      name: 'Approved Teaching Hospital',
      status: 'Approved',
    },
    ...database,
    persistedCreatedOrganizationId: 'created-organization',
    entityProcessingCompletedAt: '2026-09-10T08:00:00.000Z',
  });

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.response.body.already_processed, true);
  assert.equal(result.response.body.organization_id, 'created-organization');
  assert.equal(result.response.body.related_records?.success, true);
  assert.equal(result.response.body.related_records?.failed_count, 0);
  assert.equal(result.response.body.related_records?.outcomes[0]?.status, 'already_linked');
  assert.equal(result.inserts.some(entry => entry.table === 'organization'), false);
  assert.equal(
    result.inserts.some(entry => entry.table === 'custom_object_relationship'),
    false,
  );
});

for (const [surface, forged] of [
  ['top-level', {
    serverCreatedOrganizations: new Map([['organisation', 'ineligible-organization']]),
  }],
  ['nested', {
    entity_pipelines: {
      organisations: [],
      serverCreatedOrganizations: new Map([['organisation', 'ineligible-organization']]),
    },
  }],
]) {
  test(`forged ${surface} serverCreatedOrganizations cannot bypass the approved-only filter`, async () => {
    const payload = relatedDepartmentPayload({
      primaryOrganizationValue: 'ineligible-organization',
    });
    const result = await invokeProcessor(payload, {
      existingOrganization: {
        id: 'ineligible-organization',
        tenant_id: 'tenant-runtime-org',
        name: 'Pending Applicant',
        status: 'Pending',
      },
      ...relatedDepartmentDatabase(),
      requestBodyOverrides: forged,
    });

    assert.equal(result.response.statusCode, 200);
    assert.equal(result.inserts.some(entry => entry.table === 'organization'), false);
    assert.equal(result.response.body.related_records?.success, false);
    assert.equal(result.response.body.related_records?.failed_count, 1);
    assert.equal(
      result.response.body.related_records?.outcomes[0]?.reason,
      'submitted_relationship_invalid',
    );
    assert.equal(
      result.inserts.some(entry =>
        entry.table === 'custom_object_relationship'
        && entry.payload.source_record_id === 'ineligible-organization'),
      false,
    );
  });
}

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

test('a hidden organization identity mapping preserves legacy processing when Ignore if hidden is off', async () => {
  const payload = publicPayload();
  payload.fields[0].starts_hidden = true;
  const result = await invokeProcessor(payload);

  assert.equal(result.response.statusCode, 200);
  assert.equal(
    result.inserts.find(entry => entry.table === 'organization')?.payload.name,
    'Runtime Organisation Ltd',
  );
});

test('an opted-in hidden organization identity records a successful pipeline no-op', async () => {
  const payload = publicPayload();
  payload.fields[0].starts_hidden = true;
  payload.fields[0].core_field_mapping = 'organization.name';
  payload.entity_pipelines.organisations[0].mappings[0].id = 'hidden-org-name';
  payload.entity_pipelines.organisations[0].mappings[0].ignore_if_hidden = true;
  const result = await invokeProcessor(payload);
  const persistedNotes = result.updates
    .filter(entry => entry.table === 'form_submission')
    .flatMap(entry => entry.payload.processing_notes || []);

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.inserts.some(entry => entry.table === 'organization'), false);
  assert.equal(persistedNotes.some(note => note.kind === 'hidden_mapping_ignored'), true);
  assert.equal(
    persistedNotes.some(note =>
      note.kind === 'entity_pipeline_skipped_hidden_identity'
      && note.target_entity === 'organization'),
    true,
  );
});

test('a hidden primary member identity no-op does not block an independent organization pipeline', async () => {
  const payload = publicPayload({
    fields: [
      {
        id: 'member_email',
        type: 'email',
        starts_hidden: true,
        core_field_mapping: 'member.email',
      },
      dropdown,
    ],
    form_values: {
      member_email: 'forged-hidden@example.test',
      organisation: FORM_NOT_LISTED_VALUE,
      [FORM_NOT_LISTED_TEXT_KEY]: { organisation: 'Independent Organisation' },
    },
    application_level: 'member',
    create_entity_type: 'member',
    member_entity_action: 'upsert',
    organization_entity_action: 'upsert',
    entity_pipelines: {
      members: [{
        id: 'member-primary',
        isPrimary: true,
        mappings: [{
          id: 'hidden-member-email',
          source_type: 'field',
          source_field_id: 'member_email',
          target_type: 'core',
          target_entity: 'member',
          target_field: 'email',
          ignore_if_hidden: true,
        }],
      }],
      organisations: [{
        id: 'org-primary',
        isPrimary: true,
        mappings: [{
          source_type: 'field',
          source_field_id: 'organisation',
          target_type: 'core',
          target_entity: 'organization',
          target_field: 'name',
        }],
      }],
    },
  });
  const result = await invokeProcessor(payload);
  const persistedNotes = result.updates
    .filter(entry => entry.table === 'form_submission')
    .flatMap(entry => entry.payload.processing_notes || []);

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.inserts.some(entry => entry.table === 'member'), false);
  assert.equal(
    result.inserts.find(entry => entry.table === 'organization')?.payload.name,
    'Independent Organisation',
  );
  assert.equal(
    persistedNotes.some(note =>
      note.kind === 'entity_pipeline_skipped_hidden_identity'
      && note.target_entity === 'member'),
    true,
  );
});

test('an ignored hidden custom mapping is not restored by legacy field metadata', async () => {
  const customFieldId = 'organization-region';
  const payload = publicPayload();
  payload.fields.push({
    id: 'hidden_region',
    type: 'select',
    starts_hidden: true,
    custom_field_id: customFieldId,
  });
  payload.form_values.hidden_region = 'Forged hidden region';
  payload.entity_pipelines.organisations[0].mappings.push({
    id: 'hidden-org-region',
    source_type: 'field',
    source_field_id: 'hidden_region',
    target_type: 'custom',
    target_entity: 'organization',
    target_field: customFieldId,
    ignore_if_hidden: true,
  });

  const result = await invokeProcessor(payload, {
    preferenceFields: [{
      id: customFieldId,
      entity_scope: 'organization',
      field_type: 'select',
    }],
  });

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.inserts.some(entry =>
    entry.table === 'organization_preference_value'
    && entry.payload.field_id === customFieldId), false);
});

for (const [label, submittedValue] of [
  ['blank', ''],
  ['nonblank', 'Forged hidden type'],
]) {
  test(`a hidden ${label} implicit organization custom binding preserves the existing value`, async () => {
    const customFieldId = 'organization-type';
    const organizationId = '7dc51049-90dc-42cf-9567-2b128321c21c';
    const payload = publicPayload();
    payload.fields.push({
      id: 'implicit_org_type',
      type: 'select',
      starts_hidden: true,
      custom_field_id: customFieldId,
    });
    payload.form_values.organisation = organizationId;
    payload.form_values.implicit_org_type = submittedValue;

    const result = await invokeProcessor(payload, {
      existingOrganization: {
        id: organizationId,
        tenant_id: 'tenant-runtime-org',
        name: 'Existing eligible organization',
      },
      preferenceFields: [{
        id: customFieldId,
        entity_scope: 'organization',
        field_type: 'select',
      }],
      organizationPreferenceValues: [{
        id: 'saved-organization-type',
        organization_id: organizationId,
        field_id: customFieldId,
        value: 'Eligible',
      }],
    });

    assert.equal(result.response.statusCode, 200);
    assert.equal(result.deletes.some(entry =>
      entry.table === 'organization_preference_value'), false);
    assert.equal(result.updates.some(entry =>
      entry.table === 'organization_preference_value'), false);
    assert.equal(result.inserts.some(entry =>
      entry.table === 'organization_preference_value'), false);
  });
}

test('visible and absent implicit organization custom bindings retain clear/no-op semantics', async () => {
  const customFieldId = 'organization-type';
  const organizationId = '7dc51049-90dc-42cf-9567-2b128321c21c';
  const preferenceFields = [{
    id: customFieldId,
    entity_scope: 'organization',
    field_type: 'select',
  }];
  const organizationPreferenceValues = [{
    id: 'saved-organization-type',
    organization_id: organizationId,
    field_id: customFieldId,
    value: 'Eligible',
  }];
  const existingOrganization = {
    id: organizationId,
    tenant_id: 'tenant-runtime-org',
    name: 'Existing eligible organization',
  };
  const visible = publicPayload();
  visible.fields.push({
    id: 'implicit_org_type',
    type: 'select',
    custom_field_id: customFieldId,
  });
  visible.form_values.organisation = organizationId;
  visible.form_values.implicit_org_type = '';

  const cleared = await invokeProcessor(visible, {
    existingOrganization,
    preferenceFields,
    organizationPreferenceValues,
  });
  assert.equal(cleared.response.statusCode, 200);
  assert.equal(cleared.deletes.some(entry =>
    entry.table === 'organization_preference_value'), true);

  const absent = publicPayload();
  absent.fields.push({
    id: 'implicit_org_type',
    type: 'select',
    custom_field_id: customFieldId,
  });
  absent.form_values.organisation = organizationId;
  const untouched = await invokeProcessor(absent, {
    existingOrganization,
    preferenceFields,
    organizationPreferenceValues,
  });
  assert.equal(untouched.response.statusCode, 200);
  assert.equal(untouched.deletes.some(entry =>
    entry.table === 'organization_preference_value'), false);
  assert.equal(untouched.updates.some(entry =>
    entry.table === 'organization_preference_value'), false);
});

test('a hidden implicit member custom binding is not written for a new member', async () => {
  const customFieldId = 'member-category';
  const payload = publicPayload({
    fields: [
      { id: 'member_email', type: 'email' },
      {
        id: 'implicit_member_category',
        type: 'text',
        starts_hidden: true,
        custom_field_id: customFieldId,
      },
    ],
    form_values: {
      member_email: 'hidden-implicit@example.test',
      implicit_member_category: 'Forged hidden category',
    },
    application_level: 'member',
    create_entity_type: 'member',
    member_entity_action: 'upsert',
    organization_entity_action: 'none',
    entity_pipelines: {
      members: [{
        id: 'member-primary',
        isPrimary: true,
        mappings: [{
          source_type: 'field',
          source_field_id: 'member_email',
          target_type: 'core',
          target_entity: 'member',
          target_field: 'email',
        }],
      }],
      organisations: [],
    },
  });
  const result = await invokeProcessor(payload, {
    preferenceFields: [{
      id: customFieldId,
      entity_scope: 'member',
      field_type: 'text',
    }],
  });

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.inserts.some(entry =>
    entry.table === 'member_preference_value'
    && entry.payload.field_id === customFieldId), false);
});

function existingMemberImplicitPayload({
  value = 'Changed category',
  includeAnswer = true,
  fieldOverrides = {},
  payloadOverrides = {},
} = {}) {
  const formValues = { member_email: 'existing-member@example.test' };
  if (includeAnswer) formValues.implicit_member_category = value;
  return publicPayload({
    fields: [
      { id: 'member_email', type: 'email' },
      {
        id: 'implicit_member_category',
        type: 'text',
        custom_field_id: 'member-category',
        ...fieldOverrides,
      },
    ],
    form_values: formValues,
    application_level: 'member',
    create_entity_type: 'member',
    member_entity_action: 'upsert',
    organization_entity_action: 'none',
    entity_pipelines: {
      members: [{
        id: 'member-primary',
        isPrimary: true,
        mappings: [{
          source_type: 'field',
          source_field_id: 'member_email',
          target_type: 'core',
          target_entity: 'member',
          target_field: 'email',
        }],
      }],
      organisations: [],
    },
    ...payloadOverrides,
  });
}

function existingMemberImplicitOptions(overrides = {}) {
  const member = {
    id: 'existing-member',
    tenant_id: null,
    email: 'existing-member@example.test',
    organization_id: null,
    role_id: null,
  };
  return {
    verifiedAdminAccess: true,
    existingMember: member,
    preferenceFields: [{
      id: 'member-category',
      entity_scope: 'member',
      field_type: 'text',
    }],
    memberPreferenceValues: [{
      id: 'saved-member-category',
      member_id: member.id,
      field_id: 'member-category',
      value: 'Original category',
    }],
    ...overrides,
  };
}

for (const [label, submittedValue] of [
  ['blank', ''],
  ['nonblank', 'Forged hidden category'],
]) {
  test(`a hidden ${label} implicit binding preserves an existing Member preference`, async () => {
    const payload = existingMemberImplicitPayload({
      value: submittedValue,
      fieldOverrides: { starts_hidden: true },
    });
    const options = existingMemberImplicitOptions();
    const result = await invokeProcessor(payload, options);

    assert.equal(result.response.statusCode, 200);
    assert.equal(result.deletes.some(entry =>
      entry.table === 'member_preference_value'), false);
    assert.equal(result.updates.some(entry =>
      entry.table === 'member_preference_value'), false);
    assert.equal(result.inserts.some(entry =>
      entry.table === 'member_preference_value'), false);
    assert.deepEqual(options.memberPreferenceValues.map(row => row.value), ['Original category']);
  });
}

test('visible clear and absent implicit bindings retain existing Member semantics', async () => {
  const clearOptions = existingMemberImplicitOptions();
  const cleared = await invokeProcessor(
    existingMemberImplicitPayload({ value: '' }),
    clearOptions,
  );
  assert.equal(cleared.response.statusCode, 200);
  assert.equal(cleared.deletes.some(entry =>
    entry.table === 'member_preference_value'), true);
  assert.deepEqual(clearOptions.memberPreferenceValues, []);

  const absentOptions = existingMemberImplicitOptions();
  const untouched = await invokeProcessor(
    existingMemberImplicitPayload({ includeAnswer: false }),
    absentOptions,
  );
  assert.equal(untouched.response.statusCode, 200);
  assert.equal(untouched.deletes.some(entry =>
    entry.table === 'member_preference_value'), false);
  assert.equal(untouched.updates.some(entry =>
    entry.table === 'member_preference_value'), false);
  assert.equal(untouched.inserts.some(entry =>
    entry.table === 'member_preference_value'), false);
  assert.deepEqual(absentOptions.memberPreferenceValues.map(row => row.value), ['Original category']);
});

test('authoritative visibility rules protect an existing Member implicit preference', async () => {
  const payload = existingMemberImplicitPayload({
    value: '',
    payloadOverrides: {
      visibility_rules: [{
        trigger_field_id: 'hide_member_category',
        operator: 'equals',
        value: 'yes',
        action: 'hide',
        target_field_ids: ['implicit_member_category'],
      }],
    },
  });
  payload.fields.unshift({ id: 'hide_member_category', type: 'text' });
  payload.form_values.hide_member_category = 'yes';
  const options = existingMemberImplicitOptions();
  const result = await invokeProcessor(payload, options);

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.deletes.some(entry =>
    entry.table === 'member_preference_value'), false);
  assert.deepEqual(options.memberPreferenceValues.map(row => row.value), ['Original category']);
});

test('a hidden page protects an existing Organisation implicit preference', async () => {
  const customFieldId = 'organization-type';
  const organizationId = '7dc51049-90dc-42cf-9567-2b128321c21c';
  const payload = publicPayload({ pages: [{ id: 'hidden-details', starts_hidden: true }] });
  payload.fields.push({
    id: 'implicit_org_type',
    page_id: 'hidden-details',
    type: 'select',
    custom_field_id: customFieldId,
  });
  payload.form_values.organisation = organizationId;
  payload.form_values.implicit_org_type = '';
  const organizationPreferenceValues = [{
    id: 'saved-organization-type',
    organization_id: organizationId,
    field_id: customFieldId,
    value: 'Eligible',
  }];
  const result = await invokeProcessor(payload, {
    existingOrganization: {
      id: organizationId,
      tenant_id: 'tenant-runtime-org',
      name: 'Existing eligible organization',
    },
    preferenceFields: [{
      id: customFieldId,
      entity_scope: 'organization',
      field_type: 'select',
    }],
    organizationPreferenceValues,
  });

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.deletes.some(entry =>
    entry.table === 'organization_preference_value'), false);
  assert.deepEqual(organizationPreferenceValues.map(row => row.value), ['Eligible']);
});

test('an unauthenticated respondent cannot visibly mutate an existing Member preference', async () => {
  const payload = existingMemberImplicitPayload({ value: 'Unauthorized change' });
  const targetMember = {
    id: 'existing-member',
    tenant_id: null,
    email: 'existing-member@example.test',
    organization_id: null,
    role_id: null,
  };
  const result = await invokeProcessor(payload, {
    existingMember: targetMember,
    verifiedAdminAccess: false,
    preferenceFields: [{
      id: 'member-category',
      entity_scope: 'member',
      field_type: 'text',
    }],
    memberPreferenceValues: [{
      id: 'saved-member-category',
      member_id: targetMember.id,
      field_id: 'member-category',
      value: 'Original category',
    }],
  });

  assert.equal(result.response.statusCode, 403);
  assert.equal(result.response.body.code, 'STRUCTURED_ACTION_FORBIDDEN');
  assert.equal(result.updates.some(entry =>
    entry.table === 'member_preference_value'), false);
  assert.equal(result.inserts.some(entry =>
    entry.table === 'member_preference_value'), false);
});

test('modern custom mappings still require explicit Ignore if hidden opt-in', async () => {
  const customFieldId = 'organization-region';
  const payload = publicPayload();
  payload.fields.push({
    id: 'hidden_region',
    type: 'select',
    starts_hidden: true,
  });
  payload.form_values.hidden_region = 'Explicit hidden region';
  payload.entity_pipelines.organisations[0].mappings.push({
    source_type: 'field',
    source_field_id: 'hidden_region',
    target_type: 'custom',
    target_entity: 'organization',
    target_field: customFieldId,
  });

  const result = await invokeProcessor(payload, {
    preferenceFields: [{
      id: customFieldId,
      entity_scope: 'organization',
      field_type: 'select',
    }],
  });

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.inserts.some(entry =>
    entry.table === 'organization_preference_value'
    && entry.payload.field_id === customFieldId
    && entry.payload.value === 'Explicit hidden region'), true);
});

test('pipeline ownership of legacy core metadata does not suppress an independent custom mapping', async () => {
  const customFieldId = 'organization-alias';
  const payload = publicPayload();
  payload.fields.push({
    id: 'organization_alias',
    type: 'text',
    core_field_mapping: 'organization.name',
    custom_field_id: customFieldId,
  });
  payload.form_values.organization_alias = 'Independent custom value';

  const result = await invokeProcessor(payload, {
    preferenceFields: [{
      id: customFieldId,
      entity_scope: 'organization',
      field_type: 'text',
    }],
  });

  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(
    result.inserts.find(entry =>
      entry.table === 'organization_preference_value'
      && entry.payload.field_id === customFieldId)?.payload,
    {
      organization_id: 'created-organization',
      field_id: customFieldId,
      value: 'Independent custom value',
    },
  );
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