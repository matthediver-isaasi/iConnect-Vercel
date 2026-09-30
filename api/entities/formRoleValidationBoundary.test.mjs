import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const fixtureSlot = '__formRoleBoundaryFixture';
const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const LEGACY_DELETED_ROLE_ID = 'c8e4f12f-6ac3-4be7-9222-1f20bf0e4f8a';
const FULL_ROLE_ID = '437be10c-ad04-4a99-8ae7-40af8f18cf6b';
const LMIC_ROLE_ID = 'e37d7cdd-ec31-4bcd-82f1-520fcb00249f';
const SOURCE_FIELD_ID = 'field_1786367685995';

async function loadHandler(entryPoint) {
  const absoluteEntry = resolve(entryPoint);
  const source = await readFile(absoluteEntry, 'utf8');
  const directImports = new Map();
  const importPattern = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g;
  for (const [, clause, specifier] of source.matchAll(importPattern)) {
    directImports.set(specifier, [directImports.get(specifier), clause].filter(Boolean).join(','));
  }

  const dependencyFixture = (clause) => {
    const entries = clause.replace(/[{}]/g, '').split(',').map(value => value.trim()).filter(Boolean);
    return entries.map((entry) => {
      const [imported, local = imported] = entry.split(/\s+as\s+/);
      if (['StructuredActionContractError', 'FormRelationshipError', 'MemberDepartmentError'].includes(imported)) {
        return `export class ${local} extends Error {}`;
      }
      if (imported === 'PROTECTED_DEPARTMENT_TENANT_ID') return `export const ${local} = 'protected-tenant';`;
      if (imported === 'PROTECTED_FORM_HELPER_MESSAGE') return `export const ${local} = 'Protected form';`;
      if (imported === 'FORM_NOT_LISTED_LABELS_KEY') return `export const ${local} = '__labels';`;
      if (imported.startsWith('strip') || imported.startsWith('normalizeMemberOnly')) {
        return `export const ${local} = (...args) => args.at(-1);`;
      }
      if (imported === 'constrainGenericCommitmentMutation') return `export const ${local} = (_table, query) => query;`;
      if (imported === 'validateFormWidthPayload' || imported === 'validateEventDisplayModePayload') {
        return `export const ${local} = () => null;`;
      }
      if (imported === 'validateFormStripeAddressMappingConfig'
          || imported === 'validateFormRowSourceConfiguration') {
        return `export const ${local} = async () => ({ ok: true });`;
      }
      if (imported === 'resolveTrustedSchemaCapabilities') {
        return `export const ${local} = async () => ({});`;
      }
      if (imported === 'authorizeGenericCommunicationPreferenceAccess') {
        return `export const ${local} = async () => null;`;
      }
      if (imported === 'getSessionPlatformOwner' || imported === 'getSession') {
        return `export const ${local} = async () => null;`;
      }
      if (/^(is|has|reject|rulesUse)/.test(imported)) return `export const ${local} = () => false;`;
      return `export const ${local} = async () => undefined;`;
    }).join('\n');
  };

  const result = await build({
    entryPoints: [absoluteEntry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [{
      name: 'form-role-boundary-fixture',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (args.importer !== absoluteEntry || !directImports.has(args.path)
              || args.path.endsWith('/formMemberRoleAssignment.js')) return undefined;
          return { path: args.path, namespace: 'form-role-fixture' };
        });
        builder.onLoad({ filter: /.*/, namespace: 'form-role-fixture' }, args => {
          if (args.path.endsWith('/database.js')) {
            return {
              loader: 'js',
              contents: `export const supabase = new Proxy({}, { get: (_target, key) => {
                const value = globalThis.${fixtureSlot}.db[key];
                return typeof value === 'function' ? value.bind(globalThis.${fixtureSlot}.db) : value;
              } });`,
            };
          }
          if (!args.path.endsWith('/tenantContext.js')) {
            return { loader: 'js', contents: dependencyFixture(directImports.get(args.path)) };
          }
          return {
            loader: 'js',
            contents: `
              export const TENANT_SCOPE = {
                GLOBAL: 'global', TENANT: 'tenant', ORGANIZATION: 'organization', MEMBER: 'member'
              };
              export const getTenantContext = async () => globalThis.${fixtureSlot}.tenantContext;
              export const getEntityTenantScope = () => TENANT_SCOPE.TENANT;
              export const getTenantColumn = () => 'tenant_id';
              export const checkCrossOrgPermissions = async () => ({ hasCrossOrgAccess: false });
              export const checkCrossMemberPermissions = async () => ({ hasCrossMemberAccess: false });
              export const hasAdminAccess = async () => true;
              export const hasFeatureAccess = async () => true;
            `,
          };
        });
      },
    }],
  });
  const encoded = Buffer.from(result.outputFiles[0].text).toString('base64');
  return (await import(`data:text/javascript;base64,${encoded}`)).default;
}

const [createHandler, updateHandler] = await Promise.all([
  loadHandler('api/entities/[entity]/index.js'),
  loadHandler('api/entities/[entity]/[id].js'),
]);

function destinationFields(options = [
  'Full',
  'Full with NMC',
  'Overseas Full',
  'Overseas Full with NMC',
  'LMIC Full',
]) {
  return [{ id: SOURCE_FIELD_ID, type: 'select', options }];
}

function destinationPipelines(overrides = {}) {
  return {
    members: [{
      label: 'Primary Member',
      // This is the inert legacy role left on the source form. In from_field
      // mode it must neither be copied as the runtime role nor block the copy.
      role_id: LEGACY_DELETED_ROLE_ID,
      role_assignment: {
        mode: 'from_field',
        source_field_id: SOURCE_FIELD_ID,
        value_to_role_id: {
          Full: FULL_ROLE_ID,
          'Full with NMC': FULL_ROLE_ID,
          'Overseas Full': FULL_ROLE_ID,
          'Overseas Full with NMC': FULL_ROLE_ID,
          'LMIC Full': LMIC_ROLE_ID,
        },
        fallback: 'default',
        ...overrides,
      },
    }],
  };
}

function database({
  forms = [],
  roles = [
    { id: FULL_ROLE_ID, tenant_id: TENANT_ID },
    { id: LMIC_ROLE_ID, tenant_id: TENANT_ID },
  ],
  roleLookupError = null,
} = {}) {
  const rows = {
    organization: [{ id: 'org-destination', tenant_id: TENANT_ID }],
    form: forms.map(row => structuredClone(row)),
    role: roles.map(row => structuredClone(row)),
  };
  const calls = [];
  const writes = [];

  function from(table) {
    const call = { table, filters: [], selection: null };
    calls.push(call);
    let predicates = [];
    let write = null;
    let singular = false;
    const query = {
      select(selection) { call.selection = selection; return query; },
      eq(column, value) {
        call.filters.push(['eq', column, value]);
        predicates.push(row => row[column] === value);
        return query;
      },
      in(column, values) {
        call.filters.push(['in', column, [...values]]);
        predicates.push(row => values.includes(row[column]));
        return query;
      },
      is(column, value) {
        call.filters.push(['is', column, value]);
        predicates.push(row => row[column] === value);
        return query;
      },
      limit() { return query; },
      insert(value) {
        write = { action: 'insert', value: structuredClone(value) };
        return query;
      },
      update(value) {
        write = { action: 'update', value: structuredClone(value) };
        return query;
      },
      single() { singular = true; return execute(); },
      maybeSingle() { singular = true; return execute(); },
      then(resolvePromise, rejectPromise) {
        return execute().then(resolvePromise, rejectPromise);
      },
    };

    async function execute() {
      if (table === 'role' && roleLookupError) {
        return { data: null, error: roleLookupError };
      }
      const selected = (rows[table] || []).filter(row => predicates.every(predicate => predicate(row)));
      if (write?.action === 'insert') {
        const saved = { id: 'destination-form', ...write.value };
        writes.push({ table, action: 'insert', value: structuredClone(write.value) });
        rows[table] ||= [];
        rows[table].push(saved);
        return { data: singular ? saved : [saved], error: null };
      }
      if (write?.action === 'update') {
        writes.push({ table, action: 'update', value: structuredClone(write.value) });
        const saved = selected[0] ? { ...selected[0], ...write.value } : null;
        return { data: singular ? saved : saved ? [saved] : [], error: null };
      }
      return { data: singular ? selected[0] || null : selected, error: null };
    }
    return query;
  }

  return { from, calls, writes };
}

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader() {},
    end() { return this; },
  };
}

function context(overrides = {}) {
  return {
    isAuthenticated: true,
    tenantId: TENANT_ID,
    effectiveTenantId: TENANT_ID,
    tenantUserId: 'tenant-user-destination',
    organizationId: 'org-destination',
    roleId: null,
    memberId: null,
    ...overrides,
  };
}

async function create(body, db = database(), tenantContext = context()) {
  globalThis[fixtureSlot] = { db, tenantContext };
  const res = response();
  await createHandler({
    method: 'POST',
    query: { entity: 'Form' },
    body,
    headers: {},
  }, res);
  return { res, db };
}

async function update(body, db, tenantContext = context()) {
  globalThis[fixtureSlot] = { db, tenantContext };
  const res = response();
  await updateHandler({
    method: 'PATCH',
    query: { entity: 'Form', id: 'destination-form' },
    body,
    headers: {},
  }, res);
  return { res, db };
}

test('Form.create copies the verified destination configuration using the resolved tenant and ignores its deleted legacy from_field role_id', async () => {
  const fields = destinationFields();
  const entityPipelines = destinationPipelines();
  const sourceSnapshot = structuredClone({ fields, entityPipelines });
  const db = database();

  const { res } = await create({
    tenant_id: TENANT_ID,
    name: 'Destination copy',
    fields,
    entity_pipelines: entityPipelines,
  }, db);

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(db.writes.length, 1);
  assert.deepEqual({ fields, entityPipelines }, sourceSnapshot, 'copy validation must not mutate source config');
  const roleCall = db.calls.find(call => call.table === 'role');
  assert.deepEqual(roleCall.filters, [
    ['eq', 'tenant_id', TENANT_ID],
    ['in', 'id', [FULL_ROLE_ID, LMIC_ROLE_ID]],
  ]);
  assert.equal(roleCall.filters[1][2].includes(LEGACY_DELETED_ROLE_ID), false);
});

test('Form.create resolves an organization-only session to the effective tenant for role authorization and validation', async () => {
  const db = database();
  const { res } = await create({
    fields: destinationFields(),
    entity_pipelines: destinationPipelines(),
  }, db, context({ tenantId: null, effectiveTenantId: null }));

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const roleCall = db.calls.find(call => call.table === 'role');
  assert.ok(roleCall);
  assert.ok(roleCall.filters.some(filter => (
    filter[0] === 'eq' && filter[1] === 'tenant_id' && filter[2] === TENANT_ID
  )));
});

test('Form.create rejects foreign and deleted role references before insert', async (t) => {
  for (const [label, unavailableRoleId] of [
    ['foreign', '11111111-1111-4111-8111-111111111111'],
    ['deleted', LEGACY_DELETED_ROLE_ID],
  ]) {
    await t.test(label, async () => {
      const db = database();
      const { res } = await create({
        fields: destinationFields(),
        entity_pipelines: destinationPipelines({
          value_to_role_id: { Full: unavailableRoleId },
        }),
      }, db);
      assert.equal(res.statusCode, 422, JSON.stringify(res.body));
      assert.equal(res.body.code, 'INVALID_MEMBER_ROLE_ASSIGNMENT');
      assert.deepEqual(res.body.details.invalid_role_ids, [unavailableRoleId]);
      assert.deepEqual(db.writes, []);
    });
  }
});

test('Form.update field-only writes validate persisted pipelines against the effective tenant', async () => {
  const db = database({
    forms: [{
      id: 'destination-form',
      tenant_id: TENANT_ID,
      fields: destinationFields(),
      entity_pipelines: destinationPipelines(),
    }],
  });
  const changedFields = destinationFields(['Full', 'Full with NMC']);

  const { res } = await update(
    { fields: changedFields },
    db,
    context({ tenantId: null }),
  );

  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, 'INVALID_MEMBER_ROLE_ASSIGNMENT');
  assert.match(res.body.error, /no longer available/i);
  assert.deepEqual(db.writes, []);
  const persistedRoleLookup = db.calls.find(call => (
    call.table === 'form'
    && call.selection === 'fields, entity_pipelines'
  ));
  assert.ok(persistedRoleLookup);
  assert.ok(persistedRoleLookup.filters.some(filter => (
    filter[0] === 'eq' && filter[1] === 'tenant_id' && filter[2] === TENANT_ID
  )));
});

test('Form.update accepts from_field configuration with an inert deleted legacy role_id', async () => {
  const db = database({
    forms: [{
      id: 'destination-form',
      tenant_id: TENANT_ID,
      fields: destinationFields(),
      entity_pipelines: destinationPipelines(),
    }],
  });

  const { res } = await update({
    entity_pipelines: destinationPipelines(),
  }, db);

  assert.equal(res.statusCode, 200);
  assert.equal(db.writes.filter(write => write.action === 'update').length, 1);
  const roleCall = db.calls.find(call => call.table === 'role');
  assert.equal(roleCall.filters[1][2].includes(LEGACY_DELETED_ROLE_ID), false);
});

test('Form create/update role lookup failures fail closed without writes', async (t) => {
  await t.test('create', async () => {
    const db = database({ roleLookupError: { message: 'role lookup unavailable' } });
    const { res } = await create({
      fields: destinationFields(),
      entity_pipelines: destinationPipelines(),
    }, db);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(db.writes, []);
  });

  await t.test('update', async () => {
    const db = database({
      forms: [{
        id: 'destination-form',
        tenant_id: TENANT_ID,
        fields: destinationFields(),
        entity_pipelines: destinationPipelines(),
      }],
      roleLookupError: { message: 'role lookup unavailable' },
    });
    const { res } = await update({ entity_pipelines: destinationPipelines() }, db);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(db.writes, []);
  });
});