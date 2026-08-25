import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOM_OBJECT_FIELD_TYPES,
  CustomObjectDomainError,
  assertImmutableInternalKey,
  assertTenantOwnership,
  buildCustomObjectAuditEvent,
  coerceCustomObjectFieldValue,
  resolveCustomObjectDisplayValue,
  resolveCustomObjectLifecycleUpdate,
  resolveCustomObjectPermission,
  validateCustomObjectFieldDefinition,
  validateCustomObjectRecordData,
  validateCustomObjectRelationshipEndpoints,
} from './customObjectDomain.js';
import {
  isCustomObjectFieldWrite,
  isCustomObjectStorageEntity,
} from './customObjectApiBoundary.js';

const objectId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const field = (overrides = {}) => ({
  id: overrides.id || crypto.randomUUID(),
  tenant_id: tenantId,
  custom_object_id: objectId,
  entity_scope: 'custom_object',
  name: 'name',
  label: 'Name',
  field_type: 'text',
  is_active: true,
  is_required: false,
  ...overrides,
});

test('internal keys are immutable while labels can be handled separately', () => {
  assert.equal(assertImmutableInternalKey('department', 'department'), 'department');
  assert.throws(
    () => assertImmutableInternalKey('department', 'business_unit'),
    (error) => error instanceof CustomObjectDomainError && error.code === 'IMMUTABLE_INTERNAL_KEY',
  );
});

test('tenant ownership rejects cross-tenant resources', () => {
  assert.equal(assertTenantOwnership(tenantId, { tenant_id: tenantId }), true);
  assert.throws(
    () => assertTenantOwnership(tenantId, { tenant_id: crypto.randomUUID() }),
    (error) => error.code === 'CROSS_TENANT_REFERENCE',
  );
});

test('field definitions reuse supported preference field metadata', () => {
  assert.equal(validateCustomObjectFieldDefinition(field()).ok, true);
  assert.equal(validateCustomObjectFieldDefinition(field({ field_type: 'made_up' })).ok, false);
  assert.equal(validateCustomObjectFieldDefinition(field({
    field_type: 'dropdown',
    options: [],
  })).ok, false);
  assert.equal(validateCustomObjectFieldDefinition(field({
    name: 'Display Name',
  })).ok, false);
  assert.equal(validateCustomObjectFieldDefinition(field({
    field_type: 'file',
    allowed_file_types: [],
  })).ok, false);
  assert.equal(validateCustomObjectFieldDefinition(field({
    field_type: 'country',
    all_countries: false,
    selected_countries: ['GB'],
    default_country: 'US',
  })).ok, false);
  assert.equal(validateCustomObjectFieldDefinition(field({
    field_type: 'countries',
    all_countries: false,
    selected_countries: ['GB'],
    default_countries: ['GB', 'US'],
  })).ok, false);
});

test('field inventory matches every type offered by the existing custom-field editor', () => {
  assert.deepEqual(CUSTOM_OBJECT_FIELD_TYPES, [
    'text',
    'textarea',
    'email',
    'url',
    'date',
    'boolean',
    'number',
    'decimal',
    'picklist',
    'dropdown',
    'country',
    'countries',
    'list',
    'file',
  ]);
});

test('typed JSONB coercion covers every supported preference-field type', () => {
  const cases = [
    ['text', 'Hello', 'Hello'],
    ['textarea', 'First line\nSecond line', 'First line\nSecond line'],
    ['email', 'person@example.com', 'person@example.com'],
    ['url', 'https://example.com/profile', 'https://example.com/profile'],
    ['date', '2026-08-25', '2026-08-25'],
    ['boolean', 'Yes', true],
    ['number', '42', 42],
    ['decimal', '4.2', 4.2],
    ['picklist', '["a","b"]', ['a', 'b']],
    ['dropdown', 'a', 'a'],
    ['country', 'GB', 'GB'],
    ['countries', ['GB', 'FR'], ['GB', 'FR']],
    ['list', ['alpha', 'beta'], ['alpha', 'beta']],
    ['file', { name: 'document.pdf', path: 'records/document.pdf' }, {
      name: 'document.pdf',
      path: 'records/document.pdf',
    }],
  ];

  for (const [fieldType, input, expected] of cases) {
    const definition = field({
      field_type: fieldType,
      options: ['picklist', 'dropdown'].includes(fieldType)
        ? [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]
        : undefined,
      allowed_file_types: fieldType === 'file' ? ['pdf'] : undefined,
    });
    assert.equal(validateCustomObjectFieldDefinition(definition).ok, true, fieldType);
    assert.deepEqual(
      coerceCustomObjectFieldValue(input, definition),
      { ok: true, value: expected },
      fieldType,
    );
  }

  assert.equal(coerceCustomObjectFieldValue('4.2', field({ field_type: 'number' })).ok, false);
  assert.equal(coerceCustomObjectFieldValue(['a', 'nope'], field({
    field_type: 'picklist',
    options: ['a', 'b'],
  })).ok, false);
  assert.equal(coerceCustomObjectFieldValue('not-an-email', field({ field_type: 'email' })).ok, false);
  assert.equal(coerceCustomObjectFieldValue('javascript:alert(1)', field({ field_type: 'url' })).ok, false);
  assert.equal(coerceCustomObjectFieldValue('2026-02-30', field({ field_type: 'date' })).ok, false);
  assert.equal(coerceCustomObjectFieldValue('XX', field({
    field_type: 'country',
    all_countries: true,
  })).ok, false);
  assert.equal(coerceCustomObjectFieldValue(['GB', 'XX'], field({
    field_type: 'countries',
    all_countries: true,
  })).ok, false);
  assert.equal(coerceCustomObjectFieldValue('FR', field({
    field_type: 'country',
    all_countries: false,
    selected_countries: ['GB'],
  })).ok, false);
  assert.equal(coerceCustomObjectFieldValue(['GB', 'FR'], field({
    field_type: 'countries',
    all_countries: false,
    selected_countries: ['GB'],
  })).ok, false);
});

test('record validation enforces required fields and rejects unknown incoming keys', () => {
  const fields = [
    field({ name: 'department_name', label: 'Department Name', is_required: true }),
    field({ name: 'active', label: 'Active', field_type: 'boolean' }),
  ];
  const missing = validateCustomObjectRecordData({ data: { active: true }, fields });
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0].message, /required/);

  const valid = validateCustomObjectRecordData({
    data: { department_name: 'Radiology', active: 'yes' },
    fields,
  });
  assert.deepEqual(valid, {
    ok: true,
    data: { department_name: 'Radiology', active: true },
    errors: [],
  });

  const unknown = validateCustomObjectRecordData({
    data: { department_name: 'Radiology', surprise: true },
    fields,
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.errors.find((error) => error.field === 'surprise')?.message, 'Field is unknown or archived');
});

test('schema changes preserve historic archived/unknown values but enforce new required fields on edit', () => {
  const fields = [
    field({ name: 'department_name', is_required: true }),
    field({ name: 'new_required', label: 'New Required', is_required: true }),
    field({ name: 'old_code', is_active: false }),
  ];
  const read = validateCustomObjectRecordData({
    data: { department_name: 'Oncology', old_code: 'ONC', removed_field: 'historic' },
    fields,
    mode: 'read',
  });
  assert.equal(read.ok, true);
  assert.equal(read.data.old_code, 'ONC');
  assert.equal(read.data.removed_field, 'historic');

  const edited = validateCustomObjectRecordData({
    data: { department_name: 'Oncology and Haematology' },
    existingData: { department_name: 'Oncology', old_code: 'ONC' },
    fields,
    mode: 'update',
  });
  assert.equal(edited.ok, false);
  assert.match(edited.errors.find((error) => error.field === 'new_required')?.message, /required/);
});

test('display resolution uses option labels and primary field metadata', () => {
  const primary = field({
    id: '33333333-3333-4333-8333-333333333333',
    name: 'type',
    field_type: 'dropdown',
    options: [{ value: 'clinical', label: 'Clinical' }],
  });
  assert.equal(resolveCustomObjectDisplayValue({
    objectDefinition: { primary_display_field_id: primary.id },
    record: { id: 'record-1', data: { type: 'clinical' } },
    fields: [primary],
  }), 'Clinical');
});

test('lifecycle archive defaults are server-authored and archive is terminal', () => {
  assert.deepEqual(resolveCustomObjectLifecycleUpdate({
    currentStatus: 'active',
    nextStatus: 'archived',
    hasPrimaryDisplayField: true,
    now: '2026-08-25T12:00:00.000Z',
  }), {
    status: 'archived',
    archived_at: '2026-08-25T12:00:00.000Z',
  });
  assert.throws(
    () => resolveCustomObjectLifecycleUpdate({
      currentStatus: 'active',
      nextStatus: 'draft',
      hasPrimaryDisplayField: true,
    }),
    (error) => error.code === 'ACTIVE_CANNOT_RETURN_TO_DRAFT',
  );
  assert.throws(
    () => resolveCustomObjectLifecycleUpdate({
      currentStatus: 'archived',
      nextStatus: 'active',
      hasPrimaryDisplayField: true,
    }),
    (error) => error.code === 'ARCHIVED_IS_TERMINAL',
  );
  assert.throws(
    () => resolveCustomObjectLifecycleUpdate({
      currentStatus: 'draft',
      nextStatus: 'active',
      hasPrimaryDisplayField: false,
    }),
    (error) => error.code === 'PRIMARY_DISPLAY_FIELD_REQUIRED',
  );
});

test('permission defaults deny access while tenant admins bypass per-object rows', () => {
  assert.equal(resolveCustomObjectPermission({ capability: 'view_records' }), false);
  assert.equal(resolveCustomObjectPermission({
    capability: 'edit_records',
    permission: { can_view_records: true, can_edit_records: true },
  }), true);
  assert.equal(resolveCustomObjectPermission({
    capability: 'edit_records',
    permission: { can_view_records: false, can_edit_records: true },
  }), false);
  assert.equal(resolveCustomObjectPermission({
    capability: 'archive_records',
    isTenantAdmin: true,
  }), true);
});

test('relationship validation rejects cross-tenant and mismatched custom object records', () => {
  const definition = {
    tenant_id: tenantId,
    status: 'active',
    cardinality: 'many_to_many',
    source_kind: 'custom_object',
    source_custom_object_id: objectId,
    target_kind: 'organization',
    target_custom_object_id: null,
  };
  const source = {
    tenant_id: tenantId,
    kind: 'custom_object',
    custom_object_id: objectId,
    archived_at: null,
  };
  const target = { tenant_id: tenantId, kind: 'organization', archived_at: null };
  assert.equal(validateCustomObjectRelationshipEndpoints({
    tenantId,
    definition,
    source,
    target,
  }), true);
  assert.throws(
    () => validateCustomObjectRelationshipEndpoints({
      tenantId,
      definition,
      source,
      target: { ...target, tenant_id: crypto.randomUUID() },
    }),
    (error) => error.code === 'CROSS_TENANT_REFERENCE',
  );
  assert.throws(
    () => validateCustomObjectRelationshipEndpoints({
      tenantId,
      definition,
      source: { ...source, custom_object_id: crypto.randomUUID() },
      target,
    }),
    (error) => error.code === 'ENDPOINT_OBJECT_MISMATCH',
  );
});

test('audit payload is server-shaped and caller timestamps/ids cannot be supplied', () => {
  const event = buildCustomObjectAuditEvent({
    tenantId,
    customObjectId: objectId,
    action: 'record.updated',
    entityType: 'custom_object_record',
    entityId: '44444444-4444-4444-8444-444444444444',
    before: { name: 'Old' },
    after: { name: 'New' },
    metadata: { request_id: 'request-1' },
    id: 'caller-id',
    created_at: '1900-01-01',
  });
  assert.equal(event.id, undefined);
  assert.equal(event.created_at, undefined);
  assert.equal(event.tenant_id, tenantId);
});

test('generic entity boundary reserves Custom Object storage and field writes', () => {
  assert.equal(isCustomObjectStorageEntity('CustomObjectRecord'), true);
  assert.equal(isCustomObjectStorageEntity('custom-object-audit-event'), true);
  assert.equal(isCustomObjectStorageEntity('Organization'), false);
  assert.equal(isCustomObjectFieldWrite({ entity_scope: 'custom_object' }), true);
  assert.equal(isCustomObjectFieldWrite({ custom_object_id: objectId }), true);
  assert.equal(isCustomObjectFieldWrite({ entity_scope: 'member' }), false);
});