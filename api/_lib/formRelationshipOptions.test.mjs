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
  const queries = [];
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.orders = [];
    }
    select(projection) { this.projection = projection; queries.push({ table: this.table, projection }); return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
    is(column, value) {
      this.filters.push((row) => (
        value === null ? row[column] == null : row[column] === value
      ));
      return this;
    }
    in(column, values) { this.filters.push((row) => values.includes(row[column])); return this; }
    order(column, { ascending = true } = {}) {
      this.orders.push({ column, ascending });
      queries.push({ table: this.table, order: { column, ascending } });
      return this;
    }
    range(from, to) { this.slice = [from, to + 1]; queries.push({ table: this.table, range: [from, to] }); return this; }
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
  return { from: (table) => new Query(table), queries };
}

function form(overrides = {}) {
  return {
    id: 'form-1',
    slug: 'application',
    tenant_id: tenantId,
    is_active: true,
    fields: [
      { id: 'org', type: 'organisation_dropdown', options: [] },
      {
        id: 'department',
        type: 'relationship_dropdown',
        options: [],
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

test('record-reference metadata accepts an explicit side on a visible self relationship', async () => {
  const objectId = 'self-object';
  const selfForm = {
    id: 'self-form',
    fields: [
      {
        id: 'parent-record', type: 'relationship_dropdown',
        related_kind: 'custom_object', related_custom_object_id: objectId,
      },
      {
        id: 'related-record', type: 'relationship_dropdown',
        parent_field_id: 'parent-record',
        relationship_definition_id: 'self-definition',
        relationship_parent_kind: 'custom_object',
        relationship_parent_custom_object_id: objectId,
        relationship_parent_side: 'source',
        related_kind: 'custom_object',
        related_custom_object_id: objectId,
        related_primary_display_field_id: 'self-name',
      },
    ],
  };
  const service = createFormRelationshipService({
    tenantId,
    db: mockDb({
      custom_object_relationship_definition: [{
        id: 'self-definition', tenant_id: tenantId, status: 'active',
        source_kind: 'custom_object', source_custom_object_id: objectId,
        target_kind: 'custom_object', target_custom_object_id: objectId,
        show_on_source: true, show_on_target: true,
      }],
      custom_object_definition: [{
        id: objectId, tenant_id: tenantId, status: 'active',
        primary_display_field_id: 'self-name',
      }],
      preference_field: [{
        id: 'self-name', tenant_id: tenantId, custom_object_id: objectId,
        entity_scope: 'custom_object', is_active: true,
      }],
    }),
  });
  const saved = await service.validateRecordReferencePicker({
    form: selfForm,
    rootForm: selfForm,
    fieldId: 'related-record',
  });
  assert.equal(saved.parent.side, 'source');
});

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

test('eligible discovery returns every active visible side with endpoint descriptors', async () => {
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
      preference_field: [{
        id: 'name-field',
        tenant_id: tenantId,
        custom_object_id: 'object-1',
        entity_scope: 'custom_object',
        is_active: true,
        name: 'name',
        label: 'Name',
        field_type: 'text',
      }, {
        id: 'tags-field',
        tenant_id: tenantId,
        custom_object_id: 'object-1',
        entity_scope: 'custom_object',
        is_active: true,
        name: 'tags',
        label: 'Tags',
        field_type: 'picklist',
      }],
      custom_object_role_permission: ['role-1', 'role-denied'].map(role_id => ({
        tenant_id: tenantId,
        custom_object_id: 'object-1',
        role_id,
        can_view_records: true,
      })),
      custom_object_field_role_permission: [{
        tenant_id: tenantId,
        custom_object_id: 'object-1',
        role_id: 'role-denied',
        field_id: 'name-field',
        access_level: 'none',
      }],
    }),
  });
  const result = await service.eligibleDefinitions('form-1');
  assert.deepEqual(result.data.map((item) => item.discovery_key), [
    'hidden:target', 'definition-1:source', 'definition-1:target',
  ]);
  assert.deepEqual(result.data.map((item) => ({
    parent: item.parent.kind, related: item.related.kind,
  })), [
    { parent: 'custom_object', related: 'organization' },
    { parent: 'organization', related: 'custom_object' },
    { parent: 'custom_object', related: 'organization' },
  ]);
  assert.equal(result.data[1].relationship_definition_id, 'definition-1');
  assert.equal(result.data[1].related_custom_object_id, 'object-1');
  assert.equal(result.data[1].custom_object.object_key, 'units');
  assert.deepEqual(result.custom_objects[0].fields.map(field => field.id), ['name-field']);
  const noGrant = await service.eligibleDefinitions('form-1', {
    isTenantUser: false,
    roleId: 'role-without-grant',
  });
  assert.deepEqual(noGrant.custom_objects, []);
  assert.deepEqual(noGrant.data, []);
  const granted = await service.eligibleDefinitions('form-1', {
    isTenantUser: false,
    roleId: 'role-1',
  });
  assert.deepEqual(granted.custom_objects.map(object => object.id), ['object-1']);
  const fieldDenied = await service.eligibleDefinitions('form-1', {
    isTenantUser: false,
    roleId: 'role-denied',
  });
  assert.deepEqual(fieldDenied.custom_objects, []);
  assert.deepEqual(fieldDenied.data, []);
});

test('saved relationship custom-object parents must match their persisted related descriptor', () => {
  const chained = form({
    fields: [
      { id: 'org', type: 'organisation_dropdown' },
      {
        id: 'department',
        type: 'relationship_dropdown',
        parent_field_id: 'org',
        relationship_definition_id: 'organization-department',
        relationship_parent_kind: 'organization',
        related_kind: 'custom_object',
        related_custom_object_id: 'department-object',
        related_primary_display_field_id: 'department-name',
      },
      {
        id: 'team',
        type: 'relationship_dropdown',
        parent_field_id: 'department',
        relationship_definition_id: 'department-team',
        relationship_parent_kind: 'custom_object',
        relationship_parent_custom_object_id: 'forged-object',
        related_kind: 'custom_object',
        related_custom_object_id: 'team-object',
        related_primary_display_field_id: 'team-name',
      },
    ],
  });
  assert.throws(
    () => savedRelationshipField(chained, 'team'),
    (error) => error instanceof FormRelationshipError
      && error.status === 409 && /parent is invalid/.test(error.message),
  );
  chained.fields[2].relationship_parent_custom_object_id = 'department-object';
  chained.fields[1].selection_mode = 'multiple';
  assert.throws(
    () => savedRelationshipField(chained, 'team'),
    (error) => error instanceof FormRelationshipError
      && error.status === 409 && /parent must be single-select/.test(error.message),
  );
  chained.fields[1].selection_mode = 'single';
  assert.equal(savedRelationshipField(chained, 'team').parent.custom_object_id, 'department-object');
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
    query: { all: true, page: '1', pageSize: '1' },
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

test('submission validation enforces relationship selection mode, uniqueness, and inclusive Other', async () => {
  const multiForm = form({
    fields: [
      { id: 'org', type: 'organisation_dropdown', options: [] },
      {
        ...form().fields[1],
        selection_mode: 'multiple',
        not_listed_choice: { enabled: true, label: 'Other department' },
      },
    ],
  });
  const service = createFormRelationshipService({
    tenantId,
    db: mockDb({
      organization: [{ id: 'org-1', tenant_id: tenantId }],
      custom_object_relationship_definition: [definition()],
      custom_object_definition: [{
        id: 'object-1', tenant_id: tenantId, status: 'active',
        primary_display_field_id: 'name-field',
      }],
      preference_field: [{
        id: 'name-field', tenant_id: tenantId, custom_object_id: 'object-1',
        entity_scope: 'custom_object', is_active: true, name: 'unit_name', field_type: 'text',
      }],
      custom_object_relationship: [
        {
          id: 'edge-1', tenant_id: tenantId, relationship_definition_id: 'definition-1',
          source_record_id: 'org-1', target_record_id: 'record-1', archived_at: null,
        },
        {
          id: 'edge-2', tenant_id: tenantId, relationship_definition_id: 'definition-1',
          source_record_id: 'org-1', target_record_id: 'record-2', archived_at: null,
        },
      ],
      custom_object_record: [
        { id: 'record-1', tenant_id: tenantId, custom_object_id: 'object-1', archived_at: null, data: { unit_name: 'One' } },
        { id: 'record-2', tenant_id: tenantId, custom_object_id: 'object-1', archived_at: null, data: { unit_name: 'Two' } },
      ],
    }),
  });
  await service.validateSubmission({
    form: multiForm,
    submissionData: {
      org: 'org-1',
      department: ['record-1', 'record-2', '__form_not_listed__'],
      __not_listed_choice_text: { department: 'Another department' },
    },
  });
  await service.validateSubmission({
    form: multiForm,
    submissionData: { org: 'org-1', department: [] },
  });
  await service.validateSubmission({
    form: multiForm,
    submissionData: {
      org: 'org-1',
      department: ['__form_not_listed__'],
      __not_listed_choice_text: { department: 'Another department' },
    },
  });
  await assert.rejects(
    service.validateSubmission({
      form: multiForm,
      submissionData: { org: 'org-1', department: 'record-1' },
    }),
    error => error.status === 400 && /selection mode/.test(error.message),
  );
  await assert.rejects(
    service.validateSubmission({
      form: multiForm,
      submissionData: {
        org: 'org-1',
        department: '__form_not_listed__',
        __not_listed_choice_text: { department: 'Another department' },
      },
    }),
    error => error.status === 400 && /selection mode/.test(error.message),
  );
  await assert.rejects(
    service.validateSubmission({
      form: multiForm,
      submissionData: { org: 'org-1', department: ['record-1', 'record-1'] },
    }),
    error => error.status === 400 && /Duplicate relationship/.test(error.message),
  );
  await assert.rejects(
    service.validateSubmission({
      form: form(),
      submissionData: { org: 'org-1', department: ['record-1'] },
    }),
    error => error.status === 400 && /selection mode/.test(error.message),
  );
});

test('submission validation ignores stale hidden relationship values but validates visible organisations', async () => {
  const hiddenForm = form({
    fields: [
      { id: 'show_group', type: 'text' },
      { id: 'org', type: 'organisation_dropdown', options: [] },
      form().fields[1],
    ],
    visibility_rules: [{
      trigger_field_id: 'show_group',
      operator: 'equals',
      value: 'no',
      action: 'hide',
      target_field_ids: ['department'],
    }],
  });
  const service = createFormRelationshipService({
    tenantId,
    db: mockDb({
      organization: [{ id: 'org-1', tenant_id: tenantId }],
    }),
  });
  const hiddenFieldIds = new Set(['department']);
  await service.validateSubmission({
    form: hiddenForm,
    submissionData: {
      show_group: 'no',
      org: 'org-1',
      department: 'stale-forged-record',
    },
    hiddenFieldIds,
  });
  await assert.rejects(
    service.validateSubmission({
      form: hiddenForm,
      submissionData: {
        show_group: 'yes',
        org: 'org-1',
        department: 'stale-forged-record',
      },
      hiddenFieldIds: new Set(),
    }),
    error => error instanceof FormRelationshipError && error.status === 409,
  );
});

test('visible Organisation and Department remain validated when a stale Group relationship is hidden', async () => {
  const chainedForm = form({
    fields: [
      { id: 'org', type: 'organisation_dropdown', options: [] },
      form().fields[1],
      {
        id: 'group',
        type: 'relationship_dropdown',
        parent_field_id: 'department',
        relationship_definition_id: 'definition-2',
        relationship_parent_kind: 'custom_object',
        relationship_parent_custom_object_id: 'object-1',
        related_kind: 'custom_object',
        related_custom_object_id: 'object-2',
        related_primary_display_field_id: 'group-name-field',
      },
    ],
  });
  const service = createFormRelationshipService({
    tenantId,
    db: mockDb({
      organization: [{ id: 'org-1', tenant_id: tenantId }],
      custom_object_relationship_definition: [
        definition(),
        definition({
          id: 'definition-2',
          relationship_key: 'department_groups',
          source_kind: 'custom_object',
          source_custom_object_id: 'object-1',
          target_kind: 'custom_object',
          target_custom_object_id: 'object-2',
        }),
      ],
      custom_object_definition: [
        {
          id: 'object-1', tenant_id: tenantId, status: 'active',
          primary_display_field_id: 'name-field',
        },
        {
          id: 'object-2', tenant_id: tenantId, status: 'active',
          primary_display_field_id: 'group-name-field',
        },
      ],
      preference_field: [
        {
          id: 'name-field', tenant_id: tenantId, custom_object_id: 'object-1',
          entity_scope: 'custom_object', is_active: true, name: 'department_name',
          field_type: 'text',
        },
        {
          id: 'group-name-field', tenant_id: tenantId, custom_object_id: 'object-2',
          entity_scope: 'custom_object', is_active: true, name: 'group_name',
          field_type: 'text',
        },
      ],
      custom_object_relationship: [{
        id: 'department-edge', tenant_id: tenantId, relationship_definition_id: 'definition-1',
        source_record_id: 'org-1', target_record_id: 'department-1', archived_at: null,
      }],
      custom_object_record: [{
        id: 'department-1', tenant_id: tenantId, custom_object_id: 'object-1',
        archived_at: null, data: { department_name: 'Operations' },
      }],
    }),
  });
  const submissionData = {
    org: 'org-1',
    department: 'department-1',
    group: 'stale-group',
  };
  await service.validateSubmission({
    form: chainedForm,
    submissionData,
    hiddenFieldIds: new Set(['group']),
  });
  await assert.rejects(
    service.validateSubmission({
      form: chainedForm,
      submissionData,
      hiddenFieldIds: new Set(),
    }),
    error => error instanceof FormRelationshipError
      && error.status === 400 && /Invalid relationship selection/.test(error.message),
  );
});

test('submission validation ignores hidden relationship not-listed text metadata', async () => {
  const hiddenForm = form({
    fields: [
      { id: 'org', type: 'organisation_dropdown', options: [] },
      {
        ...form().fields[1],
        not_listed_choice: { enabled: true, label: 'My department is not listed' },
      },
    ],
  });
  const service = createFormRelationshipService({
    tenantId,
    db: mockDb({ organization: [{ id: 'org-1', tenant_id: tenantId }] }),
  });
  await service.validateSubmission({
    form: hiddenForm,
    submissionData: {
      org: 'org-1',
      department: '__form_not_listed__',
      __not_listed_choice_text: { department: 'Stale hidden department' },
    },
    hiddenFieldIds: new Set(['department']),
  });
});

test('submission validation cache is isolated by saved relationship definition', async () => {
  const secondForm = form({
    id: 'form-2',
    fields: [
      form().fields[0],
      {
        ...form().fields[1],
        relationship_definition_id: 'definition-2',
      },
    ],
  });
  const service = createFormRelationshipService({
    tenantId,
    db: mockDb({
      organization: [{ id: 'org-1', tenant_id: tenantId }],
      custom_object_relationship_definition: [
        definition(),
        definition({ id: 'definition-2', relationship_key: 'other_units' }),
      ],
      custom_object_definition: [{
        id: 'object-1',
        tenant_id: tenantId,
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
        field_type: 'text',
      }],
      custom_object_relationship: [{
        id: 'edge-1',
        tenant_id: tenantId,
        relationship_definition_id: 'definition-1',
        source_record_id: 'org-1',
        target_record_id: 'record-1',
        archived_at: null,
      }],
      custom_object_record: [{
        id: 'record-1',
        tenant_id: tenantId,
        custom_object_id: 'object-1',
        archived_at: null,
        data: { unit_name: 'A unit' },
      }],
    }),
  });
  const cache = new Map();
  const submissionData = { org: 'org-1', department: 'record-1' };
  await service.validateSubmission({ form: form(), submissionData, cache });
  await assert.rejects(
    () => service.validateSubmission({ form: secondForm, submissionData, cache }),
    (error) => error.status === 400 && /Invalid relationship selection/.test(error.message),
  );
});

test('submission validation accepts configured not-listed choices and rejects forged or mixed sentinels', async () => {
  const configuredForm = form({
    fields: [
      {
        id: 'org',
        type: 'organisation_dropdown',
        not_listed_choice: { enabled: true, label: 'My organisation is not listed' },
      },
      {
        ...form().fields[1],
        not_listed_choice: { enabled: true, label: 'My department is not listed' },
      },
      {
        id: 'countries',
        type: 'countries',
        not_listed_choice: { enabled: true, label: 'My country is not listed' },
      },
    ],
  });
  const service = createFormRelationshipService({
    tenantId,
    db: mockDb({ form: [configuredForm] }),
  });

  await service.validateSubmission({
    form: configuredForm,
    submissionData: {
      org: '__form_not_listed__',
      department: '__form_not_listed__',
      countries: ['__form_not_listed__'],
      __not_listed_choice_text: {
        org: 'Acme Ltd',
        department: 'Operations',
        countries: 'Atlantis',
      },
    },
  });

  await assert.rejects(
    () => service.validateSubmission({
      form: form(),
      submissionData: {
        org: '__form_not_listed__',
        __not_listed_choice_text: { org: 'Acme Ltd' },
      },
    }),
    (error) => error.status === 400 && /Invalid not-listed selection/.test(error.message),
  );

  await assert.rejects(
    () => service.validateSubmission({
      form: configuredForm,
      submissionData: {
        countries: ['__form_not_listed__', 'France'],
        __not_listed_choice_text: { countries: 'Atlantis' },
      },
    }),
    (error) => error.status === 400 && /exclusive/.test(error.message),
  );
});

test('submission validation requires valid, authoritative not-listed text before entity lookups', async () => {
  const configuredForm = form({
    fields: [{
      id: 'org',
      type: 'organisation_dropdown',
      not_listed_choice: { enabled: true, label: 'My organisation is not listed' },
    }],
  });
  let lookups = 0;
  const noLookupDb = {
    from() {
      lookups += 1;
      throw new Error('not-listed validation must precede database lookups');
    },
  };
  const service = createFormRelationshipService({ tenantId, db: noLookupDb });

  await service.validateSubmission({
    form: configuredForm,
    submissionData: {
      org: '__form_not_listed__',
      __not_listed_choice_text: { org: 'Acme Ltd' },
    },
  });
  assert.equal(lookups, 0);

  for (const [submissionData, message] of [
    [{ org: '__form_not_listed__' }, 'Please specify the not-listed value'],
    [{
      org: '__form_not_listed__',
      __not_listed_choice_text: { org: 'x'.repeat(501) },
    }, '500 characters or fewer'],
    [{
      org: 'ordinary-org',
      __not_listed_choice_text: { org: 'Acme Ltd' },
    }, 'must match a not-listed selection'],
    [{
      org: '__form_not_listed__',
      __not_listed_choice_text: { forged: 'Acme Ltd' },
    }, 'Invalid not-listed text'],
    [{
      org: '__form_not_listed__',
      __not_listed_choice_text: ['Acme Ltd'],
    }, 'Invalid not-listed text'],
  ]) {
    await assert.rejects(
      service.validateSubmission({ form: configuredForm, submissionData }),
      error => error instanceof FormRelationshipError
        && error.status === 400 && error.message.includes(message),
    );
  }
  assert.equal(lookups, 0);
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

test('submission validation enforces conditional organisation rules and saved eligibility', async () => {
  const savedForm = form({
    fields: [
      { id: 'country', type: 'dropdown', options: ['GB', 'US'] },
      {
        id: 'org',
        type: 'organisation_dropdown',
        options: [],
        org_filter: { type: 'core', field: 'is_active', values: ['true'] },
        conditional_filters: {
          version: 1,
          rules: [{
            id: 'approved-gb',
            source_field_id: 'country',
            operator: 'equals',
            value: 'GB',
            is_fallback: false,
            allowed_values: [],
            org_filter: { type: 'core', field: 'status', values: ['approved'] },
          }],
        },
      },
    ],
  });
  const service = createFormRelationshipService({
    db: mockDb({ organization: [
      { id: 'eligible', tenant_id: tenantId, is_active: true, status: 'approved' },
      { id: 'stale', tenant_id: tenantId, is_active: true, status: 'suspended' },
      { id: 'inactive', tenant_id: tenantId, is_active: false, status: 'approved' },
    ] }),
    tenantId,
  });
  await service.validateSubmission({
    form: savedForm,
    submissionData: { country: 'GB', org: 'eligible' },
  });
  await assert.rejects(
    service.validateSubmission({
      form: savedForm,
      submissionData: { country: 'GB', org: 'stale' },
    }),
    (error) => error instanceof FormRelationshipError && error.status === 400,
  );
  await assert.rejects(
    service.validateSubmission({
      form: savedForm,
      submissionData: { country: 'GB', org: 'inactive' },
    }),
    (error) => error instanceof FormRelationshipError && error.status === 400,
  );
  await assert.rejects(
    service.validateSubmission({
      form: savedForm,
      submissionData: { country: 'US', org: 'eligible' },
    }),
    (error) => error instanceof FormRelationshipError && error.status === 400,
  );
});

test('server-created organisations bypass eligibility only for the exact trusted field and ID', async () => {
  const configuredForm = form({
    fields: [
      { id: 'country', type: 'dropdown', options: ['GB'] },
      {
        id: 'org',
        type: 'organisation_dropdown',
        options: [],
        not_listed_choice: { enabled: true, label: 'My organisation is not listed' },
        org_filter: { type: 'core', field: 'is_active', values: ['true'] },
        conditional_filters: {
          version: 1,
          rules: [{
            id: 'approved-gb',
            source_field_id: 'country',
            operator: 'equals',
            value: 'GB',
            is_fallback: false,
            allowed_values: [],
            org_filter: { type: 'core', field: 'status', values: ['approved'] },
          }],
        },
      },
    ],
  });
  const service = createFormRelationshipService({
    tenantId,
    db: mockDb({
      organization: [
        {
          id: 'new-org', tenant_id: tenantId, is_active: false, status: 'suspended',
        },
        {
          id: 'other-org', tenant_id: tenantId, is_active: false, status: 'suspended',
        },
        {
          id: 'foreign-org', tenant_id: 'tenant-2', is_active: false, status: 'suspended',
        },
      ],
    }),
  });

  await service.validateSubmission({
    form: configuredForm,
    submissionData: { country: 'GB', org: 'new-org' },
    serverCreatedOrganizations: new Map([['org', 'new-org']]),
  });

  for (const [submissionData, serverCreatedOrganizations] of [
    [
      { country: 'GB', org: 'new-org' },
      new Map([['wrong-field', 'new-org']]),
    ],
    [
      { country: 'GB', org: 'new-org' },
      new Map([['org', 'wrong-org']]),
    ],
    [
      { country: 'GB', org: 'new-org' },
      JSON.parse(JSON.stringify({ org: 'new-org' })),
    ],
    [
      { country: 'GB', org: 'other-org' },
      new Map([['org', 'new-org']]),
    ],
    [
      { country: 'GB', org: 'foreign-org' },
      new Map([['org', 'foreign-org']]),
    ],
    [
      { country: 'GB', org: 'missing-org' },
      new Map([['org', 'missing-org']]),
    ],
  ]) {
    await assert.rejects(
      service.validateSubmission({
        form: configuredForm,
        submissionData,
        serverCreatedOrganizations,
      }),
      error => error instanceof FormRelationshipError && error.status === 400,
    );
  }
});

test('a Department under a trusted server-created organisation still requires valid persisted relationship state', async () => {
  const configuredForm = form({
    fields: [
      {
        id: 'org',
        type: 'organisation_dropdown',
        options: [],
        not_listed_choice: { enabled: true, label: 'My organisation is not listed' },
        org_filter: { type: 'core', field: 'is_active', values: ['true'] },
      },
      form().fields[1],
    ],
  });
  const validDefinition = definition();
  const validEdge = {
    id: 'edge-1',
    tenant_id: tenantId,
    relationship_definition_id: 'definition-1',
    source_record_id: 'new-org',
    target_record_id: 'department-1',
    archived_at: null,
  };
  const validDepartment = {
    id: 'department-1',
    tenant_id: tenantId,
    custom_object_id: 'object-1',
    archived_at: null,
    data: { department_name: 'Operations' },
  };
  const baseSeed = {
    organization: [{
      id: 'new-org',
      tenant_id: tenantId,
      is_active: false,
    }],
    custom_object_relationship_definition: [validDefinition],
    custom_object_definition: [{
      id: 'object-1',
      tenant_id: tenantId,
      status: 'active',
      primary_display_field_id: 'name-field',
    }],
    preference_field: [{
      id: 'name-field',
      tenant_id: tenantId,
      custom_object_id: 'object-1',
      entity_scope: 'custom_object',
      is_active: true,
      name: 'department_name',
      field_type: 'text',
    }],
    custom_object_relationship: [validEdge],
    custom_object_record: [validDepartment],
  };
  const validate = (seed = baseSeed) => createFormRelationshipService({
    tenantId,
    db: mockDb(seed),
  }).validateSubmission({
    form: configuredForm,
    submissionData: { org: 'new-org', department: 'department-1' },
    serverCreatedOrganizations: new Map([['org', 'new-org']]),
  });

  await validate();

  for (const seed of [
    {
      ...baseSeed,
      custom_object_relationship_definition: [{ ...validDefinition, status: 'draft' }],
    },
    {
      ...baseSeed,
      custom_object_relationship_definition: [{
        ...validDefinition,
        target_custom_object_id: 'different-object',
      }],
    },
  ]) {
    await assert.rejects(
      validate(seed),
      error => error instanceof FormRelationshipError && error.status === 409,
    );
  }

  for (const seed of [
    {
      ...baseSeed,
      custom_object_relationship: [{ ...validEdge, archived_at: '2025-01-01T00:00:00Z' }],
    },
    {
      ...baseSeed,
      custom_object_relationship: [],
    },
    {
      ...baseSeed,
      custom_object_record: [{ ...validDepartment, archived_at: '2025-01-01T00:00:00Z' }],
    },
    {
      ...baseSeed,
      custom_object_record: [{ ...validDepartment, tenant_id: 'tenant-2' }],
    },
    {
      ...baseSeed,
      custom_object_record: [{ ...validDepartment, custom_object_id: 'different-object' }],
    },
  ]) {
    await assert.rejects(
      validate(seed),
      error => error instanceof FormRelationshipError
        && error.status === 400 && /Invalid relationship selection/.test(error.message),
    );
  }
});

test('submission validation rejects excluded organisation IDs and organisation field values', async () => {
  const savedForm = form({
    fields: [
      { id: 'country', type: 'dropdown', options: ['GB'] },
      {
        id: 'org',
        type: 'organisation_dropdown',
        options: [],
        conditional_filters: {
          version: 1,
          rules: [{
            id: 'exclude',
            source_field_id: 'country',
            operator: 'equals',
            value: 'GB',
            is_fallback: false,
            allowed_values: ['blocked-id'],
            allowed_values_mode: 'exclude',
            org_filter: {
              type: 'core',
              field: 'country',
              values: ['Spain'],
              mode: 'exclude',
            },
          }],
        },
      },
    ],
  });
  const service = createFormRelationshipService({
    db: mockDb({ organization: [
      { id: 'eligible', tenant_id: tenantId, country: 'Portugal' },
      { id: 'blocked-id', tenant_id: tenantId, country: 'Portugal' },
      { id: 'blocked-country', tenant_id: tenantId, country: 'Spain' },
    ] }),
    tenantId,
  });
  await service.validateSubmission({
    form: savedForm,
    submissionData: { country: 'GB', org: 'eligible' },
  });
  for (const org of ['blocked-id', 'blocked-country']) {
    await assert.rejects(
      service.validateSubmission({
        form: savedForm,
        submissionData: { country: 'GB', org },
      }),
      (error) => error instanceof FormRelationshipError && error.status === 400,
    );
  }
});

test('submission validation fails closed for malformed empty standalone organisation filters', async () => {
  const savedForm = form({
    fields: [{
      id: 'org',
      type: 'organisation_dropdown',
      org_filter: {
        type: 'core',
        field: 'country',
        values: [],
        mode: 'forged',
      },
    }],
  });
  const service = createFormRelationshipService({
    db: mockDb({ organization: [
      { id: 'org-1', tenant_id: tenantId, country: 'Portugal' },
    ] }),
    tenantId,
  });
  await assert.rejects(
    service.validateSubmission({
      form: savedForm,
      submissionData: { org: 'org-1' },
    }),
    (error) => error instanceof FormRelationshipError && error.status === 400,
  );

  savedForm.fields[0].org_filter.mode = 'exclude';
  await service.validateSubmission({
    form: savedForm,
    submissionData: { org: 'org-1' },
  });
});

test('repeatable Custom Object record sources use only persisted filters and return stable record IDs', async () => {
  const ids = {
    container: '00000000-0000-4000-8000-000000000001',
    dependency: '00000000-0000-4000-8000-000000000002',
    picker: '00000000-0000-4000-8000-000000000003',
    object: '00000000-0000-4000-8000-000000000004',
    primary: '00000000-0000-4000-8000-000000000005',
    manufacturer: '00000000-0000-4000-8000-000000000006',
  };
  const picker = {
    id: ids.picker,
    type: 'relationship_dropdown',
    option_source: {
      version: 1,
      kind: 'records',
      custom_object_id: ids.object,
      primary_display_field_id: ids.primary,
      filters: [{ field_id: ids.manufacturer, source_field_id: ids.dependency }],
    },
  };
  const rootForm = {
    id: 'row-source-form',
    fields: [{
      id: ids.container,
      type: 'repeatable_rows',
      children: [
        { id: ids.dependency, type: 'text' },
        picker,
      ],
    }],
  };
  const db = mockDb({
    custom_object_definition: [{
      id: ids.object, tenant_id: tenantId, status: 'active',
      primary_display_field_id: ids.primary,
    }],
    preference_field: [
      {
        id: ids.primary, tenant_id: tenantId, custom_object_id: ids.object,
        entity_scope: 'custom_object', is_active: true, name: 'name', field_type: 'text',
      },
      {
        id: ids.manufacturer, tenant_id: tenantId, custom_object_id: ids.object,
        entity_scope: 'custom_object', is_active: true, name: 'manufacturer', field_type: 'text',
      },
    ],
    custom_object_record: [
      { id: 'record-z', tenant_id: tenantId, custom_object_id: ids.object, archived_at: null, data: { name: 'Zulu', manufacturer: 'Acme' } },
      { id: 'record-a', tenant_id: tenantId, custom_object_id: ids.object, archived_at: null, data: { name: 'Alpha', manufacturer: 'Acme' } },
      { id: 'record-other', tenant_id: tenantId, custom_object_id: ids.object, archived_at: null, data: { name: 'Other', manufacturer: 'Other' } },
      { id: 'record-archived', tenant_id: tenantId, custom_object_id: ids.object, archived_at: '2026-01-01', data: { name: 'Archived', manufacturer: 'Acme' } },
      { id: 'record-foreign', tenant_id: 'tenant-2', custom_object_id: ids.object, archived_at: null, data: { name: 'Foreign', manufacturer: 'Acme' } },
    ],
  });
  const virtualRows = { ...rootForm, fields: rootForm.fields[0].children };
  const service = createFormRelationshipService({ db, tenantId });
  const result = await service.relationshipOptions({
    form: virtualRows,
    rootForm,
    containerFieldId: ids.container,
    fieldId: ids.picker,
    dependencyAnswers: { [ids.dependency]: 'Acme' },
    query: { page: 1, pageSize: 1 },
  });
  assert.deepEqual(result, {
    data: [{ id: 'record-a', label: 'Alpha' }],
    total: 2,
    page: 1,
    pageSize: 1,
  });
  const recordProjection = db.queries.find(query => (
    query.table === 'custom_object_record' && query.projection
  ))?.projection;
  assert.match(recordProjection, /^id, source_value_0:data->name, source_value_1:data->manufacturer$/);
  assert.doesNotMatch(recordProjection, /(?:^|, )data(?:,|$)/);
  assert.ok(db.queries.filter(query => query.table === 'custom_object_record' && query.range)
    .every(query => query.range[1] - query.range[0] + 1 <= 100));
  await service.validateSubmission({
    form: virtualRows,
    rootForm,
    containerFieldId: ids.container,
    submissionData: { [ids.dependency]: 'Acme', [ids.picker]: 'record-z' },
  });
  await assert.rejects(
    service.validateSubmission({
      form: virtualRows,
      rootForm,
      containerFieldId: ids.container,
      submissionData: { [ids.dependency]: 'Acme', [ids.picker]: 'record-other' },
    }),
    error => error.status === 400 && /Invalid Custom Object/.test(error.message),
  );
});

test('distinct row sources return unique nonblank scalar values from active related records', async () => {
  const id = suffix => `10000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
  const containerId = id(1);
  const parentFieldId = id(2);
  const distinctFieldId = id(3);
  const parentObjectId = id(4);
  const sourceObjectId = id(5);
  const parentPrimaryId = id(6);
  const sourcePrimaryId = id(7);
  const valueFieldId = id(8);
  const relationshipId = id(9);
  const parent = {
    id: parentFieldId,
    type: 'relationship_dropdown',
    option_source: {
      version: 1,
      kind: 'records',
      custom_object_id: parentObjectId,
      primary_display_field_id: parentPrimaryId,
      filters: [],
    },
  };
  const distinct = {
    id: distinctFieldId,
    type: 'relationship_dropdown',
    parent_field_id: parentFieldId,
    relationship_definition_id: relationshipId,
    relationship_parent_kind: 'custom_object',
    relationship_parent_custom_object_id: parentObjectId,
    relationship_parent_side: 'source',
    related_kind: 'custom_object',
    option_source: {
      version: 1,
      kind: 'distinct',
      custom_object_id: sourceObjectId,
      primary_display_field_id: sourcePrimaryId,
      value_field_id: valueFieldId,
      filters: [],
    },
  };
  const rootForm = {
    fields: [{
      id: containerId,
      type: 'repeatable_rows',
      children: [parent, distinct],
    }],
  };
  const db = mockDb({
    custom_object_definition: [
      { id: parentObjectId, tenant_id: tenantId, status: 'active', primary_display_field_id: parentPrimaryId },
      { id: sourceObjectId, tenant_id: tenantId, status: 'active', primary_display_field_id: sourcePrimaryId },
    ],
    preference_field: [
      { id: sourcePrimaryId, tenant_id: tenantId, custom_object_id: sourceObjectId, entity_scope: 'custom_object', is_active: true, name: 'name', field_type: 'text' },
      { id: valueFieldId, tenant_id: tenantId, custom_object_id: sourceObjectId, entity_scope: 'custom_object', is_active: true, name: 'maker', field_type: 'text' },
    ],
    custom_object_relationship_definition: [{
      id: relationshipId,
      tenant_id: tenantId,
      status: 'active',
      source_kind: 'custom_object',
      source_custom_object_id: parentObjectId,
      target_kind: 'custom_object',
      target_custom_object_id: sourceObjectId,
      show_on_source: true,
    }],
    custom_object_record: [
      { id: 'type-1', tenant_id: tenantId, custom_object_id: parentObjectId, archived_at: null, data: {} },
      { id: 'model-1', tenant_id: tenantId, custom_object_id: sourceObjectId, archived_at: null, data: { name: 'One', maker: 'Acme' } },
      { id: 'model-2', tenant_id: tenantId, custom_object_id: sourceObjectId, archived_at: null, data: { name: 'Two', maker: 'Acme' } },
      { id: 'model-3', tenant_id: tenantId, custom_object_id: sourceObjectId, archived_at: null, data: { name: 'Three', maker: '' } },
      { id: 'model-4', tenant_id: tenantId, custom_object_id: sourceObjectId, archived_at: null, data: { name: 'Four', maker: 'Beta' } },
    ],
    custom_object_relationship: [
      { id: 'edge-1', tenant_id: tenantId, relationship_definition_id: relationshipId, source_record_id: 'type-1', target_record_id: 'model-1', archived_at: null },
      { id: 'edge-2', tenant_id: tenantId, relationship_definition_id: relationshipId, source_record_id: 'type-1', target_record_id: 'model-2', archived_at: null },
      { id: 'edge-3', tenant_id: tenantId, relationship_definition_id: relationshipId, source_record_id: 'type-1', target_record_id: 'model-3', archived_at: null },
      { id: 'edge-4', tenant_id: tenantId, relationship_definition_id: relationshipId, source_record_id: 'other-type', target_record_id: 'model-4', archived_at: null },
    ],
  });
  const result = await createFormRelationshipService({ db, tenantId }).relationshipOptions({
    form: { ...rootForm, fields: [parent, distinct] },
    rootForm,
    containerFieldId: containerId,
    fieldId: distinctFieldId,
    dependencyAnswers: { [parentFieldId]: 'type-1' },
  });
  assert.deepEqual(result.data, [{ id: 'Acme', label: 'Acme' }]);
});

test('row source scans are query-bounded and fail closed beyond the server cap', async () => {
  const id = suffix => `30000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
  const rootForm = {
    fields: [{
      id: id(1),
      type: 'repeatable_rows',
      children: [{
        id: id(2),
        type: 'relationship_dropdown',
        option_source: {
          version: 1,
          kind: 'records',
          custom_object_id: id(3),
          primary_display_field_id: id(4),
          filters: [],
        },
      }],
    }],
  };
  const db = mockDb({
    custom_object_definition: [{
      id: id(3), tenant_id: tenantId, status: 'active', archived_at: null,
      primary_display_field_id: id(4),
    }],
    preference_field: [{
      id: id(4), tenant_id: tenantId, custom_object_id: id(3),
      entity_scope: 'custom_object', is_active: true, name: 'name', field_type: 'text',
    }],
    custom_object_record: Array.from({ length: 5100 }, (_, index) => ({
      id: `record-${index}`,
      tenant_id: tenantId,
      custom_object_id: id(3),
      archived_at: null,
      data: { name: `Record ${index}` },
    })),
  });
  await assert.rejects(
    createFormRelationshipService({ db, tenantId }).relationshipOptions({
      form: { ...rootForm, fields: rootForm.fields[0].children },
      rootForm,
      containerFieldId: id(1),
      fieldId: id(2),
      dependencyAnswers: {},
    }),
    error => error.status === 409 && /too many records/.test(error.message),
  );
  const ranges = db.queries.filter(query => (
    query.table === 'custom_object_record' && query.range
  )).map(query => query.range);
  assert.ok(ranges.every(([from, to]) => to - from + 1 <= 100));
  assert.equal(ranges.at(-1)[1], 5000);
});

test('row sources reject archived objects, inactive fields, and collection-valued picklist filters', async () => {
  const id = suffix => `40000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
  const child = {
    id: id(3),
    type: 'relationship_dropdown',
    option_source: {
      version: 1,
      kind: 'records',
      custom_object_id: id(4),
      primary_display_field_id: id(5),
      filters: [{ field_id: id(6), source_field_id: id(2) }],
    },
  };
  const rootForm = {
    fields: [{
      id: id(1),
      type: 'repeatable_rows',
      children: [{ id: id(2), type: 'text' }, child],
    }],
  };
  const validate = seed => createFormRelationshipService({
    db: mockDb(seed),
    tenantId,
  }).validatePersistedRowSource({
    form: rootForm,
    fieldId: id(3),
    containerFieldId: id(1),
  });
  const fields = [
    {
      id: id(5), tenant_id: tenantId, custom_object_id: id(4),
      entity_scope: 'custom_object', is_active: true, name: 'name', field_type: 'text',
    },
    {
      id: id(6), tenant_id: tenantId, custom_object_id: id(4),
      entity_scope: 'custom_object', is_active: true, name: 'tags', field_type: 'picklist',
    },
  ];
  await assert.rejects(
    validate({
      custom_object_definition: [{
        id: id(4), tenant_id: tenantId, status: 'active',
        archived_at: null, primary_display_field_id: id(5),
      }],
      preference_field: fields,
    }),
    error => error.status === 409 && /not scalar/.test(error.message),
  );
  await assert.rejects(
    validate({
      custom_object_definition: [{
        id: id(4), tenant_id: tenantId, status: 'active',
        archived_at: '2026-01-01', primary_display_field_id: id(5),
      }],
    }),
    error => error.status === 409 && /source is unavailable/.test(error.message),
  );
  await assert.rejects(
    validate({
      custom_object_definition: [{
        id: id(4), tenant_id: tenantId, status: 'active',
        archived_at: null, primary_display_field_id: id(5),
      }],
      preference_field: fields.map(field => (
        field.id === id(6) ? { ...field, field_type: 'text', is_active: false } : field
      )),
    }),
    error => error.status === 409 && /field is unavailable/.test(error.message),
  );
});

test('row source configuration enforces single selection and typed filter domains', async () => {
  const id = suffix => `50000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
  const child = {
    id: id(3),
    type: 'relationship_dropdown',
    option_source: {
      version: 1,
      kind: 'records',
      custom_object_id: id(4),
      primary_display_field_id: id(5),
      filters: [{ field_id: id(6), source_field_id: id(2) }],
    },
  };
  const makeForm = picker => ({
    fields: [{
      id: id(1), type: 'repeatable_rows',
      children: [{ id: id(2), type: 'text' }, picker],
    }],
  });
  const seed = {
    custom_object_definition: [{
      id: id(4), tenant_id: tenantId, status: 'active', archived_at: null,
      primary_display_field_id: id(5),
    }],
    preference_field: [
      { id: id(5), tenant_id: tenantId, custom_object_id: id(4), entity_scope: 'custom_object', is_active: true, name: 'name', field_type: 'text' },
      { id: id(6), tenant_id: tenantId, custom_object_id: id(4), entity_scope: 'custom_object', is_active: true, name: 'amount', field_type: 'number' },
    ],
  };
  for (const picker of [
    child,
    { ...child, selection_mode: 'multiple' },
  ]) {
    const expected = picker.selection_mode === 'multiple' ? /single-select/ : /types are incompatible/;
    await assert.rejects(
      createFormRelationshipService({ db: mockDb(seed), tenantId })
        .validatePersistedRowSource({
          form: makeForm(picker), fieldId: id(3), containerFieldId: id(1),
        }),
      error => error.status === 409 && expected.test(error.message),
    );
  }
});

test('filter domains use authoritative custom-field metadata and shared scalar semantics', async () => {
  const id = suffix => `51000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
  const picker = {
    id: id(3),
    type: 'relationship_dropdown',
    option_source: {
      version: 1,
      kind: 'records',
      custom_object_id: id(4),
      primary_display_field_id: id(5),
      filters: [{ field_id: id(6), source_field_id: id(2) }],
    },
  };
  const validate = ({
    dependency, targetType, customFieldType,
    customFieldTenant = tenantId, customFieldActive = true,
  }) => {
    const preferenceFields = [
      { id: id(5), tenant_id: tenantId, custom_object_id: id(4), entity_scope: 'custom_object', is_active: true, name: 'name', field_type: 'text' },
      { id: id(6), tenant_id: tenantId, custom_object_id: id(4), entity_scope: 'custom_object', is_active: true, name: 'value', field_type: targetType },
    ];
    if (customFieldType) {
      preferenceFields.push({
        id: id(7), tenant_id: customFieldTenant, is_active: customFieldActive, field_type: customFieldType,
      });
    }
    const form = {
      fields: [{
        id: id(1), type: 'repeatable_rows',
        children: [dependency, picker],
      }],
    };
    return createFormRelationshipService({
      tenantId,
      db: mockDb({
        custom_object_definition: [{
          id: id(4), tenant_id: tenantId, status: 'active', archived_at: null,
          primary_display_field_id: id(5),
        }],
        preference_field: preferenceFields,
      }),
    }).validatePersistedRowSource({
      form, fieldId: id(3), containerFieldId: id(1),
    });
  };

  await validate({
    dependency: { id: id(2), type: 'custom_field', custom_field_id: id(7) },
    targetType: 'percentage',
    customFieldType: 'percentage',
  });
  await assert.rejects(
    validate({
      dependency: {
        id: id(2), type: 'custom_field', custom_field_id: id(7),
        custom_field_type: 'percentage',
      },
      targetType: 'percentage',
      customFieldType: 'time',
    }),
    error => error.status === 409 && /types are incompatible/.test(error.message),
  );
  for (const metadata of [
    {},
    { customFieldType: 'percentage', customFieldTenant: 'tenant-2' },
    { customFieldType: 'percentage', customFieldActive: false },
  ]) {
    await assert.rejects(
      validate({
        dependency: { id: id(2), type: 'custom_field', custom_field_id: id(7) },
        targetType: 'percentage',
        ...metadata,
      }),
      error => error.status === 409 && /types are incompatible/.test(error.message),
    );
  }
  await assert.rejects(
    validate({
      dependency: { id: id(2), type: 'date' },
      targetType: 'time',
    }),
    error => error.status === 409 && /types are incompatible/.test(error.message),
  );
  await validate({
    dependency: { id: id(2), type: 'number' },
    targetType: 'percentage',
  });
});

test('numeric cascade rejects blank dependencies and blank catalogue values without rejecting real zero', async () => {
  const id = n => `52000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const picker = {
    id: id(3), type: 'relationship_dropdown',
    option_source: {
      version: 1, kind: 'records', custom_object_id: id(4),
      primary_display_field_id: id(5),
      filters: [{ field_id: id(6), source_field_id: id(2) }],
    },
  };
  const container = {
    id: id(1), type: 'repeatable_rows',
    children: [{ id: id(2), type: 'number', required: false }, picker],
  };
  const form = { fields: [container] };
  const service = createFormRelationshipService({
    tenantId,
    db: mockDb({
      custom_object_definition: [{
        id: id(4), tenant_id: tenantId, status: 'active', archived_at: null,
        primary_display_field_id: id(5),
      }],
      preference_field: [
        { id: id(5), tenant_id: tenantId, custom_object_id: id(4), entity_scope: 'custom_object', is_active: true, name: 'name', field_type: 'text' },
        { id: id(6), tenant_id: tenantId, custom_object_id: id(4), entity_scope: 'custom_object', is_active: true, name: 'amount', field_type: 'number' },
      ],
      custom_object_record: [
        { id: id(7), tenant_id: tenantId, custom_object_id: id(4), archived_at: null, data: { name: 'Zero', amount: 0 } },
        { id: id(8), tenant_id: tenantId, custom_object_id: id(4), archived_at: null, data: { name: 'Blank', amount: ' \t' } },
      ],
    }),
  });
  for (const answer of [' ', '\t\n', '', null, undefined, false]) {
    const options = await service.relationshipOptions({
      form, fieldId: picker.id, containerFieldId: container.id,
      dependencyAnswers: { [id(2)]: answer }, query: { all: true },
    });
    assert.deepEqual(options.data, []);
    await assert.rejects(service.validateSubmission({
      form: { fields: container.children }, rootForm: form, containerFieldId: container.id,
      submissionData: { [id(2)]: answer, [picker.id]: id(7) },
    }), error => error.status === 400);
  }
  for (const answer of [0, '0', ' 0 ']) {
    const options = await service.relationshipOptions({
      form, fieldId: picker.id, containerFieldId: container.id,
      dependencyAnswers: { [id(2)]: answer }, query: { all: true },
    });
    assert.deepEqual(options.data.map(option => option.id), [id(7)]);
    await service.validateSubmission({
      form: { fields: container.children }, rootForm: form, containerFieldId: container.id,
      submissionData: { [id(2)]: answer, [picker.id]: id(7) },
    });
  }
});

test('direct record row sources are valid record-reference picker metadata', async () => {
  const id = suffix => `60000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
  const picker = {
    id: id(2),
    type: 'relationship_dropdown',
    option_source: {
      version: 1, kind: 'records', custom_object_id: id(3),
      primary_display_field_id: id(4), filters: [],
    },
  };
  const rootForm = {
    fields: [{ id: id(1), type: 'repeatable_rows', children: [picker] }],
  };
  const metadata = await createFormRelationshipService({
    tenantId,
    db: mockDb({
      custom_object_definition: [{
        id: id(3), tenant_id: tenantId, status: 'active', archived_at: null,
        primary_display_field_id: id(4),
      }],
      preference_field: [{
        id: id(4), tenant_id: tenantId, custom_object_id: id(3),
        entity_scope: 'custom_object', is_active: true, name: 'name', field_type: 'text',
      }],
    }),
  }).validateRecordReferencePicker({
    form: rootForm,
    rootForm,
    containerFieldId: id(1),
    fieldId: id(2),
  });
  assert.equal(metadata.optionSourceKind, 'records');
  assert.equal(metadata.related.custom_object_id, id(3));
});

test('submission validation resolves a paginated source only once for a forged value', async () => {
  const id = suffix => `70000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
  const picker = {
    id: id(2),
    type: 'relationship_dropdown',
    option_source: {
      version: 1, kind: 'records', custom_object_id: id(3),
      primary_display_field_id: id(4), filters: [],
    },
  };
  const rootForm = {
    fields: [{ id: id(1), type: 'repeatable_rows', children: [picker] }],
  };
  const db = mockDb({
    custom_object_definition: [{
      id: id(3), tenant_id: tenantId, status: 'active', archived_at: null,
      primary_display_field_id: id(4),
    }],
    preference_field: [{
      id: id(4), tenant_id: tenantId, custom_object_id: id(3),
      entity_scope: 'custom_object', is_active: true, name: 'name', field_type: 'text',
    }],
    custom_object_record: Array.from({ length: 250 }, (_, index) => ({
      id: `record-${index}`, tenant_id: tenantId, custom_object_id: id(3),
      archived_at: null, data: { name: `Record ${index}` },
    })),
  });
  await assert.rejects(
    createFormRelationshipService({ db, tenantId }).validateSubmission({
      form: { ...rootForm, fields: [picker] },
      rootForm,
      containerFieldId: id(1),
      submissionData: { [id(2)]: 'forged-record' },
    }),
    error => error.status === 400 && /Invalid Custom Object/.test(error.message),
  );
  assert.equal(db.queries.filter(query => (
    query.table === 'custom_object_record' && query.range
  )).length, 3);
});

test('all mode returns one complete deterministically ordered bounded row-source scan', async () => {
  const id = suffix => `80000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
  const picker = {
    id: id(2),
    type: 'relationship_dropdown',
    option_source: {
      version: 1, kind: 'records', custom_object_id: id(3),
      primary_display_field_id: id(4), filters: [],
    },
  };
  const rootForm = {
    fields: [{ id: id(1), type: 'repeatable_rows', children: [picker] }],
  };
  const db = mockDb({
    custom_object_definition: [{
      id: id(3), tenant_id: tenantId, status: 'active', archived_at: null,
      primary_display_field_id: id(4),
    }],
    preference_field: [{
      id: id(4), tenant_id: tenantId, custom_object_id: id(3),
      entity_scope: 'custom_object', is_active: true, name: 'name', field_type: 'text',
    }],
    custom_object_record: Array.from({ length: 250 }, (_, index) => ({
      id: `record-${String(249 - index).padStart(3, '0')}`,
      tenant_id: tenantId,
      custom_object_id: id(3),
      archived_at: null,
      data: { name: 'Same label' },
    })),
  });
  const result = await createFormRelationshipService({ db, tenantId }).relationshipOptions({
    form: { ...rootForm, fields: [picker] },
    rootForm,
    containerFieldId: id(1),
    fieldId: id(2),
    dependencyAnswers: {},
    query: { all: true, page: 99, pageSize: 1 },
  });
  assert.equal(result.data.length, 250);
  assert.equal(result.total, 250);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 5000);
  assert.deepEqual(result.data.slice(0, 2).map(option => option.id), ['record-000', 'record-001']);
  assert.equal(db.queries.filter(query => (
    query.table === 'custom_object_record' && query.range
  )).length, 3);
  assert.ok(db.queries.some(query => (
    query.table === 'custom_object_record'
    && query.order?.column === 'id'
    && query.order.ascending === true
  )));
});

test('malformed option_source never falls through to legacy relationship resolution', async () => {
  const malformed = {
    ...form().fields[1],
    option_source: {
      version: 1,
      kind: 'records',
      custom_object_id: 'malformed',
      primary_display_field_id: 'also-malformed',
      filters: [],
    },
  };
  assert.throws(
    () => savedRelationshipField({ ...form(), fields: [form().fields[0], malformed] }, 'department'),
    error => error.status === 409 && /row source configuration is invalid/.test(error.message),
  );
  const rootForm = {
    fields: [{
      id: 'rows',
      type: 'repeatable_rows',
      children: [form().fields[0], malformed],
    }],
  };
  await assert.rejects(
    createFormRelationshipService({ db: mockDb({}), tenantId }).relationshipOptions({
      form: { ...rootForm, fields: rootForm.fields[0].children },
      rootForm,
      containerFieldId: 'rows',
      fieldId: 'department',
      parentRecordId: 'org-1',
    }),
    error => error.status === 409 && /row source configuration is invalid/.test(error.message),
  );
});
