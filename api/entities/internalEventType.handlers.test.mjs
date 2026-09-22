import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

const fixtureSlot = '__internalEventTypeEntityFixture';
const handlerCache = new Map();

async function loadHandler(relativePath) {
  const result = await build({
    entryPoints: [resolve(relativePath)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    plugins: [{
      name: 'internal-event-type-handler-fixture',
      setup(builder) {
        builder.onResolve({ filter: /database\.js$/ }, args => ({
          path: args.path,
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /tenantContext\.js$/ }, args => ({
          path: args.path,
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /memberGroupEventsAccess\.js$/ }, args => ({
          path: args.path,
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /\/_lib\/planQuota\.js$/ }, args => ({
          path: args.path,
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /\/_lib\/publicBaseUrl\.js$/ }, args => ({
          path: args.path,
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /\/_lib\/searchTextBuilder\.js$/ }, args => ({
          path: args.path,
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /\/_lib\/memberContentReindexHook\.js$/ }, args => ({
          path: args.path,
          namespace: 'fixture',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => {
          if (args.path.endsWith('/database.js')) {
            return {
              loader: 'js',
              contents: `export const supabase = { from: (...args) => globalThis.${fixtureSlot}.db.from(...args) };`,
            };
          }
          if (args.path.endsWith('/tenantContext.js')) {
            return {
              loader: 'js',
              contents: `
                export const TENANT_SCOPE = {
                  GLOBAL: 'global', TENANT: 'tenant',
                  ORGANIZATION: 'organization', MEMBER: 'member'
                };
                export const getTenantContext = async () => globalThis.${fixtureSlot}.tenantContext;
                export const getEntityTenantScope = () => TENANT_SCOPE.TENANT;
                export const getTenantColumn = () => 'tenant_id';
                export const hasAdminAccess = async ctx => ctx.admin === true;
                export const hasFeatureAccess = async () => false;
                export const checkCrossOrgPermissions = async () => ({ hasCrossOrgAccess: false });
                export const checkCrossMemberPermissions = async () => ({ hasCrossMemberAccess: false });
              `,
            };
          }
          if (args.path.endsWith('/memberGroupEventsAccess.js')) {
            return {
              loader: 'js',
              contents: `
                export const getCallerGroupEventsAccess = async () => ({
                  groups: globalThis.${fixtureSlot}.groups,
                  tenantContext: globalThis.${fixtureSlot}.tenantContext
                });
              `,
            };
          }
          if (args.path.endsWith('/planQuota.js')) {
            return {
              loader: 'js',
              contents: `
                export const checkMemberQuota = async () => ({ ok: true });
                export const checkEventQuota = async () => ({ ok: true });
              `,
            };
          }
          if (args.path.endsWith('/publicBaseUrl.js')) {
            return {
              loader: 'js',
              contents: `export const getTrustedBaseUrlForTenant = async () => 'https://fixture.invalid';`,
            };
          }
          if (args.path.endsWith('/searchTextBuilder.js')) {
            return {
              loader: 'js',
              contents: 'export const rebuildSearchTextForEntity = async () => {};',
            };
          }
          if (args.path.endsWith('/memberContentReindexHook.js')) {
            return {
              loader: 'js',
              contents: `
                export const reindexMemberContentEntitySafe = async () => {};
                export const deleteMemberContentEntitySafe = async () => {};
              `,
            };
          }
          throw new Error(`Unexpected fixture import: ${args.path}`);
        });
      },
    }],
  });
  const outputPath = resolve(`.cache/internal-event-type-${relativePath.endsWith('index.js') ? 'collection' : 'record'}.mjs`);
  await writeFile(outputPath, result.outputFiles[0].text);
  return (await import(pathToFileURL(outputPath).href)).default;
}

async function getHandler(relativePath) {
  if (!handlerCache.has(relativePath)) {
    handlerCache.set(relativePath, await loadHandler(relativePath));
  }
  return handlerCache.get(relativePath);
}

function createDatabase() {
  const rows = { event: [], complex_event: [] };
  let nextId = 1;
  let nextError = null;

  return {
    rows,
    failNext(error) {
      nextError = error;
    },
    from(table) {
      let filters = [];
      let singular = false;
      let operation = { type: 'read' };
      const query = {
        select() { return query; },
        eq(field, value) {
          filters.push(row => row[field] === value);
          return query;
        },
        neq(field, value) {
          filters.push(row => row[field] !== value);
          return query;
        },
        not() { return query; },
        or() { return query; },
        in(field, values) {
          filters.push(row => values.includes(row[field]));
          return query;
        },
        order() { return query; },
        range() { return query; },
        limit() { return query; },
        single() { singular = true; return query; },
        maybeSingle() { singular = true; return query; },
        insert(value) {
          operation = { type: 'insert', value: structuredClone(value) };
          return query;
        },
        update(value) {
          operation = { type: 'update', value: structuredClone(value) };
          return query;
        },
        then(resolvePromise, rejectPromise) {
          if (nextError && operation.type !== 'read') {
            const error = nextError;
            nextError = null;
            return Promise.resolve({ data: null, error }).then(resolvePromise, rejectPromise);
          }

          rows[table] ||= [];
          if (operation.type === 'insert') {
            const inserted = {
              id: operation.value.id || `${table}-${nextId++}`,
              internal_event_type: null,
              ...operation.value,
            };
            rows[table].push(inserted);
            return Promise.resolve({
              data: singular ? structuredClone(inserted) : [structuredClone(inserted)],
              error: null,
            }).then(resolvePromise, rejectPromise);
          }

          const matches = rows[table].filter(row => filters.every(filter => filter(row)));
          if (operation.type === 'update') {
            for (const row of matches) Object.assign(row, operation.value);
          }
          const selected = matches.map(row => structuredClone(row));
          return Promise.resolve({
            data: singular ? selected[0] || null : selected,
            error: singular && selected.length === 0
              ? { code: 'PGRST116', message: 'No rows' }
              : null,
            count: selected.length,
          }).then(resolvePromise, rejectPromise);
        },
      };
      return query;
    },
  };
}

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

async function invoke(path, fixture, request) {
  globalThis[fixtureSlot] = fixture;
  const res = response();
  await (await getHandler(path))({
    headers: {},
    body: {},
    query: {},
    ...request,
  }, res);
  return res;
}

const collectionPath = 'api/entities/[entity]/index.js';
const recordPath = 'api/entities/[entity]/[id].js';
const adminContext = {
  isAuthenticated: true,
  tenantId: 'tenant-a',
  effectiveTenantId: 'tenant-a',
  tenantUserId: 'admin-a',
  memberId: 'admin-member',
  roleId: 'admin-role',
  admin: true,
};
const groupContext = {
  isAuthenticated: true,
  tenantId: 'tenant-a',
  effectiveTenantId: 'tenant-a',
  tenantUserId: null,
  memberId: 'group-admin-member',
  roleId: 'group-admin-role',
  admin: false,
};

for (const config of [
  { entity: 'Event', table: 'event', groupFlag: 'simpleEnabled' },
  { entity: 'ComplexEvent', table: 'complex_event', groupFlag: 'complexEnabled' },
]) {
  test(`${config.entity} generic handlers round-trip internal_event_type without unrelated clears`, async () => {
    const db = createDatabase();
    const fixture = { db, tenantContext: adminContext, groups: [] };

    const created = await invoke(collectionPath, fixture, {
      method: 'POST',
      query: { entity: config.entity },
      body: {
        title: `${config.entity} title`,
        member_group_id: 'group-a',
        internal_event_type: 'Conference',
      },
    });
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));
    assert.equal(created.body.internal_event_type, 'Conference');

    const id = created.body.id;
    const firstFreshRead = await invoke(recordPath, fixture, {
      method: 'GET',
      query: { entity: config.entity, id },
    });
    assert.equal(firstFreshRead.statusCode, 200);
    assert.equal(firstFreshRead.body.internal_event_type, 'Conference');

    const changed = await invoke(recordPath, fixture, {
      method: 'PATCH',
      query: { entity: config.entity, id },
      body: { internal_event_type: 'Training' },
    });
    assert.equal(changed.statusCode, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.internal_event_type, 'Training');
    assert.equal((await invoke(recordPath, fixture, {
      method: 'GET', query: { entity: config.entity, id },
    })).body.internal_event_type, 'Training');

    const adminUnrelatedSave = await invoke(recordPath, fixture, {
      method: 'PATCH',
      query: { entity: config.entity, id },
      body: { summary: 'Unrelated administrator change' },
    });
    assert.equal(adminUnrelatedSave.statusCode, 200);
    assert.equal(db.rows[config.table][0].internal_event_type, 'Training');

    const cleared = await invoke(recordPath, fixture, {
      method: 'PATCH',
      query: { entity: config.entity, id },
      body: { internal_event_type: null },
    });
    assert.equal(cleared.statusCode, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.internal_event_type, null);
    assert.equal((await invoke(recordPath, fixture, {
      method: 'GET', query: { entity: config.entity, id },
    })).body.internal_event_type, null);

    await invoke(recordPath, fixture, {
      method: 'PATCH',
      query: { entity: config.entity, id },
      body: { internal_event_type: 'Workshop' },
    });

    fixture.tenantContext = groupContext;
    fixture.groups = [{
      groupId: 'group-a',
      simpleEnabled: true,
      complexEnabled: true,
      [config.groupFlag]: true,
    }];
    const unrelatedSave = await invoke(recordPath, fixture, {
      method: 'PATCH',
      query: { entity: config.entity, id },
      body: {
        title: `${config.entity} renamed`,
        internal_event_type: null,
      },
    });
    assert.equal(unrelatedSave.statusCode, 200, JSON.stringify(unrelatedSave.body));
    assert.equal(unrelatedSave.body.internal_event_type, undefined);
    assert.equal(db.rows[config.table][0].internal_event_type, 'Workshop');

    const restrictedRead = await invoke(recordPath, fixture, {
      method: 'GET',
      query: { entity: config.entity, id },
    });
    assert.equal(restrictedRead.statusCode, 200);
    assert.equal(restrictedRead.body.internal_event_type, undefined);

    fixture.tenantContext = adminContext;
    const finalFreshRead = await invoke(recordPath, fixture, {
      method: 'GET',
      query: { entity: config.entity, id },
    });
    assert.equal(finalFreshRead.body.title, `${config.entity} renamed`);
    assert.equal(finalFreshRead.body.internal_event_type, 'Workshop');

    fixture.tenantContext = groupContext;
    fixture.groups = [{
      groupId: 'another-group',
      simpleEnabled: true,
      complexEnabled: true,
    }];
    const denied = await invoke(recordPath, fixture, {
      method: 'PATCH',
      query: { entity: config.entity, id },
      body: { title: 'Forbidden change' },
    });
    assert.equal(denied.statusCode, 403);
    assert.match(denied.body.error, /groups you administer/);

    fixture.tenantContext = adminContext;
    db.failNext({ code: 'DB_FIXTURE', message: 'fixture write failed' });
    const failed = await invoke(recordPath, fixture, {
      method: 'PATCH',
      query: { entity: config.entity, id },
      body: { internal_event_type: 'Should not persist' },
    });
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.body.error, 'fixture write failed');
    assert.equal(db.rows[config.table][0].internal_event_type, 'Workshop');
  });

  test(`${config.entity} group-admin create cannot persist or receive a private classification`, async () => {
    const db = createDatabase();
    const fixture = {
      db,
      tenantContext: groupContext,
      groups: [{ groupId: 'group-a', simpleEnabled: true, complexEnabled: true }],
    };
    const created = await invoke(collectionPath, fixture, {
      method: 'POST',
      query: { entity: config.entity },
      body: {
        title: 'Group event',
        member_group_id: 'group-a',
        internal_event_type: 'Crafted private classification',
      },
    });
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));
    assert.equal(Object.hasOwn(created.body, 'internal_event_type'), false);
    assert.equal(db.rows[config.table][0].internal_event_type, null);
  });
}
