import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CUSTOM_OBJECT_DIRECTORY_PAGE_SIZE,
  createCustomObjectDirectory,
} from './customObjectDirectory.js';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherTenantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const objectId = '10000000-0000-4000-8000-000000000001';
const primaryFieldId = '20000000-0000-4000-8000-000000000001';
const valueFieldId = '20000000-0000-4000-8000-000000000002';
const relationshipId = '30000000-0000-4000-8000-000000000001';
const organizationId = '40000000-0000-4000-8000-000000000001';
const roleId = '50000000-0000-4000-8000-000000000001';
const directoryId = '60000000-0000-4000-8000-000000000001';
const filterFieldId = '70000000-0000-4000-8000-000000000001';

const recordId = (number) =>
  `80000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;

function queryDb(seed = {}, { failTable = null } = {}) {
  const tables = Object.fromEntries(Object.entries(seed).map(([table, rows]) => [
    table,
    rows.map((row) => structuredClone(row)),
  ]));

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.orders = [];
      this.maximum = null;
      this.window = null;
    }

    select() { return this; }
    eq(column, value) {
      this.filters.push((row) => row[column] === value);
      return this;
    }
    is(column, value) {
      this.filters.push((row) => row[column] === value || (value === null && row[column] == null));
      return this;
    }
    in(column, values) {
      const allowed = new Set(values);
      this.filters.push((row) => allowed.has(row[column]));
      return this;
    }
    gt(column, value) {
      this.filters.push((row) => row[column] > value);
      return this;
    }
    order(column, { ascending = true } = {}) {
      this.orders.push({ column, ascending });
      return this;
    }
    limit(value) {
      this.maximum = value;
      return this;
    }
    range(from, to) {
      this.window = [from, to];
      return this;
    }
    execute() {
      if (this.table === failTable) {
        return { data: null, error: { message: `forced ${this.table} failure` } };
      }
      let data = (tables[this.table] || []).filter((row) =>
        this.filters.every((filter) => filter(row)));
      if (this.orders.length) {
        data = [...data].sort((left, right) => {
          for (const { column, ascending } of this.orders) {
            const compared = String(left[column] ?? '').localeCompare(String(right[column] ?? ''));
            if (compared) return ascending ? compared : -compared;
          }
          return 0;
        });
      }
      if (this.maximum !== null) data = data.slice(0, this.maximum);
      if (this.window) data = data.slice(this.window[0], this.window[1] + 1);
      return { data: data.map((row) => structuredClone(row)), error: null };
    }
    maybeSingle() {
      const result = this.execute();
      if (result.error) return Promise.resolve(result);
      return Promise.resolve({ data: result.data[0] || null, error: null });
    }
    then(resolve, reject) {
      return Promise.resolve(this.execute()).then(resolve, reject);
    }
  }

  return {
    from: (table) => new Query(table),
    tables,
  };
}

function definition(overrides = {}) {
  return {
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
          field_ids: [valueFieldId],
        },
      },
    },
    ...overrides,
  };
}

function field(id, name, overrides = {}) {
  return {
    id,
    tenant_id: tenantId,
    custom_object_id: objectId,
    entity_scope: 'custom_object',
    name,
    label: name === 'name' ? 'Name' : 'Value',
    field_type: 'text',
    is_active: true,
    archived_at: null,
    ...overrides,
  };
}

function relationship(overrides = {}) {
  return {
    id: relationshipId,
    tenant_id: tenantId,
    source_kind: 'custom_object',
    source_custom_object_id: objectId,
    target_kind: 'organization',
    target_custom_object_id: null,
    source_label: 'Organisation',
    target_label: 'Departments',
    status: 'active',
    archived_at: null,
    ...overrides,
  };
}

function baseSeed(overrides = {}) {
  return {
    custom_object_definition: [definition()],
    preference_field: [
      field(primaryFieldId, 'name'),
      field(valueFieldId, 'value'),
    ],
    custom_object_relationship_definition: [relationship()],
    custom_object_role_permission: [{
      tenant_id: tenantId,
      role_id: roleId,
      custom_object_id: objectId,
      can_view_records: true,
    }],
    custom_object_field_role_permission: [],
    organization: [{ id: organizationId, tenant_id: tenantId, name: 'Acme' }],
    system_settings: [],
    organization_preference_value: [],
    dynamic_directory: [],
    custom_object_relationship: [],
    custom_object_record: [],
    ...overrides,
  };
}

function service(seed = baseSeed(), options = {}) {
  const db = queryDb(seed, options);
  const context = {
    isAuthenticated: true,
    tenantId,
    roleId,
    memberId: 'member-1',
  };
  return {
    db,
    directory: createCustomObjectDirectory({
      db,
      context,
      featureCheck: async () => true,
      settingsCheck: async () => false,
    }),
  };
}

async function sourceFor(directory, options) {
  const metadata = await directory.metadata(options);
  assert.equal(metadata.sources.length, 1);
  return metadata.sources[0];
}

test('metadata evaluates opt-in and active tenant-owned object, relationship, and field rows', async () => {
  assert.equal((await service(baseSeed({
    custom_object_definition: [definition({
      configuration: {
        views: {
          organisation_directory: {
            enabled: false,
            relationships: [{ relationship_id: relationshipId, direction: 'target' }],
            field_ids: [valueFieldId],
          },
        },
      },
    })],
  })).directory.metadata()).sources.length, 0);

  for (const changed of [
    { custom_object_definition: [definition({ status: 'archived' })] },
    { custom_object_definition: [definition({ archived_at: '2026-01-01' })] },
    { custom_object_relationship_definition: [relationship({ status: 'archived' })] },
    { custom_object_relationship_definition: [relationship({ archived_at: '2026-01-01' })] },
    { preference_field: [
      field(primaryFieldId, 'name'),
      field(valueFieldId, 'value', { is_active: false }),
    ] },
  ]) {
    assert.equal((await service(baseSeed(changed)).directory.metadata()).sources.length, 0);
  }

  const crossTenant = baseSeed({
    custom_object_definition: [
      definition(),
      definition({
        id: '10000000-0000-4000-8000-000000000099',
        tenant_id: otherTenantId,
      }),
    ],
  });
  assert.equal((await service(crossTenant).directory.metadata()).sources.length, 1);
});

test('metadata never substitutes cross-tenant relationships, fields, edges, or records', async () => {
  assert.equal((await service(baseSeed({
    custom_object_relationship_definition: [relationship({ tenant_id: otherTenantId })],
  })).directory.metadata()).sources.length, 0);
  assert.equal((await service(baseSeed({
    preference_field: [
      field(primaryFieldId, 'name'),
      field(valueFieldId, 'value', { tenant_id: otherTenantId }),
    ],
  })).directory.metadata()).sources.length, 0);

  const ownRecord = {
    id: recordId(1),
    tenant_id: tenantId,
    custom_object_id: objectId,
    archived_at: null,
    data: { name: 'Own', value: 'own' },
  };
  const foreignRecord = {
    id: recordId(2),
    tenant_id: otherTenantId,
    custom_object_id: objectId,
    archived_at: null,
    data: { name: 'Foreign', value: 'foreign' },
  };
  const { directory } = service(baseSeed({
    custom_object_relationship: [
      {
        tenant_id: tenantId,
        relationship_definition_id: relationshipId,
        source_record_id: ownRecord.id,
        target_record_id: organizationId,
        archived_at: null,
      },
      {
        tenant_id: otherTenantId,
        relationship_definition_id: relationshipId,
        source_record_id: foreignRecord.id,
        target_record_id: organizationId,
        archived_at: null,
      },
    ],
    custom_object_record: [ownRecord, foreignRecord],
  }));
  const source = await sourceFor(directory);
  assert.deepEqual(
    (await directory.values({ organizationId, sourceKey: source.key })).items
      .map((item) => item.value),
    ['own'],
  );
});

test('settings metadata uses the settingsCheck context contract and bypasses viewer grants only for admins', async () => {
  const seed = baseSeed({
    custom_object_role_permission: [],
    custom_object_field_role_permission: [{
      tenant_id: tenantId,
      role_id: roleId,
      custom_object_id: objectId,
      field_id: valueFieldId,
      access_level: 'none',
    }],
  });
  const db = queryDb(seed);
  const calls = [];
  const directory = createCustomObjectDirectory({
    db,
    context: { isAuthenticated: true, tenantId, memberId: 'member-1' },
    featureCheck: async () => false,
    settingsCheck: async (context, checkedDirectoryId) => {
      calls.push({ context, checkedDirectoryId });
      return true;
    },
  });
  assert.equal((await directory.metadata({ settings: true })).sources.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.tenantId, tenantId);
  assert.equal(calls[0].checkedDirectoryId, 'main');

  const denied = createCustomObjectDirectory({
    db,
    context: { isAuthenticated: true, tenantId, memberId: 'member-1' },
    featureCheck: async () => false,
    settingsCheck: async () => false,
  });
  await assert.rejects(
    () => denied.metadata({ settings: true }),
    (error) => error.status === 403,
  );
});

test('metadata denies absent roles, object grants, selected-field grants, and primary-label grants', async () => {
  const noRole = service();
  noRole.directory = createCustomObjectDirectory({
    db: noRole.db,
    context: { isAuthenticated: true, tenantId, memberId: 'member-1' },
    featureCheck: async () => true,
    settingsCheck: async () => false,
  });
  await assert.rejects(() => noRole.directory.metadata(), (error) => error.status === 403);

  assert.equal((await service(baseSeed({
    custom_object_role_permission: [],
  })).directory.metadata()).sources.length, 0);
  assert.equal((await service(baseSeed({
    custom_object_role_permission: [{
      tenant_id: tenantId, role_id: roleId, custom_object_id: objectId, can_view_records: false,
    }],
  })).directory.metadata()).sources.length, 0);

  for (const deniedFieldId of [valueFieldId, primaryFieldId]) {
    assert.equal((await service(baseSeed({
      custom_object_field_role_permission: [{
        tenant_id: tenantId,
        role_id: roleId,
        custom_object_id: objectId,
        field_id: deniedFieldId,
        access_level: 'none',
      }],
    })).directory.metadata()).sources.length, 0);
  }
});

test('standard directory enforces exclusions plus configured application statuses and types', async () => {
  const statusField = {
    id: '70000000-0000-4000-8000-000000000002',
    tenant_id: tenantId,
    entity_scope: 'organization',
    name: 'application_status',
  };
  const typeField = {
    id: '70000000-0000-4000-8000-000000000003',
    tenant_id: tenantId,
    entity_scope: 'organization',
    name: 'org_type',
  };
  const settings = [
    { tenant_id: tenantId, setting_key: 'org_directory_allowed_application_statuses', setting_value: '["approved"]' },
    { tenant_id: tenantId, setting_key: 'org_directory_visible_org_types', setting_value: '["member"]' },
  ];
  const eligible = baseSeed({
    preference_field: [
      field(primaryFieldId, 'name'),
      field(valueFieldId, 'value'),
      statusField,
      typeField,
    ],
    system_settings: settings,
    organization_preference_value: [
      { organization_id: organizationId, field_id: statusField.id, value: 'approved' },
      { organization_id: organizationId, field_id: typeField.id, value: 'member' },
    ],
  });
  const { directory } = service(eligible);
  const source = await sourceFor(directory);
  const empty = await directory.values({ organizationId, sourceKey: source.key });
  assert.deepEqual(empty.items, []);

  const excluded = service({
    ...eligible,
    system_settings: [
      ...settings,
      { tenant_id: tenantId, setting_key: 'org_directory_excluded_orgs', setting_value: `["${organizationId}"]` },
    ],
  });
  await assert.rejects(
    () => excluded.directory.values({ organizationId, sourceKey: source.key }),
    (error) => error.status === 404,
  );

  for (const values of [
    [{ organization_id: organizationId, field_id: statusField.id, value: 'pending' }],
    [
      { organization_id: organizationId, field_id: statusField.id, value: 'approved' },
      { organization_id: organizationId, field_id: typeField.id, value: 'prospect' },
    ],
  ]) {
    const denied = service({ ...eligible, organization_preference_value: values });
    await assert.rejects(
      () => denied.directory.values({ organizationId, sourceKey: source.key }),
      (error) => error.status === 404,
    );
  }
});

test('dynamic directory enforces allowed roles and its saved organization filter', async () => {
  const dynamic = {
    id: directoryId,
    tenant_id: tenantId,
    entity_type: 'organization',
    allowed_role_ids: JSON.stringify([roleId]),
    filter_field_id: filterFieldId,
    filter_value: 'included',
    is_active: true,
  };
  const seed = baseSeed({
    dynamic_directory: [dynamic],
    organization_preference_value: [{
      organization_id: organizationId,
      field_id: filterFieldId,
      value: 'included',
    }],
  });
  const { directory } = service(seed);
  const source = await sourceFor(directory, { directoryId });
  assert.deepEqual(
    (await directory.values({ directoryId, organizationId, sourceKey: source.key })).items,
    [],
  );

  const wrongFilter = service({ ...seed, organization_preference_value: [] });
  await assert.rejects(
    () => wrongFilter.directory.values({ directoryId, organizationId, sourceKey: source.key }),
    (error) => error.status === 404,
  );

  const wrongRoleDb = queryDb(seed);
  const wrongRole = createCustomObjectDirectory({
    db: wrongRoleDb,
    context: { isAuthenticated: true, tenantId, roleId: '50000000-0000-4000-8000-000000000099' },
    featureCheck: async () => true,
    settingsCheck: async () => false,
  });
  await assert.rejects(
    () => wrongRole.metadata({ directoryId }),
    (error) => error.status === 403,
  );
});

test('values follows multiple links in both relationship directions and removes archived edges and records', async () => {
  const reverseRelationshipId = '30000000-0000-4000-8000-000000000002';
  const configured = definition({
    configuration: {
      views: {
        organisation_directory: {
          enabled: true,
          relationships: [
            { relationship_id: relationshipId, direction: 'target' },
            { relationship_id: reverseRelationshipId, direction: 'source' },
          ],
          field_ids: [valueFieldId],
        },
      },
    },
  });
  const records = [
    { id: recordId(1), tenant_id: tenantId, custom_object_id: objectId, archived_at: null, data: { name: 'One', value: 'first' } },
    { id: recordId(2), tenant_id: tenantId, custom_object_id: objectId, archived_at: null, data: { name: 'Two', value: 'second' } },
    { id: recordId(3), tenant_id: tenantId, custom_object_id: objectId, archived_at: '2026-01-01', data: { name: 'Archived', value: 'hidden' } },
  ];
  const edges = [
    {
      tenant_id: tenantId, relationship_definition_id: relationshipId,
      source_record_id: recordId(1), target_record_id: organizationId, archived_at: null,
    },
    {
      tenant_id: tenantId, relationship_definition_id: reverseRelationshipId,
      source_record_id: organizationId, target_record_id: recordId(2), archived_at: null,
    },
    {
      tenant_id: tenantId, relationship_definition_id: relationshipId,
      source_record_id: recordId(3), target_record_id: organizationId, archived_at: null,
    },
    {
      tenant_id: tenantId, relationship_definition_id: relationshipId,
      source_record_id: recordId(2), target_record_id: organizationId, archived_at: '2026-01-01',
    },
  ];
  const { directory } = service(baseSeed({
    custom_object_definition: [configured],
    custom_object_relationship_definition: [
      relationship(),
      relationship({
        id: reverseRelationshipId,
        source_kind: 'organization',
        source_custom_object_id: null,
        target_kind: 'custom_object',
        target_custom_object_id: objectId,
      }),
    ],
    custom_object_relationship: edges,
    custom_object_record: records,
  }));
  const metadata = await directory.metadata();
  assert.equal(metadata.sources.length, 2);
  const results = await Promise.all(metadata.sources.map((source) =>
    directory.values({ organizationId, sourceKey: source.key })));
  assert.deepEqual(
    results.flatMap((result) => result.items).map((item) => item.value).sort(),
    ['first', 'second'],
  );
});

test('values retains meaningful zero and false values from multiple records', async () => {
  const records = [
    { id: recordId(1), tenant_id: tenantId, custom_object_id: objectId, archived_at: null, data: { name: 'Zero', value: 0 } },
    { id: recordId(2), tenant_id: tenantId, custom_object_id: objectId, archived_at: null, data: { name: 'False', value: false } },
    { id: recordId(3), tenant_id: tenantId, custom_object_id: objectId, archived_at: null, data: { name: 'Blank', value: '' } },
  ];
  const edges = records.map((record) => ({
    tenant_id: tenantId,
    relationship_definition_id: relationshipId,
    source_record_id: record.id,
    target_record_id: organizationId,
    archived_at: null,
  }));
  const { directory } = service(baseSeed({
    custom_object_relationship: edges,
    custom_object_record: records,
  }));
  const source = await sourceFor(directory);
  assert.deepEqual(
    (await directory.values({ organizationId, sourceKey: source.key })).items
      .map((item) => item.value),
    [0, false],
  );
});

test('cursor pages more than 25 linked records deterministically without duplicates', async () => {
  const count = CUSTOM_OBJECT_DIRECTORY_PAGE_SIZE + 7;
  const records = Array.from({ length: count }, (_, index) => ({
    id: recordId(index + 1),
    tenant_id: tenantId,
    custom_object_id: objectId,
    archived_at: null,
    data: { name: `Record ${index + 1}`, value: index + 1 },
  }));
  const edges = [...records].reverse().map((record) => ({
    tenant_id: tenantId,
    relationship_definition_id: relationshipId,
    source_record_id: record.id,
    target_record_id: organizationId,
    archived_at: null,
  }));
  const { directory } = service(baseSeed({
    custom_object_relationship: edges,
    custom_object_record: records,
  }));
  const source = await sourceFor(directory);
  const first = await directory.values({ organizationId, sourceKey: source.key });
  assert.equal(first.items.length, CUSTOM_OBJECT_DIRECTORY_PAGE_SIZE);
  assert.ok(first.nextCursor);
  const second = await directory.values({
    organizationId,
    sourceKey: source.key,
    cursor: first.nextCursor,
  });
  const ids = [...first.items, ...second.items].map((item) => item.record_id);
  assert.equal(ids.length, count);
  assert.equal(new Set(ids).size, count);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(second.nextCursor, null);
});

test('copied file references are re-authorized after ACL revocation and for another role', async () => {
  const storedFile = {
    storage_path: `${tenantId}/custom-object-files/${objectId}/${valueFieldId}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-private-report.pdf`,
    bucket: 'private-uploads',
    file_name: 'Private report.pdf',
    mime_type: 'application/pdf',
  };
  const seed = baseSeed({
    preference_field: [
      field(primaryFieldId, 'name'),
      field(valueFieldId, 'attachment', {
        label: 'Attachment',
        field_type: 'file',
        allowed_file_types: ['pdf'],
      }),
    ],
    custom_object_relationship: [{
      id: '90000000-0000-4000-8000-000000000001',
      tenant_id: tenantId,
      relationship_definition_id: relationshipId,
      source_record_id: recordId(1),
      target_record_id: organizationId,
      archived_at: null,
    }],
    custom_object_record: [{
      id: recordId(1),
      tenant_id: tenantId,
      custom_object_id: objectId,
      archived_at: null,
      data: { name: 'Private record', attachment: JSON.stringify(storedFile) },
    }],
  });
  const db = queryDb(seed);
  const authorized = createCustomObjectDirectory({
    db,
    context: { isAuthenticated: true, tenantId, roleId, memberId: 'member-1' },
    featureCheck: async () => true,
    settingsCheck: async () => false,
  });
  const source = await sourceFor(authorized);
  const projected = await authorized.values({
    organizationId,
    sourceKey: source.key,
  });
  const fileUrl = projected.items[0].value.file_url;
  assert.match(fileUrl, /^\/api\/organisation-directory\/custom-object-file\?/);
  assert.doesNotMatch(fileUrl, /private-report|storage_path|secure-url/);
  const params = new URL(fileUrl, 'https://directory.test').searchParams;
  const fileRequest = {
    directoryId: params.get('directory_id'),
    organizationId: params.get('organization_id'),
    sourceKey: params.get('source_key'),
    recordId: params.get('record_id'),
    fileIndex: params.get('file_index'),
  };
  assert.deepEqual(await authorized.file(fileRequest), {
    ...storedFile,
    is_private: true,
  });

  // The URL may have been copied before access was revoked. Every download
  // resolves its source and field ACL again rather than trusting URL contents.
  db.tables.custom_object_field_role_permission.push({
    tenant_id: tenantId,
    role_id: roleId,
    custom_object_id: objectId,
    field_id: valueFieldId,
    access_level: 'none',
  });
  await assert.rejects(
    () => authorized.file(fileRequest),
    (error) => error.status === 404 && error.message === 'File source not found',
  );

  const otherRole = createCustomObjectDirectory({
    db,
    context: {
      isAuthenticated: true,
      tenantId,
      roleId: '50000000-0000-4000-8000-000000000099',
      memberId: 'member-2',
    },
    featureCheck: async () => true,
    settingsCheck: async () => false,
  });
  await assert.rejects(
    () => otherRole.file(fileRequest),
    (error) => error.status === 404 && error.message === 'File source not found',
  );
});

test('a source disabled while a request resolves is not returned or read', async () => {
  const seed = baseSeed({
    custom_object_relationship: [{
      tenant_id: tenantId,
      relationship_definition_id: relationshipId,
      source_record_id: recordId(1),
      target_record_id: organizationId,
      archived_at: null,
    }],
    custom_object_record: [{
      id: recordId(1),
      tenant_id: tenantId,
      custom_object_id: objectId,
      archived_at: null,
      data: { name: 'Record', value: 'must not escape' },
    }],
  });
  const db = queryDb(seed);
  let accessChecks = 0;
  const directory = createCustomObjectDirectory({
    db,
    context: { isAuthenticated: true, tenantId, roleId, memberId: 'member-1' },
    featureCheck: async () => {
      accessChecks += 1;
      if (accessChecks > 1) {
        db.tables.custom_object_definition[0]
          .configuration.views.organisation_directory.enabled = false;
      }
      return true;
    },
    settingsCheck: async () => false,
  });
  const source = await sourceFor(directory);
  await assert.rejects(
    () => directory.values({ organizationId, sourceKey: source.key }),
    (error) => error.status === 404 && error.message === 'Source not found',
  );
});

test('database query failures reject instead of silently returning partial data', async () => {
  const metadataFailure = service(baseSeed(), { failTable: 'preference_field' });
  await assert.rejects(
    () => metadataFailure.directory.metadata(),
    /forced preference_field failure/,
  );

  const valuesFailure = service(baseSeed({
    custom_object_relationship: [{
      tenant_id: tenantId,
      relationship_definition_id: relationshipId,
      source_record_id: recordId(1),
      target_record_id: organizationId,
      archived_at: null,
    }],
  }), { failTable: 'custom_object_relationship' });
  const source = await sourceFor(valuesFailure.directory);
  await assert.rejects(
    () => valuesFailure.directory.values({ organizationId, sourceKey: source.key }),
    /forced custom_object_relationship failure/,
  );
});