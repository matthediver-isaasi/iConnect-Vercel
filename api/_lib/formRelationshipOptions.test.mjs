import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FormRelationshipError,
  createFormRelationshipService,
  organizationRelationshipSide,
  savedRelationshipField,
} from './formRelationshipOptions.js';

const tenantId = 'tenant-1';

function mockDb(seed) {
  const tables = structuredClone(seed);
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.orders = [];
    }
    select() { return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
    is(column, value) { this.filters.push((row) => row[column] === value); return this; }
    in(column, values) { this.filters.push((row) => values.includes(row[column])); return this; }
    order(column, { ascending = true } = {}) {
      this.orders.push({ column, ascending });
      return this;
    }
    range(from, to) { this.slice = [from, to + 1]; return this; }
    execute() {
      const rows = (tables[this.table] || []).filter((row) => this.filters.every((filter) => filter(row)));
      rows.sort((left, right) => {
        for (const order of this.orders) {
          if (left[order.column] === right[order.column]) continue;
          const value = left[order.column] < right[order.column] ? -1 : 1;
          return order.ascending ? value : -value;
        }
        return 0;
      });
      return { data: structuredClone(this.slice ? rows.slice(...this.slice) : rows), error: null };
    }
    async maybeSingle() {
      const result = this.execute();
      return { ...result, data: result.data[0] || null };
    }
    then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
  }
  return { from: (table) => new Query(table) };
}

function form(overrides = {}) {
  return {
    id: 'form-1',
    slug: 'application',
    tenant_id: tenantId,
    is_active: true,
    fields: [
      { id: 'org', type: 'organisation_dropdown' },
      {
        id: 'department',
        type: 'relationship_dropdown',
        parent_field_id: 'org',
        relationship_definition_id: 'definition-1',
        custom_object_id: 'object-1',
        custom_object_primary_display_field_id: 'name-field',
      },
    ],
    ...overrides,
  };
}

function definition(overrides = {}) {
  return {
    id: 'definition-1',
    tenant_id: tenantId,
    relationship_key: 'organization_units',
    status: 'active',
    source_kind: 'organization',
    source_custom_object_id: null,
    target_kind: 'custom_object',
    target_custom_object_id: 'object-1',
    show_on_source: true,
    source_label: 'Units',
    target_label: 'Organization',
    ...overrides,
  };
}

test('organization relationship shape accepts either visible generic schema direction', () => {
  assert.deepEqual(organizationRelationshipSide(definition()), {
    organizationSide: 'source',
    relatedSide: 'target',
    customObjectId: 'object-1',
  });
  assert.deepEqual(organizationRelationshipSide(definition({
    source_kind: 'custom_object',
    source_custom_object_id: 'object-1',
    target_kind: 'organization',
    target_custom_object_id: null,
  })), {
    organizationSide: 'target',
    relatedSide: 'source',
    customObjectId: 'object-1',
  });
  assert.equal(organizationRelationshipSide(definition({ target_kind: 'member' })), null);
});

test('saved relationship configuration requires an earlier organization field and exact IDs', () => {
  assert.equal(savedRelationshipField(form(), 'department').relationshipDefinitionId, 'definition-1');
  assert.throws(
    () => savedRelationshipField(form({
      fields: [
        form().fields[1],
        form().fields[0],
      ],
    }), 'department'),
    (error) => error instanceof FormRelationshipError && error.status === 409,
  );
  assert.throws(
    () => savedRelationshipField(form({
      fields: [
        form().fields[0],
        { ...form().fields[1], relationship_definition_id: null },
      ],
    }), 'department'),
    /configuration is incomplete/,
  );
});

test('eligible discovery returns only active, organization-visible relationships to active objects', async () => {
  const service = createFormRelationshipService({
    tenantId,
    db: mockDb({
      form: [form(), form({ id: 'foreign-form', tenant_id: 'tenant-2' })],
      custom_object_relationship_definition: [
        definition(),
        definition({ id: 'hidden', relationship_key: 'hidden', show_on_source: false }),
        definition({ id: 'draft', relationship_key: 'draft', status: 'draft' }),
        definition({ id: 'foreign', relationship_key: 'foreign', tenant_id: 'tenant-2' }),
      ],
      custom_object_definition: [{
        id: 'object-1',
        tenant_id: tenantId,
        object_key: 'units',
        singular_label: 'Unit',
        plural_label: 'Units',
        primary_display_field_id: 'name-field',
        status: 'active',
      }],
    }),
  });
  const result = await service.eligibleDefinitions('form-1');
  assert.deepEqual(result.data.map((item) => item.id), ['definition-1']);
  assert.equal(result.data[0].custom_object.object_key, 'units');
});

test('options enforce saved definition and filter inactive edges, objects, records, and tenants', async () => {
  const db = mockDb({
    form: [form()],
    organization: [
      { id: 'org-1', tenant_id: tenantId },
      { id: 'org-2', tenant_id: 'tenant-2' },
    ],
    custom_object_relationship_definition: [definition()],
    custom_object_definition: [{
      id: 'object-1',
      tenant_id: tenantId,
      object_key: 'units',
      singular_label: 'Unit',
      plural_label: 'Units',
      status: 'active',
      primary_display_field_id: 'name-field',
    }],
    preference_field: [{
      id: 'name-field',
      tenant_id: tenantId,
      custom_object_id: 'object-1',
      entity_scope: 'custom_object',
      is_active: true,
      name: 'unit_name',
      label: 'Name',
      field_type: 'text',
    }],
    custom_object_relationship: [
      {
        id: 'edge-1', tenant_id: tenantId, relationship_definition_id: 'definition-1',
        source_record_id: 'org-1', target_record_id: 'record-z', archived_at: null,
      },
      {
        id: 'edge-2', tenant_id: tenantId, relationship_definition_id: 'definition-1',
        source_record_id: 'org-1', target_record_id: 'record-a', archived_at: null,
      },
      {
        id: 'edge-archived', tenant_id: tenantId, relationship_definition_id: 'definition-1',
        source_record_id: 'org-1', target_record_id: 'record-hidden', archived_at: '2026-01-01',
      },
      {
        id: 'edge-other-org', tenant_id: tenantId, relationship_definition_id: 'definition-1',
        source_record_id: 'other-org', target_record_id: 'record-other', archived_at: null,
      },
    ],
    custom_object_record: [
      { id: 'record-z', tenant_id: tenantId, custom_object_id: 'object-1', archived_at: null, data: { unit_name: 'Zulu' } },
      { id: 'record-a', tenant_id: tenantId, custom_object_id: 'object-1', archived_at: null, data: { unit_name: 'Alpha' } },
      { id: 'record-hidden', tenant_id: tenantId, custom_object_id: 'object-1', archived_at: null, data: { unit_name: 'Hidden' } },
      { id: 'record-other', tenant_id: tenantId, custom_object_id: 'object-1', archived_at: null, data: { unit_name: 'Other' } },
      { id: 'record-z', tenant_id: 'tenant-2', custom_object_id: 'object-1', archived_at: null, data: { unit_name: 'Leaked' } },
    ],
  });
  const result = await createFormRelationshipService({ db, tenantId }).relationshipOptions({
    formId: 'form-1',
    fieldId: 'department',
    organizationId: 'org-1',
    query: { page: '1', pageSize: '1' },
  });
  assert.deepEqual(result, {
    data: [{ id: 'record-a', label: 'Alpha' }],
    total: 2,
    page: 1,
    pageSize: 1,
  });
});

test('options fail closed when the saved object does not exactly match the active definition', async () => {
  const db = mockDb({
    form: [form()],
    organization: [{ id: 'org-1', tenant_id: tenantId }],
    custom_object_relationship_definition: [definition({ target_custom_object_id: 'different-object' })],
  });
  await assert.rejects(
    () => createFormRelationshipService({ db, tenantId }).relationshipOptions({
      formId: 'form-1',
      fieldId: 'department',
      organizationId: 'org-1',
    }),
    (error) => error.status === 409 && /configuration is unavailable/.test(error.message),
  );
});

test('options enforce the saved parent organisation dropdown filter', async () => {
  const filteredForm = form({
    fields: [
      { id: 'org', type: 'organisation_dropdown', org_filter: { type: 'core', field: 'status', values: ['approved'] } },
      form().fields[1],
    ],
  });
  const service = createFormRelationshipService({
    tenantId,
    db: mockDb({
      form: [filteredForm],
      organization: [{ id: 'org-pending', tenant_id: tenantId, status: 'pending' }],
      custom_object_relationship_definition: [definition()],
    }),
  });
  await assert.rejects(
    () => service.relationshipOptions({
      formId: 'form-1', fieldId: 'department', organizationId: 'org-pending',
    }),
    (error) => error.status === 400 && /not eligible/.test(error.message),
  );
});

test('options enforce saved allowed_org_statuses through organization preferences', async () => {
  const statusForm = form({
    fields: [
      { id: 'org', type: 'organisation_dropdown', allowed_org_statuses: ['approved'] },
      form().fields[1],
    ],
  });
  const service = createFormRelationshipService({
    tenantId,
    db: mockDb({
      form: [statusForm],
      organization: [{ id: 'org-1', tenant_id: tenantId }],
      preference_field: [{
        id: 'application-status', tenant_id: tenantId, name: 'application_status',
        entity_scope: 'organization', is_active: true,
      }],
      organization_preference_value: [{
        organization_id: 'org-1', field_id: 'application-status', value: 'pending',
      }],
      custom_object_relationship_definition: [definition()],
    }),
  });
  await assert.rejects(
    () => service.relationshipOptions({
      formId: 'form-1', fieldId: 'department', organizationId: 'org-1',
    }),
    (error) => error.status === 400 && /not eligible/.test(error.message),
  );
});

test('submission validation accepts only the active record related to its submitted parent', async () => {
  const service = createFormRelationshipService({
    tenantId,
    db: mockDb({
      form: [form()],
      organization: [
        { id: 'org-1', tenant_id: tenantId },
        { id: 'org-2', tenant_id: tenantId },
      ],
      custom_object_relationship_definition: [definition()],
      custom_object_definition: [{
        id: 'object-1', tenant_id: tenantId, status: 'active',
        primary_display_field_id: 'name-field',
      }],
      preference_field: [{
        id: 'name-field', tenant_id: tenantId, custom_object_id: 'object-1',
        entity_scope: 'custom_object', is_active: true, name: 'unit_name', field_type: 'text',
      }],
      custom_object_relationship: [{
        id: 'edge-1', tenant_id: tenantId, relationship_definition_id: 'definition-1',
        source_record_id: 'org-1', target_record_id: 'record-1', archived_at: null,
      }],
      custom_object_record: [{
        id: 'record-1', tenant_id: tenantId, custom_object_id: 'object-1',
        archived_at: null, data: { unit_name: 'A unit' },
      }],
    }),
  });
  await service.validateSubmission({
    form: form(),
    submissionData: { org: 'org-1', department: 'record-1' },
  });
  await assert.rejects(
    () => service.validateSubmission({
      form: form(),
      submissionData: { org: 'org-1', department: 'forged-record' },
    }),
    (error) => error.status === 400 && /Invalid relationship selection/.test(error.message),
  );
  await assert.rejects(
    () => service.validateSubmission({
      form: form(),
      // This is the effective result of editing only the organisation parent:
      // the previously valid dependent record must still be checked.
      submissionData: { org: 'org-2', department: 'record-1' },
    }),
    (error) => error.status === 400 && /Invalid relationship selection/.test(error.message),
  );
});

test('submission validation rejects forged legacy name keys and mismatched name-keyed parents', async () => {
  const namedForm = form({
    fields: [
      { id: 'org', name: 'organisation', type: 'organisation_dropdown' },
      { ...form().fields[1], name: 'unit' },
    ],
  });
  const service = createFormRelationshipService({
    tenantId,
    db: mockDb({
      form: [namedForm],
      organization: [
        { id: 'org-1', tenant_id: tenantId },
        { id: 'org-2', tenant_id: tenantId },
      ],
      custom_object_relationship_definition: [definition()],
      custom_object_definition: [{
        id: 'object-1', tenant_id: tenantId, status: 'active',
        primary_display_field_id: 'name-field',
      }],
      preference_field: [{
        id: 'name-field', tenant_id: tenantId, custom_object_id: 'object-1',
        entity_scope: 'custom_object', is_active: true, name: 'unit_name', field_type: 'text',
      }],
      custom_object_relationship: [{
        id: 'edge-1', tenant_id: tenantId, relationship_definition_id: 'definition-1',
        source_record_id: 'org-1', target_record_id: 'record-1', archived_at: null,
      }],
      custom_object_record: [{
        id: 'record-1', tenant_id: tenantId, custom_object_id: 'object-1',
        archived_at: null, data: { unit_name: 'A unit' },
      }],
    }),
  });

  await assert.rejects(
    () => service.validateSubmission({
      form: namedForm,
      submissionData: {
        department: undefined,
        organisation: 'org-1',
        unit: 'forged-record',
      },
    }),
    (error) => error.status === 400 && /Invalid relationship selection/.test(error.message),
  );
  await assert.rejects(
    () => service.validateSubmission({
      form: namedForm,
      submissionData: {
        org: undefined,
        organisation: 'org-2',
        unit: 'record-1',
      },
    }),
    (error) => error.status === 400 && /Invalid relationship selection/.test(error.message),
  );

  // Canonical IDs remain authoritative when both old and new keys exist.
  await service.validateSubmission({
    form: namedForm,
    submissionData: {
      org: 'org-1',
      organisation: 'org-2',
      department: 'record-1',
      unit: 'forged-record',
    },
  });
});
