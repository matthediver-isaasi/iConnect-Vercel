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
