import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOrganisationDirectoryFilters,
  OrganisationDirectoryFilterError,
} from './organisationDirectoryFilters.js';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherTenantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const roleId = '50000000-0000-4000-8000-000000000001';
const objectId = '10000000-0000-4000-8000-000000000001';
const primaryFieldId = '20000000-0000-4000-8000-000000000001';
const objectFieldId = '20000000-0000-4000-8000-000000000002';
const relationshipId = '30000000-0000-4000-8000-000000000001';
const objectKey =
  `object-field:${relationshipId}:target:${objectId}:${objectFieldId}`;

function database(seed = {}, failTable = null) {
  const tables = Object.fromEntries(Object.entries(seed).map(([name, rows]) => [
    name, structuredClone(rows),
  ]));
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.orders = [];
      this.window = null;
      this.maximum = null;
    }
    select() { return this; }
    eq(key, value) { this.filters.push((row) => row[key] === value); return this; }
    gt(key, value) { this.filters.push((row) => row[key] > value); return this; }
    is(key, value) {
      this.filters.push((row) => value === null ? row[key] == null : row[key] === value);
      return this;
    }
    in(key, values) {
      const allowed = new Set(values);
      this.filters.push((row) => allowed.has(row[key]));
      return this;
    }
    not(key, operator, value) {
      if (operator === 'ilike') {
        const pattern = String(value).replaceAll('%', '').toLowerCase();
        this.filters.push((row) => !String(row[key] || '').toLowerCase().includes(pattern));
      } else if (operator === 'in') {
        const denied = new Set(String(value).replace(/^\(|\)$/g, '').split(','));
        this.filters.push((row) => !denied.has(String(row[key])));
      }
      return this;
    }
    or(expression) {
      // The service only uses null-or-not-false visibility clauses.
      if (String(expression).includes('.neq.false')) {
        const key = String(expression).split('.')[0];
        this.filters.push((row) => row[key] == null || row[key] !== false);
      }
      return this;
    }
    order(key, { ascending = true } = {}) {
      this.orders.push({ key, ascending });
      return this;
    }
    limit(value) { this.maximum = value; return this; }
    range(from, to) { this.window = [from, to]; return this; }
    execute() {
      if (this.table === failTable) {
        return { data: null, error: { message: `forced ${this.table} failure` } };
      }
      let rows = (tables[this.table] || []).filter((row) =>
        this.filters.every((filter) => filter(row)));
      rows = [...rows].sort((left, right) => {
        for (const { key, ascending } of this.orders) {
          const compared = String(left[key] ?? '').localeCompare(String(right[key] ?? ''));
          if (compared) return ascending ? compared : -compared;
        }
        return 0;
      });
      if (this.window) rows = rows.slice(this.window[0], this.window[1] + 1);
      if (this.maximum !== null) rows = rows.slice(0, this.maximum);
      return { data: structuredClone(rows), error: null };
    }
    then(resolve, reject) {
      return Promise.resolve(this.execute()).then(resolve, reject);
    }
  }
  return { from: (table) => new Query(table), tables };
}

function customField(id, name, overrides = {}) {
  return {
    id,
    tenant_id: tenantId,
    entity_scope: 'organization',
    name,
    label: name,
    field_type: 'text',
    is_active: true,
    is_filterable: true,
    directory_visibility: { ids: ['main'], display: { main: { back: true } } },
    display_order: 1,
    ...overrides,
  };
}

function objectSeed(fieldType = 'text') {
  return {
    custom_object_definition: [{
      id: objectId,
      tenant_id: tenantId,
      singular_label: 'Department',
      primary_display_field_id: primaryFieldId,
      status: 'active',
      archived_at: null,
      configuration: {
        views: {
          organisation_directory: {
            enabled: true,
            relationships: [{ relationship_id: relationshipId, direction: 'target' }],
            field_ids: [objectFieldId],
          },
        },
      },
    }],
    custom_object_relationship_definition: [{
      id: relationshipId,
      tenant_id: tenantId,
      source_kind: 'custom_object',
      target_kind: 'organization',
      source_custom_object_id: objectId,
      target_custom_object_id: null,
      target_label: 'Departments',
      status: 'active',
      archived_at: null,
    }],
    preference_field: [
      customField(primaryFieldId, 'title', {
        entity_scope: 'custom_object', custom_object_id: objectId,
      }),
      customField(objectFieldId, 'value', {
        entity_scope: 'custom_object', custom_object_id: objectId, field_type: fieldType,
      }),
    ],
    custom_object_role_permission: [{
      tenant_id: tenantId,
      role_id: roleId,
      custom_object_id: objectId,
      can_view_records: true,
    }],
    custom_object_field_role_permission: [],
  };
}

function baseSeed(overrides = {}) {
  return {
    organization: [],
    preference_field: [],
    organization_preference_value: [],
    system_settings: [],
    member: [],
    custom_object_definition: [],
    custom_object_relationship_definition: [],
    custom_object_role_permission: [],
    custom_object_field_role_permission: [],
    custom_object_relationship: [],
    custom_object_record: [],
    ...overrides,
  };
}

function service(seed, context = {}) {
  const db = database(seed);
  return {
    db,
    service: createOrganisationDirectoryFilters({
      db,
      context: {
        tenantId,
        roleId,
        organizationId: null,
        ...context,
      },
    }),
  };
}

const request = (filters = {}, overrides = {}) => ({
  filters,
  search: '',
  sort: 'asc',
  page: 1,
  pageSize: 12,
  ...overrides,
});

test('search evaluates over 1,000 organizations/preferences before deterministic paging with AND and choice OR', async () => {
  const count = 1005;
  const organizations = Array.from({ length: count }, (_, index) => ({
    id: `org-${String(index).padStart(4, '0')}`,
    tenant_id: tenantId,
    name: `Organisation ${String(index).padStart(4, '0')}`,
    logo_url: `logo-${index}`,
    domain: `org${index}.test`,
  }));
  const choice = customField('choice-field', 'choice', {
    field_type: 'dropdown',
    options: [
      { value: 'red', label: 'Red' },
      { value: 'blue', label: 'Blue' },
      { value: 'green', label: 'Green' },
    ],
  });
  const score = customField('score-field', 'score', { field_type: 'number' });
  const preferences = organizations.flatMap((organization, index) => [
    {
      organization_id: organization.id,
      field_id: choice.id,
      value: ['red', 'blue', 'green'][index % 3],
    },
    { organization_id: organization.id, field_id: score.id, value: index },
  ]);
  const { service: directory } = service(baseSeed({
    organization: organizations,
    preference_field: [choice, score],
    organization_preference_value: preferences,
  }));
  const result = await directory.search(request({
    'custom:choice-field': { operator: 'eq', value: ['red', 'blue'] },
    'custom:score-field': { operator: 'gte', value: 1000 },
  }, { page: 2, pageSize: 2 }));
  assert.equal(result.total, 3);
  assert.deepEqual(result.organizations.map(({ id }) => id), ['org-1003']);
  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 2);
  assert.ok(result.fields.every((field) => !Object.keys(field).some((key) => key.startsWith('_'))));
});

test('metadata uses saved back order, explicit overrides, configured choices, and complete settings inventory', async () => {
  const first = customField('first', 'First', { display_order: 1 });
  const second = customField('second', 'Second', {
    display_order: 2,
    field_type: 'dropdown',
    is_filterable: false,
    options: [{ value: 'safe', label: 'Safe option' }],
  });
  const settingsOnly = customField('settings-only', 'Settings only', {
    directory_visibility: { ids: [] },
  });
  const seed = baseSeed({
    preference_field: [first, second, settingsOnly],
    system_settings: [
      {
        tenant_id: tenantId,
        setting_key: 'org_directory_back_field_order',
        setting_value: '["custom:second","custom:first"]',
      },
      {
        tenant_id: tenantId,
        setting_key: 'org_directory_filterable_back_fields',
        setting_value: '{"custom:second":true}',
      },
    ],
  });
  const { service: directory } = service(seed);
  const viewer = await directory.metadata();
  assert.deepEqual(viewer.fields.map(({ key }) => key), ['custom:second', 'custom:first']);
  assert.deepEqual(viewer.fields[0].options, [{ value: 'safe', label: 'Safe option' }]);
  assert.equal(viewer.fields.some(({ key }) => key === 'custom:settings-only'), false);
  const settings = await directory.metadata({ settings: true });
  assert.equal(settings.fields.some(({ key }) => key === 'custom:settings-only'), true);
  assert.deepEqual(settings.overrides, { 'custom:second': true });

  const malformed = structuredClone(seed);
  malformed.system_settings[1].setting_value = '{"custom:second":"true"}';
  await assert.rejects(
    () => service(malformed).service.metadata({ settings: true }),
    (error) => error.status === 500 && /malformed/.test(error.message),
  );
});

test('saved exclusions/status/type policies retain the requester own-organization exception', async () => {
  const status = customField('status-field', 'application_status');
  const type = customField('type-field', 'org_type');
  const organizations = ['own', 'eligible', 'excluded', 'wrong-status', 'wrong-type'].map((id) => ({
    id, tenant_id: tenantId, name: id, domain: `${id}.test`,
  }));
  organizations.push({ id: 'foreign', tenant_id: otherTenantId, name: 'Foreign' });
  const values = [
    ['own', 'pending', 'outsider'],
    ['eligible', 'approved', 'member'],
    ['excluded', 'approved', 'member'],
    ['wrong-status', 'pending', 'member'],
    ['wrong-type', 'approved', 'prospect'],
  ].flatMap(([organization_id, applicationStatus, orgType]) => [
    { organization_id, field_id: status.id, value: applicationStatus },
    { organization_id, field_id: type.id, value: orgType },
  ]);
  const { service: directory } = service(baseSeed({
    organization: organizations,
    preference_field: [status, type],
    organization_preference_value: values,
    system_settings: [
      { tenant_id: tenantId, setting_key: 'org_directory_excluded_orgs', setting_value: '["own","excluded"]' },
      { tenant_id: tenantId, setting_key: 'org_directory_allowed_application_statuses', setting_value: '["approved"]' },
      { tenant_id: tenantId, setting_key: 'org_directory_visible_org_types', setting_value: '["member"]' },
    ],
  }), { organizationId: 'own' });
  const result = await directory.search(request());
  assert.deepEqual(result.organizations.map(({ id }) => id), ['eligible', 'own']);
});

test('Data Studio filtering reads all active links/records beyond 25 and rejects stale, archived, foreign, and denied sources', async () => {
  const object = objectSeed();
  const organizations = [
    { id: 'org-linked', tenant_id: tenantId, name: 'Linked' },
    { id: 'org-stale', tenant_id: tenantId, name: 'Stale' },
  ];
  const records = Array.from({ length: 30 }, (_, index) => ({
    id: `record-${String(index).padStart(2, '0')}`,
    tenant_id: tenantId,
    custom_object_id: objectId,
    archived_at: null,
    data: { title: `Record ${index}`, value: `value-${index}` },
  }));
  records.push({
    id: 'record-archived', tenant_id: tenantId, custom_object_id: objectId,
    archived_at: '2026-01-01', data: { title: 'Archived', value: 'forged-target' },
  }, {
    id: 'record-foreign', tenant_id: otherTenantId, custom_object_id: objectId,
    archived_at: null, data: { title: 'Foreign', value: 'forged-target' },
  });
  const edges = records.map((record) => ({
    tenant_id: record.id === 'record-foreign' ? otherTenantId : tenantId,
    relationship_definition_id: relationshipId,
    source_record_id: record.id,
    target_record_id: record.id === 'record-archived' ? 'org-stale' : 'org-linked',
    archived_at: null,
  }));
  edges.push({
    tenant_id: tenantId,
    relationship_definition_id: relationshipId,
    source_record_id: 'record-29',
    target_record_id: 'org-stale',
    archived_at: '2026-01-01',
  }, {
    tenant_id: tenantId,
    relationship_definition_id: relationshipId,
    source_record_id: 'record-does-not-exist',
    target_record_id: 'org-stale',
    archived_at: null,
  });
  const seed = baseSeed({
    ...object,
    preference_field: object.preference_field,
    organization: organizations,
    custom_object_record: records,
    custom_object_relationship: edges,
    system_settings: [{
      tenant_id: tenantId,
      setting_key: 'org_directory_filterable_back_fields',
      setting_value: JSON.stringify({ [objectKey]: true }),
    }],
  });
  const { service: directory } = service(seed);
  const result = await directory.search(request({
    [objectKey]: { operator: 'eq', value: 'value-29' },
  }));
  assert.equal(result.total, 1);
  assert.equal(result.organizations[0].id, 'org-linked');
  assert.equal(JSON.stringify(result).includes('forged-target'), false);
  assert.equal(JSON.stringify(result).includes('data'), false);
  assert.equal((await directory.search(request({
    [objectKey]: { operator: 'eq', value: 'forged-target' },
  }))).total, 0);

  const denied = structuredClone(seed);
  denied.custom_object_field_role_permission = [{
    tenant_id: tenantId,
    role_id: roleId,
    custom_object_id: objectId,
    field_id: objectFieldId,
    access_level: 'none',
  }];
  const deniedService = service(denied).service;
  assert.equal((await deniedService.metadata()).fields.some(({ key }) => key === objectKey), false);
  await assert.rejects(
    () => deniedService.search(request({ [objectKey]: { operator: 'present', value: true } })),
    (error) => error instanceof OrganisationDirectoryFilterError && error.status === 400,
  );

  const objectDenied = structuredClone(seed);
  objectDenied.custom_object_role_permission[0].can_view_records = false;
  assert.equal(
    (await service(objectDenied).service.metadata()).fields.some(({ key }) => key === objectKey),
    false,
  );
});

test('member names are role-limited while safe counts include only directory-visible active members', async () => {
  const organizations = [{ id: 'org-1', tenant_id: tenantId, name: 'One' }];
  const { service: directory } = service(baseSeed({
    organization: organizations,
    system_settings: [
      {
        tenant_id: tenantId,
        setting_key: 'org_directory_filterable_back_fields',
        setting_value: '{"org_members_list":true}',
      },
      {
        tenant_id: tenantId,
        setting_key: 'org_directory_reverse_card_role_ids',
        setting_value: '["public-role"]',
      },
    ],
    member: [
      {
        id: 'member-1', tenant_id: tenantId, organization_id: 'org-1',
        role_id: 'public-role', first_name: 'Alice', last_name: 'Allowed',
        email: 'alice@test', login_enabled: true, show_in_directory: true,
      },
      {
        id: 'member-2', tenant_id: tenantId, organization_id: 'org-1',
        role_id: 'private-role', first_name: 'Secret', last_name: 'Person',
        email: 'secret@test', login_enabled: true, show_in_directory: true,
      },
      {
        id: 'member-3', tenant_id: tenantId, organization_id: 'org-1',
        role_id: 'public-role', first_name: 'Hidden', last_name: 'Person',
        email: 'hidden@test', login_enabled: true, show_in_directory: false,
      },
    ],
  }));
  const allowed = await directory.search(request({
    org_members_list: { operator: 'contains', value: 'Alice' },
  }));
  assert.equal(allowed.total, 1);
  assert.equal(allowed.organizations[0].member_count, 2);
  const privateName = await directory.search(request({
    org_members_list: { operator: 'contains', value: 'Secret' },
  }));
  assert.equal(privateName.total, 0);
});

test('file sources expose only presence semantics and configured choices reject arbitrary values/keys', async () => {
  const object = objectSeed('file');
  const choice = customField('choice', 'choice', {
    field_type: 'dropdown',
    options: [{ value: 'configured', label: 'Configured' }],
  });
  const seed = baseSeed({
    ...object,
    preference_field: [...object.preference_field, choice],
    organization: [
      { id: 'with-file', tenant_id: tenantId, name: 'With' },
      { id: 'without-file', tenant_id: tenantId, name: 'Without' },
    ],
    organization_preference_value: [
      { organization_id: 'with-file', field_id: choice.id, value: 'configured' },
    ],
    custom_object_record: [
      {
        id: 'file-record', tenant_id: tenantId, custom_object_id: objectId,
        archived_at: null,
        data: {
          title: 'File',
          value: {
            storage_path: `${tenantId}/custom-object-files/${objectId}/${objectFieldId}/private.pdf`,
          },
        },
      },
      {
        id: 'empty-record', tenant_id: tenantId, custom_object_id: objectId,
        archived_at: null, data: { title: 'Empty', value: '' },
      },
    ],
    custom_object_relationship: [
      {
        tenant_id: tenantId, relationship_definition_id: relationshipId,
        source_record_id: 'file-record', target_record_id: 'with-file', archived_at: null,
      },
      {
        tenant_id: tenantId, relationship_definition_id: relationshipId,
        source_record_id: 'empty-record', target_record_id: 'without-file', archived_at: null,
      },
    ],
    system_settings: [{
      tenant_id: tenantId,
      setting_key: 'org_directory_filterable_back_fields',
      setting_value: JSON.stringify({ [objectKey]: true }),
    }],
  });
  const { service: directory } = service(seed);
  const metadata = await directory.metadata();
  const fileField = metadata.fields.find(({ key }) => key === objectKey);
  assert.equal(fileField.control, 'presence');
  assert.deepEqual(fileField.options, []);
  const present = await directory.search(request({
    [objectKey]: { operator: 'present', value: true },
  }));
  assert.deepEqual(present.organizations.map(({ id }) => id), ['with-file']);
  assert.equal(JSON.stringify(present).includes('storage_path'), false);
  const absent = await directory.search(request({
    [objectKey]: { operator: 'absent', value: true },
  }));
  assert.deepEqual(absent.organizations.map(({ id }) => id), ['without-file']);
  await assert.rejects(
    () => directory.search(request({ 'custom:choice': { operator: 'eq', value: 'forged' } })),
    (error) => error.status === 400,
  );
  await assert.rejects(
    () => directory.search(request({ 'custom:not-real': { operator: 'eq', value: 'x' } })),
    (error) => error.status === 400,
  );
});

test('request validation is strict per control and never coerces blank/null numeric or malformed date values', async () => {
  const text = customField('text', 'text');
  const number = customField('number', 'number', { field_type: 'number' });
  const date = customField('date', 'date', { field_type: 'date' });
  const choice = customField('typed-choice', 'choice', {
    field_type: 'dropdown',
    options: [{ value: 'one', label: 'One' }],
  });
  const presence = customField('attachment', 'attachment', { field_type: 'file' });
  const { service: directory } = service(baseSeed({
    organization: [{ id: 'org-zero', tenant_id: tenantId, name: 'Zero' }],
    preference_field: [text, number, date, choice, presence],
    organization_preference_value: [
      { organization_id: 'org-zero', field_id: number.id, value: 0 },
      { organization_id: 'org-zero', field_id: date.id, value: '2024-02-29' },
    ],
  }));
  const invalid = [
    ['custom:text', { operator: 'gte', value: 'x' }],
    ['custom:text', { operator: 'eq', value: '' }],
    ['custom:number', { operator: 'eq', value: null }],
    ['custom:number', { operator: 'eq', value: '   ' }],
    ['custom:number', { operator: 'between', value: ['\t', 2] }],
    ['custom:number', { operator: 'eq', value: '' }],
    ['custom:number', { operator: 'eq', value: 'not-a-number' }],
    ['custom:number', { operator: 'between', value: [2, 1] }],
    ['custom:number', { operator: 'between', value: ['', 2] }],
    ['custom:date', { operator: 'eq', value: '2023-02-29' }],
    ['custom:date', { operator: 'eq', value: '02/29/2024' }],
    ['custom:date', { operator: 'between', value: ['2024-03-01', '2024-02-29'] }],
    ['custom:typed-choice', { operator: 'contains', value: 'one' }],
    ['custom:typed-choice', { operator: 'eq', value: [] }],
    ['custom:attachment', { operator: 'eq', value: 'anything' }],
  ];
  for (const [key, filter] of invalid) {
    await assert.rejects(
      () => directory.search(request({ [key]: filter })),
      (error) => error.status === 400,
      `${key} ${JSON.stringify(filter)} should be rejected`,
    );
  }
  assert.equal((await directory.search(request({
    'custom:number': { operator: 'eq', value: 0 },
    'custom:date': { operator: 'eq', value: '2024-02-29' },
  }))).total, 1);
});

test('database failures reject rather than returning partial result sets', async () => {
  const db = database(baseSeed(), 'organization');
  const directory = createOrganisationDirectoryFilters({
    db,
    context: { tenantId, roleId },
  });
  await assert.rejects(() => directory.search(request()), /Organisation inventory/);
});