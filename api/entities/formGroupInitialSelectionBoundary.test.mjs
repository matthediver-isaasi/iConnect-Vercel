import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const fixtureSlot = '__formGroupInitialSelectionBoundaryFixture';
const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const GROUP_ID = 'c8e4f12f-6ac3-4be7-9222-1f20bf0e4f8a';
const FOREIGN_GROUP_ID = '437be10c-ad04-4a99-8ae7-40af8f18cf6b';
const FORM_ID = 'e37d7cdd-ec31-4bcd-82f1-520fcb00249f';

// Exercise the real generic handlers and save validator against read/write
// fixtures. Unrelated services are isolated, following the role boundary tests.
async function loadHandler(entryPoint) {
  const absoluteEntry = resolve(entryPoint);
  const source = await readFile(absoluteEntry, 'utf8');
  const directImports = new Map();
  for (const [, clause, specifier] of source.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g)) {
    directImports.set(specifier, [directImports.get(specifier), clause].filter(Boolean).join(','));
  }
  function dependencyFixture(clause) {
    return clause.replace(/[{}]/g, '').split(',').map(value => value.trim()).filter(Boolean)
      .map(entry => {
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
        if (['validateFormWidthPayload', 'validateEventDisplayModePayload'].includes(imported)) {
          return `export const ${local} = () => null;`;
        }
        if (imported === 'validateFormMutationAccessSave') return `export const ${local} = () => ({ ok: true });`;
        if (imported === 'validateSurveyCompletionUpdate') return `export const ${local} = async () => [];`;
        if (['validateFormStripeAddressMappingConfig', 'validateFormRowSourceConfiguration',
          'validateFormMemberRoleAssignments', 'authorizeAnswerDrivenMemberRoleWrite'].includes(imported)) {
          return `export const ${local} = async () => ({ ok: true });`;
        }
        if (imported === 'resolveTrustedSchemaCapabilities') return `export const ${local} = async () => ({});`;
        if (imported === 'authorizeGenericCommunicationPreferenceAccess') return `export const ${local} = async () => null;`;
        if (/^(is|has|reject|rulesUse)/.test(imported)) return `export const ${local} = () => false;`;
        return `export const ${local} = async () => undefined;`;
      }).join('\n');
  }
  const result = await build({
    entryPoints: [absoluteEntry], bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{
      name: 'form-group-initial-selection-fixture',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (args.importer !== absoluteEntry || !directImports.has(args.path)
            || args.path.endsWith('/formGroupInitialSelection.js')) return undefined;
          return { path: args.path, namespace: 'group-selection-fixture' };
        });
        builder.onLoad({ filter: /.*/, namespace: 'group-selection-fixture' }, args => {
          if (args.path.endsWith('/database.js')) {
            return { loader: 'js', contents: `export const supabase = {
              from: (...args) => globalThis.${fixtureSlot}.db.from(...args)
            };` };
          }
          if (args.path.endsWith('/tenantContext.js')) {
            return { loader: 'js', contents: `
              export const TENANT_SCOPE = { GLOBAL: 'global', TENANT: 'tenant', ORGANIZATION: 'organization', MEMBER: 'member' };
              export const getTenantContext = async () => globalThis.${fixtureSlot}.tenantContext;
              export const getEntityTenantScope = () => TENANT_SCOPE.TENANT;
              export const getTenantColumn = () => 'tenant_id';
              export const checkCrossOrgPermissions = async () => ({ hasCrossOrgAccess: false });
              export const checkCrossMemberPermissions = async () => ({ hasCrossMemberAccess: false });
              export const hasAdminAccess = async () => true;
              export const hasFeatureAccess = async () => true;
            ` };
          }
          return { loader: 'js', contents: dependencyFixture(directImports.get(args.path)) };
        });
      },
    }],
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).default;
}

const [createHandler, updateHandler] = await Promise.all([
  loadHandler('api/entities/[entity]/index.js'),
  loadHandler('api/entities/[entity]/[id].js'),
]);

function field(config) {
  return {
    id: 'group', type: 'organisation_group_dropdown',
    ...(config === undefined ? {} : { group_initial_selection: config }),
  };
}

function database({ persistedFields = [field()], groupLookupError = null } = {}) {
  const rows = {
    organization: [{ id: 'organization', tenant_id: TENANT_ID }],
    organization_group: [
      { id: GROUP_ID, tenant_id: TENANT_ID, name: 'Owned' },
      { id: FOREIGN_GROUP_ID, tenant_id: 'other-tenant', name: 'Foreign' },
    ],
    form: [{ id: FORM_ID, tenant_id: TENANT_ID, fields: persistedFields }],
  };
  const calls = [];
  const writes = [];
  return {
    calls, writes,
    from(table) {
      const call = { table, filters: [] };
      calls.push(call);
      const predicates = [];
      let write;
      let singular = false;
      const query = {
        select() { return query; },
        eq(column, value) {
          call.filters.push(['eq', column, value]);
          predicates.push(row => row[column] === value);
          return query;
        },
        in(column, values) {
          call.filters.push(['in', column, values]);
          predicates.push(row => values.includes(row[column]));
          return query;
        },
        is(column, value) { predicates.push(row => row[column] === value); return query; },
        order() { return query; },
        limit() { return query; },
        insert(value) { write = { action: 'insert', value: structuredClone(value) }; return query; },
        update(value) { write = { action: 'update', value: structuredClone(value) }; return query; },
        single() { singular = true; return execute(); },
        maybeSingle() { singular = true; return execute(); },
        then(resolvePromise, rejectPromise) { return execute().then(resolvePromise, rejectPromise); },
      };
      async function execute() {
        if (table === 'organization_group' && groupLookupError) return { data: null, error: groupLookupError };
        let selected = (rows[table] || []).filter(row => predicates.every(predicate => predicate(row)));
        if (write) {
          writes.push({ table, ...write });
          selected = [{ id: FORM_ID, ...selected[0], ...write.value }];
        }
        return { data: singular ? selected[0] || null : selected, error: null };
      }
      return query;
    },
  };
}

async function save(method, body, db = database(), context = {}) {
  globalThis[fixtureSlot] = {
    db,
    tenantContext: {
      isAuthenticated: true, tenantId: TENANT_ID, effectiveTenantId: TENANT_ID,
      tenantUserId: 'tenant-user', organizationId: 'organization',
      roleId: null, memberId: null, ...context,
    },
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    setHeader() {},
    end() { return this; },
  };
  await (method === 'POST' ? createHandler : updateHandler)({
    method, query: { entity: 'Form', ...(method === 'PATCH' ? { id: FORM_ID } : {}) },
    body, headers: {},
  }, res);
  return { res, db };
}

for (const method of ['POST', 'PATCH']) {
  test(`${method} form accepts legacy, none, URL, and tenant-owned specific initial selections`, async (t) => {
    for (const config of [
      undefined, { mode: 'none' }, { mode: 'url' },
      { mode: 'specific', group_id: GROUP_ID },
    ]) {
      await t.test(config?.mode || 'legacy', async () => {
        const fields = [field(config), {
          id: 'rows', type: 'repeatable_rows', child_fields: [field(config)],
        }];
        const { res, db } = await save(method, { fields });
        assert.equal(res.statusCode, method === 'POST' ? 201 : 200, JSON.stringify(res.body));
        assert.equal(db.writes.length, 1);
        assert.deepEqual(db.writes[0].value.fields, fields);
        const groupCalls = db.calls.filter(call => call.table === 'organization_group');
        assert.equal(groupCalls.length, config?.mode === 'specific' ? 1 : 0);
        if (groupCalls.length) assert.deepEqual(groupCalls[0].filters, [
          ['eq', 'tenant_id', TENANT_ID], ['in', 'id', [GROUP_ID]],
        ]);
      });
    }
  });

  test(`${method} form rejects malformed, tenant-external, and missing groups before any write`, async (t) => {
    for (const [label, config] of [
      ['unsupported mode', { mode: 'unknown' }],
      ['missing ID', { mode: 'specific' }],
      ['malformed ID', { mode: 'specific', group_id: 'invalid' }],
      ['foreign group', { mode: 'specific', group_id: FOREIGN_GROUP_ID }],
      ['deleted group', { mode: 'specific', group_id: '11111111-1111-4111-8111-111111111111' }],
      ['URL parameter override', { mode: 'url', url_parameter: 'another_parameter' }],
      ['URL persisted value', { mode: 'url', group_id: GROUP_ID }],
    ]) {
      for (const child of [false, true]) {
        await t.test(`${label}/${child ? 'child' : 'root'}`, async () => {
          const fields = child ? [{
            id: 'rows', type: 'repeatable_row', repeatable_row: { children: [field(config)] },
          }] : [field(config)];
          const { res, db } = await save(method, { fields });
          assert.equal(res.statusCode, 422, JSON.stringify(res.body));
          assert.equal(res.body.code, 'INVALID_GROUP_INITIAL_SELECTION');
          assert.deepEqual(db.writes, []);
        });
      }
    }
  });

  test(`${method} group ownership uses the effective tenant, not a submitted tenant_id`, async () => {
    const { res, db } = await save(method, {
      tenant_id: 'other-tenant', fields: [field({ mode: 'specific', group_id: FOREIGN_GROUP_ID })],
    }, database(), { tenantId: null });
    assert.equal(res.statusCode, 422, JSON.stringify(res.body));
    assert.deepEqual(db.writes, []);
    assert.ok(db.calls.find(call => call.table === 'organization_group')
      .filters.some(filter => filter[0] === 'eq' && filter[1] === 'tenant_id' && filter[2] === TENANT_ID));
  });

  test(`${method} group lookup failure fails closed without a form write`, async () => {
    const { res, db } = await save(method, {
      fields: [field({ mode: 'specific', group_id: GROUP_ID })],
    }, database({ groupLookupError: { message: 'group lookup unavailable' } }));
    assert.equal(res.statusCode, 500, JSON.stringify(res.body));
    assert.deepEqual(db.writes, []);
  });
}

test('PATCH validates the effective persisted configuration on metadata-only updates', async () => {
  const { res, db } = await save('PATCH', { name: 'Renamed' }, database({
    persistedFields: [field({ mode: 'specific', group_id: FOREIGN_GROUP_ID })],
  }));
  assert.equal(res.statusCode, 422, JSON.stringify(res.body));
  assert.equal(res.body.code, 'INVALID_GROUP_INITIAL_SELECTION');
  assert.deepEqual(db.writes, []);
});

test('PATCH can replace a stale persisted specific configuration with none or an absent legacy configuration', async (t) => {
  for (const config of [undefined, { mode: 'none' }]) {
    await t.test(config?.mode || 'legacy', async () => {
      const { res, db } = await save('PATCH', { fields: [field(config)] }, database({
        persistedFields: [field({ mode: 'specific', group_id: FOREIGN_GROUP_ID })],
      }));
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(db.writes.length, 1);
      assert.equal(db.calls.filter(call => call.table === 'organization_group').length, 0);
    });
  }
});