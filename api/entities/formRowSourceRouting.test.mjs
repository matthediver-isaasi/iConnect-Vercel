import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  MANAGE_SCHEMA_FEATURE,
  resolveTrustedSchemaCapabilities,
  VIEW_SCHEMA_FEATURE,
} from '../_lib/customObjectSchemaAccess.js';
import { createFormRelationshipService } from '../_lib/formRelationshipOptions.js';
import { validateFormRowSourceConfiguration } from '../_lib/formRowSourceConfiguration.js';

const CREATE_ROUTE_SOURCE = await readFile(
  new URL('./[entity]/index.js', import.meta.url),
  'utf8',
);
const UPDATE_ROUTE_SOURCE = await readFile(
  new URL('./[entity]/[id].js', import.meta.url),
  'utf8',
);

const id = suffix => `30000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const TENANT_ID = 'tenant-1';
const FOREIGN_TENANT_ID = 'tenant-2';

const OBJECT_ID = id(101);
const PRIMARY_FIELD_ID = id(102);
const FILTER_FIELD_ID = id(103);
const VALUE_FIELD_ID = id(104);
const ARCHIVED_OBJECT_ID = id(105);
const ARCHIVED_PRIMARY_FIELD_ID = id(106);
const FOREIGN_OBJECT_ID = id(107);
const FOREIGN_PRIMARY_FIELD_ID = id(108);
const ROW_FIELD_ID = id(109);
const DEPENDENCY_FIELD_ID = id(110);
const SOURCE_FIELD_ID = id(111);
const DISTINCT_SOURCE_FIELD_ID = id(112);
const RELATIONSHIP_DEFINITION_ID = id(113);

function objectDefinition({
  id: objectId,
  tenantId = TENANT_ID,
  primaryDisplayFieldId,
  archivedAt = null,
} = {}) {
  return {
    id: objectId,
    tenant_id: tenantId,
    object_key: `object_${objectId.slice(-3)}`,
    singular_label: 'Object',
    plural_label: 'Objects',
    primary_display_field_id: primaryDisplayFieldId,
    status: 'active',
    archived_at: archivedAt,
    configuration: {},
  };
}

function fieldDefinition({
  id: fieldId,
  customObjectId = OBJECT_ID,
  tenantId = TENANT_ID,
  fieldType = 'text',
} = {}) {
  return {
    id: fieldId,
    tenant_id: tenantId,
    custom_object_id: customObjectId,
    entity_scope: 'custom_object',
    is_active: true,
    archived_at: null,
    name: `field_${fieldId.slice(-3)}`,
    label: 'Field',
    field_type: fieldType,
  };
}

const BASE_TABLES = {
  custom_object_definition: [
    objectDefinition({ id: OBJECT_ID, primaryDisplayFieldId: PRIMARY_FIELD_ID }),
    objectDefinition({
      id: ARCHIVED_OBJECT_ID,
      primaryDisplayFieldId: ARCHIVED_PRIMARY_FIELD_ID,
      archivedAt: '2026-01-01T00:00:00.000Z',
    }),
    objectDefinition({
      id: FOREIGN_OBJECT_ID,
      tenantId: FOREIGN_TENANT_ID,
      primaryDisplayFieldId: FOREIGN_PRIMARY_FIELD_ID,
    }),
  ],
  preference_field: [
    fieldDefinition({ id: PRIMARY_FIELD_ID }),
    fieldDefinition({ id: FILTER_FIELD_ID }),
    fieldDefinition({ id: VALUE_FIELD_ID }),
    fieldDefinition({
      id: ARCHIVED_PRIMARY_FIELD_ID,
      customObjectId: ARCHIVED_OBJECT_ID,
    }),
    fieldDefinition({
      id: FOREIGN_PRIMARY_FIELD_ID,
      customObjectId: FOREIGN_OBJECT_ID,
      tenantId: FOREIGN_TENANT_ID,
    }),
  ],
  custom_object_relationship_definition: [{
    id: RELATIONSHIP_DEFINITION_ID,
    tenant_id: TENANT_ID,
    relationship_key: 'organization_object',
    status: 'active',
    archived_at: null,
    source_kind: 'organization',
    source_custom_object_id: null,
    target_kind: 'custom_object',
    target_custom_object_id: OBJECT_ID,
    show_on_source: true,
    show_on_target: true,
  }],
  custom_object_role_permission: [{
    tenant_id: TENANT_ID,
    custom_object_id: OBJECT_ID,
    role_id: 'restricted-grant',
    can_view_records: true,
  }, {
    tenant_id: TENANT_ID,
    custom_object_id: OBJECT_ID,
    role_id: 'primary-denied',
    can_view_records: true,
  }, {
    tenant_id: TENANT_ID,
    custom_object_id: OBJECT_ID,
    role_id: 'filter-denied',
    can_view_records: true,
  }, {
    tenant_id: TENANT_ID,
    custom_object_id: OBJECT_ID,
    role_id: 'value-denied',
    can_view_records: true,
  }],
  custom_object_field_role_permission: [{
    tenant_id: TENANT_ID,
    custom_object_id: OBJECT_ID,
    role_id: 'primary-denied',
    field_id: PRIMARY_FIELD_ID,
    access_level: 'none',
  }, {
    tenant_id: TENANT_ID,
    custom_object_id: OBJECT_ID,
    role_id: 'filter-denied',
    field_id: FILTER_FIELD_ID,
    access_level: 'none',
  }, {
    tenant_id: TENANT_ID,
    custom_object_id: OBJECT_ID,
    role_id: 'value-denied',
    field_id: VALUE_FIELD_ID,
    access_level: 'none',
  }, {
    tenant_id: TENANT_ID,
    custom_object_id: OBJECT_ID,
    role_id: 'schema-view-primary-denied',
    field_id: PRIMARY_FIELD_ID,
    access_level: 'none',
  }],
};

function queryDb(seed = BASE_TABLES) {
  const tables = structuredClone(seed);
  const calls = [];

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.orders = [];
      this.start = null;
      this.end = null;
    }

    select() {
      return this;
    }

    eq(column, value) {
      this.filters.push(row => row[column] === value);
      return this;
    }

    in(column, values) {
      this.filters.push(row => values.includes(row[column]));
      return this;
    }

    is(column, value) {
      this.filters.push(row => row[column] === value);
      return this;
    }

    order(column, { ascending = true } = {}) {
      this.orders.push({ column, ascending });
      return this;
    }

    range(start, end) {
      this.start = start;
      this.end = end;
      return this;
    }

    rows() {
      let rows = (tables[this.table] || [])
        .filter(row => this.filters.every(filter => filter(row)));
      rows = [...rows];
      for (const { column, ascending } of this.orders) {
        rows.sort((left, right) => {
          if (left[column] === right[column]) return 0;
          const result = left[column] < right[column] ? -1 : 1;
          return ascending ? result : -result;
        });
      }
      if (this.start !== null) rows = rows.slice(this.start, this.end + 1);
      return rows;
    }

    async maybeSingle() {
      return { data: this.rows()[0] || null, error: null };
    }

    async single() {
      return { data: this.rows()[0] || null, error: null };
    }

    then(resolve, reject) {
      return Promise.resolve({ data: this.rows(), error: null }).then(resolve, reject);
    }
  }

  return {
    calls,
    from(table) {
      calls.push(table);
      return new Query(table);
    },
  };
}

function recordsForm({
  objectId = OBJECT_ID,
  primaryFieldId = PRIMARY_FIELD_ID,
  filterFieldId = FILTER_FIELD_ID,
} = {}) {
  return {
    id: id(120),
    fields: [{
      id: ROW_FIELD_ID,
      type: 'repeatable_rows',
      children: [{
        id: DEPENDENCY_FIELD_ID,
        type: 'text',
      }, {
        id: SOURCE_FIELD_ID,
        type: 'relationship_dropdown',
        option_source: {
          version: 1,
          kind: 'records',
          custom_object_id: objectId,
          primary_display_field_id: primaryFieldId,
          filters: [{
            field_id: filterFieldId,
            source_field_id: DEPENDENCY_FIELD_ID,
          }],
        },
      }],
    }],
  };
}

function distinctForm({
  objectId = OBJECT_ID,
  primaryFieldId = PRIMARY_FIELD_ID,
  valueFieldId = VALUE_FIELD_ID,
} = {}) {
  return {
    id: id(121),
    fields: [{
      id: ROW_FIELD_ID,
      type: 'repeatable_rows',
      children: [{
        id: DEPENDENCY_FIELD_ID,
        type: 'organisation_dropdown',
      }, {
        id: DISTINCT_SOURCE_FIELD_ID,
        type: 'relationship_dropdown',
        parent_field_id: DEPENDENCY_FIELD_ID,
        relationship_definition_id: RELATIONSHIP_DEFINITION_ID,
        relationship_parent_kind: 'organization',
        relationship_parent_side: 'source',
        related_kind: 'custom_object',
        related_custom_object_id: objectId,
        related_primary_display_field_id: primaryFieldId,
        option_source: {
          version: 1,
          kind: 'distinct',
          custom_object_id: objectId,
          primary_display_field_id: primaryFieldId,
          value_field_id: valueFieldId,
          filters: [],
        },
      }],
    }],
  };
}

const roleFeatures = new Map([
  ['schema-view', new Set([VIEW_SCHEMA_FEATURE])],
  ['schema-manage', new Set([MANAGE_SCHEMA_FEATURE])],
  ['schema-view-primary-denied', new Set([VIEW_SCHEMA_FEATURE])],
]);

async function featureAccess(roleId, feature) {
  return roleFeatures.get(roleId)?.has(feature) || false;
}

/**
 * This is deliberately the same boundary argument assembly as the two
 * generic Form routes.  It invokes the production validator, rather than
 * duplicating any source or permission checks in this test.
 */
async function invokeEntityFormValidation({
  operation,
  tenantContext,
  form,
  isAdmin = true,
  includeTrustedCapabilities = true,
  spoofedBodyCapabilities = false,
  tables = BASE_TABLES,
} = {}) {
  const db = queryDb(tables);
  const persistedForm = {
    ...recordsForm(),
    ...form,
  };
  const body = operation === 'create'
    ? {
      ...form,
      ...(spoofedBodyCapabilities
        ? { canViewSchema: true, canManageSchema: true, isTenantUser: true }
        : {}),
    }
    : {
      fields: form.fields,
      ...(spoofedBodyCapabilities
        ? { canViewSchema: true, canManageSchema: true, isTenantUser: true }
        : {}),
    };
  const effectiveForm = operation === 'create'
    ? body
    : { ...persistedForm, ...body };
  const trustedCapabilities = includeTrustedCapabilities
    ? await resolveTrustedSchemaCapabilities(
      tenantContext,
      { hasFeatureAccess: featureAccess },
    )
    : {};
  const result = await validateFormRowSourceConfiguration({
    db,
    tenantId: tenantContext.effectiveTenantId || tenantContext.tenantId,
    form: effectiveForm,
    canConfigure: !!tenantContext.tenantUserId || isAdmin,
    isTenantUser: !!tenantContext.tenantUserId,
    authorRoleId: tenantContext.roleId,
    ...trustedCapabilities,
  });
  return { db, result };
}

function rowSourceValidationBlock(source) {
  const start = source.indexOf('const rowSourceValidation = await validateFormRowSourceConfiguration({');
  assert.notEqual(start, -1, 'entity route must call the row source validator');
  const end = source.indexOf('if (!rowSourceValidation.ok)', start);
  assert.notEqual(end, -1, 'entity route must handle row source validation errors');
  return source.slice(start, end);
}

test('generic Form create/update routes pass trusted schema capabilities to the real validator', async () => {
  for (const routeSource of [CREATE_ROUTE_SOURCE, UPDATE_ROUTE_SOURCE]) {
    const block = rowSourceValidationBlock(routeSource);
    assert.match(block, /canViewSchema:|\.{3}await resolveTrustedSchemaCapabilities\(tenantCtx\)/);
    assert.match(block, /canManageSchema:|\.{3}await resolveTrustedSchemaCapabilities\(tenantCtx\)/);
    assert.match(block, /isTenantUser: \!\!tenantCtx\.tenantUserId/);
    assert.match(block, /authorRoleId: tenantCtx\.roleId/);
  }

  for (const operation of ['create', 'update']) {
    const tenantUser = await invokeEntityFormValidation({
      operation,
      tenantContext: {
        isAuthenticated: true,
        tenantId: TENANT_ID,
        tenantUserId: 'tenant-user-1',
      },
      form: recordsForm(),
      isAdmin: false,
    });
    assert.deepEqual(tenantUser.result, { ok: true }, `${operation}: tenant user`);

    const schemaView = await invokeEntityFormValidation({
      operation,
      tenantContext: {
        isAuthenticated: true,
        tenantId: TENANT_ID,
        roleId: 'schema-view',
      },
      form: recordsForm(),
    });
    assert.deepEqual(schemaView.result, { ok: true }, `${operation}: schema view`);
    assert.equal(
      schemaView.db.calls.includes('custom_object_role_permission'),
      false,
      `${operation}: schema view must not require a record grant`,
    );

    const schemaManage = await invokeEntityFormValidation({
      operation,
      tenantContext: {
        isAuthenticated: true,
        tenantId: TENANT_ID,
        roleId: 'schema-manage',
      },
      form: recordsForm(),
    });
    assert.deepEqual(schemaManage.result, { ok: true }, `${operation}: schema manage`);
    assert.equal(
      schemaManage.db.calls.includes('custom_object_role_permission'),
      false,
      `${operation}: schema manage must not require a record grant`,
    );

    const restrictedGrant = await invokeEntityFormValidation({
      operation,
      tenantContext: {
        isAuthenticated: true,
        tenantId: TENANT_ID,
        roleId: 'restricted-grant',
      },
      form: recordsForm(),
    });
    assert.deepEqual(restrictedGrant.result, { ok: true }, `${operation}: restricted grant`);

    const noGrant = await invokeEntityFormValidation({
      operation,
      tenantContext: {
        isAuthenticated: true,
        tenantId: TENANT_ID,
        roleId: 'no-grant',
      },
      form: recordsForm(),
    });
    assert.equal(noGrant.result.status, 403, `${operation}: no grant`);

    const excludedSchemaView = await invokeEntityFormValidation({
      operation,
      tenantContext: {
        isAuthenticated: true,
        tenantId: TENANT_ID,
        roleId: 'schema-view',
        memberExcludedFeatures: [VIEW_SCHEMA_FEATURE],
      },
      form: recordsForm(),
    });
    assert.equal(excludedSchemaView.result.status, 403, `${operation}: excluded view`);

    const excludedSchemaManage = await invokeEntityFormValidation({
      operation,
      tenantContext: {
        isAuthenticated: true,
        tenantId: TENANT_ID,
        roleId: 'schema-manage',
        memberExcludedFeatures: [MANAGE_SCHEMA_FEATURE],
      },
      form: recordsForm(),
    });
    assert.equal(excludedSchemaManage.result.status, 403, `${operation}: excluded manage`);
  }
});

test('the pre-fix route failure is reproducible, while trusted route capabilities repair it', async () => {
  const tenantContext = {
    isAuthenticated: true,
    tenantId: TENANT_ID,
    roleId: 'schema-view',
  };
  const oldRoute = await invokeEntityFormValidation({
    operation: 'create',
    tenantContext,
    form: recordsForm(),
    includeTrustedCapabilities: false,
  });
  assert.equal(oldRoute.result.status, 403);

  const fixedRoute = await invokeEntityFormValidation({
    operation: 'create',
    tenantContext,
    form: recordsForm(),
  });
  assert.deepEqual(fixedRoute.result, { ok: true });
});

test('the form admin gate and request-payload capability spoofing remain authoritative', async () => {
  const adminDenied = await invokeEntityFormValidation({
    operation: 'create',
    tenantContext: {
      isAuthenticated: true,
      tenantId: TENANT_ID,
      roleId: 'schema-view',
    },
    form: recordsForm(),
    isAdmin: false,
  });
  assert.equal(adminDenied.result.status, 403);
  assert.equal(adminDenied.result.code, 'ROW_OPTION_SOURCE_FORBIDDEN');

  const spoofed = await invokeEntityFormValidation({
    operation: 'update',
    tenantContext: {
      isAuthenticated: true,
      tenantId: TENANT_ID,
      roleId: 'no-grant',
    },
    form: recordsForm(),
    spoofedBodyCapabilities: true,
  });
  assert.equal(spoofed.result.status, 403);
  assert.equal(spoofed.result.code, 'ROW_OPTION_SOURCE_FORBIDDEN');
});

test('primary, distinct value, and filter field denials apply to trusted and record-grant authors', async () => {
  const cases = [{
    name: 'primary field',
    roleId: 'primary-denied',
    form: recordsForm(),
  }, {
    name: 'filter field',
    roleId: 'filter-denied',
    form: recordsForm(),
  }, {
    name: 'distinct value field',
    roleId: 'value-denied',
    form: distinctForm(),
  }, {
    name: 'schema-author primary field',
    roleId: 'schema-view-primary-denied',
    form: recordsForm(),
  }];

  for (const operation of ['create', 'update']) {
    for (const scenario of cases) {
      const result = await invokeEntityFormValidation({
        operation,
        tenantContext: {
          isAuthenticated: true,
          tenantId: TENANT_ID,
          roleId: scenario.roleId,
        },
        form: scenario.form,
      });
      assert.equal(
        result.result.status,
        403,
        `${operation}: ${scenario.name} must be denied`,
      );
      assert.equal(result.result.code, 'ROW_OPTION_SOURCE_FORBIDDEN');
    }
  }
});

test('foreign and archived object sources are rejected by the real persisted-source service', async () => {
  for (const operation of ['create', 'update']) {
    for (const [name, form] of [
      ['foreign object', recordsForm({
        objectId: FOREIGN_OBJECT_ID,
        primaryFieldId: FOREIGN_PRIMARY_FIELD_ID,
        filterFieldId: id(114),
      })],
      ['archived object', recordsForm({
        objectId: ARCHIVED_OBJECT_ID,
        primaryFieldId: ARCHIVED_PRIMARY_FIELD_ID,
        filterFieldId: id(115),
      })],
    ]) {
      const result = await invokeEntityFormValidation({
        operation,
        tenantContext: {
          isAuthenticated: true,
          tenantId: TENANT_ID,
          tenantUserId: 'tenant-user-1',
        },
        form,
      });
      assert.equal(result.result.status, 422, `${operation}: ${name}`);
      assert.equal(result.result.code, 'INVALID_ROW_OPTION_SOURCE');
      assert.match(result.result.error, /unavailable/);
    }
  }
});

test('distinct persisted sources use shared relationship metadata while record resolvers still reject them', async () => {
  const form = distinctForm();
  const service = createFormRelationshipService({
    db: queryDb(),
    tenantId: TENANT_ID,
  });

  await assert.doesNotReject(() => service.validatePersistedRowSource({
    form,
    fieldId: DISTINCT_SOURCE_FIELD_ID,
    containerFieldId: ROW_FIELD_ID,
  }));
  await assert.rejects(
    service.validateRecordReferencePicker({
      form,
      rootForm: form,
      fieldId: DISTINCT_SOURCE_FIELD_ID,
      containerFieldId: ROW_FIELD_ID,
    }),
    error => error.status === 409
      && /record-reference row source configuration is invalid/.test(error.message),
  );

  for (const [name, relationship] of [
    ['foreign relationship', {
      ...BASE_TABLES.custom_object_relationship_definition[0],
      tenant_id: FOREIGN_TENANT_ID,
    }],
    ['archived relationship', {
      ...BASE_TABLES.custom_object_relationship_definition[0],
      archived_at: '2026-01-01T00:00:00.000Z',
    }],
  ]) {
    const invalidService = createFormRelationshipService({
      db: queryDb({
        ...BASE_TABLES,
        custom_object_relationship_definition: [relationship],
      }),
      tenantId: TENANT_ID,
    });
    await assert.rejects(
      invalidService.validatePersistedRowSource({
        form,
        fieldId: DISTINCT_SOURCE_FIELD_ID,
        containerFieldId: ROW_FIELD_ID,
      }),
      error => error.status === 409
        && /Saved relationship configuration is unavailable/.test(error.message),
      name,
    );
  }
});
