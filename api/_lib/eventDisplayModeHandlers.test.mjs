import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const slot = '__eventDisplayModeHandlerFixture';
const handlers = new Map();

async function loadHandler(path) {
  const result = await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [{
      name: 'event-display-mode-handler-fixture',
      setup(builder) {
        builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, args => ({
          path: args.path,
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /\/_lib\/database\.js$/ }, args => ({
          path: args.path,
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /\/_lib\/tenantResolver\.js$/ }, args => ({
          path: args.path,
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /\/_lib\/eventCommercialCapacity\.js$/ }, args => ({
          path: args.path,
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /\/_lib\/tenantContext\.js$/ }, args => ({
          path: args.path,
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /\/_lib\/groupAdminEventWrite\.js$/ }, args => ({
          path: args.path,
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /\/_lib\/complexEventDateSync\.js$/ }, args => ({
          path: args.path,
          namespace: 'fixture',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => {
          if (args.path === '@supabase/supabase-js') {
            return { loader: 'js', contents: `export const createClient = () => globalThis.${slot}.db;` };
          }
          if (args.path.endsWith('/database.js')) {
            return {
              loader: 'js',
              contents: `export const supabase = { from: (...args) => globalThis.${slot}.db.from(...args) };`,
            };
          }
          if (args.path.endsWith('/tenantResolver.js')) {
            return {
              loader: 'js',
              contents: `export const resolveTenantFromRequest = async () => ({ id: globalThis.${slot}.tenantId });`,
            };
          }
          if (args.path.endsWith('/eventCommercialCapacity.js')) {
            return {
              loader: 'js',
              contents: [
                'export const getEventCommercialCapacity = async () => new Map();',
                'export const mergeTicketCommercialCapacity = () => ({ true_available: 0 });',
              ].join('\n'),
            };
          }
          if (args.path.endsWith('/tenantContext.js')) {
            return {
              loader: 'js',
              contents: [
                `export const getTenantContext = async () => globalThis.${slot}.tenantContext;`,
                'export const hasAdminAccess = () => true;',
              ].join('\n'),
            };
          }
          if (args.path.endsWith('/groupAdminEventWrite.js')) {
            return {
              loader: 'js',
              contents: 'export const authorizeGroupAdminEventAction = async () => ({ ok: true });',
            };
          }
          if (args.path.endsWith('/complexEventDateSync.js')) {
            return {
              loader: 'js',
              contents: 'export const recomputeComplexEventDates = async () => {};',
            };
          }
          throw new Error(`Unexpected fixture import: ${args.path}`);
        });
      },
    }],
  });
  const encoded = Buffer.from(result.outputFiles[0].text).toString('base64');
  return (await import(`data:text/javascript;base64,${encoded}`)).default;
}

async function getHandler(relativePath) {
  if (!handlers.has(relativePath)) {
    handlers.set(relativePath, await loadHandler(resolve(relativePath)));
  }
  return handlers.get(relativePath);
}

function createDatabase(seed) {
  const rows = Object.fromEntries(
    Object.entries(seed).map(([table, tableRows]) => [
      table,
      tableRows.map(row => structuredClone(row)),
    ]),
  );
  const effects = [];

  return {
    effects,
    from(table) {
      let filters = [];
      let singular = false;
      let write = null;
      const query = {
        select() { return query; },
        eq(field, value) {
          filters.push(row => row[field] === value);
          return query;
        },
        in(field, values) {
          filters.push(row => values.includes(row[field]));
          return query;
        },
        order() { return query; },
        single() { singular = true; return query; },
        maybeSingle() { singular = true; return query; },
        insert(value) {
          write = { action: 'insert', value: structuredClone(value) };
          effects.push({ table, ...write });
          return query;
        },
        delete() {
          write = { action: 'delete' };
          effects.push({ table, ...write });
          return query;
        },
        then(resolvePromise, rejectPromise) {
          if (write?.action === 'insert') {
            const inserted = Array.isArray(write.value) ? write.value : [write.value];
            const saved = inserted.map((row, index) => ({
              ...row,
              id: row.id || `${table}-copy-${index + 1}`,
            }));
            rows[table] ||= [];
            rows[table].push(...saved);
            const data = singular ? saved[0] : saved;
            return Promise.resolve({ data, error: null }).then(resolvePromise, rejectPromise);
          }
          if (write?.action === 'delete') {
            return Promise.resolve({ data: null, error: null }).then(resolvePromise, rejectPromise);
          }
          const selected = (rows[table] || []).filter(row => filters.every(filter => filter(row)));
          return Promise.resolve({
            data: singular ? selected[0] || null : selected,
            error: null,
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
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

async function invoke(relativePath, fixture, req) {
  globalThis[slot] = fixture;
  process.env.SUPABASE_URL = 'https://fixture.invalid';
  process.env.SUPABASE_SERVICE_KEY = 'fixture-key';
  const res = response();
  await (await getHandler(relativePath))(req, res);
  return res;
}

test('public simple-event detail payload returns persisted display modes', async () => {
  const event = {
    id: 'simple-source',
    tenant_id: 'tenant-a',
    slug: 'simple-source',
    title: 'Simple event',
    status: 'published',
    pricing_config: { ticket_classes: [] },
    speaker_display_mode: 'collapsed',
    sponsor_display_mode: 'hidden',
  };
  const db = createDatabase({ event: [event] });
  const res = await invoke('api/public/event.js', { db, tenantId: 'tenant-a' }, {
    method: 'GET',
    query: { id: event.id },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.speaker_display_mode, 'collapsed');
  assert.equal(res.body.sponsor_display_mode, 'hidden');
});

test('public complex-event detail payload returns persisted display modes', async () => {
  const event = {
    id: 'complex-source',
    tenant_id: 'tenant-a',
    slug: 'complex-source',
    title: 'Complex event',
    status: 'published',
    pricing_config: {},
    speaker_display_mode: 'hidden',
    sponsor_display_mode: 'expanded',
  };
  const db = createDatabase({
    complex_event: [event],
    complex_event_ticket_class: [],
    complex_event_track: [],
  });
  const res = await invoke('api/public/complex-event.js', { db, tenantId: 'tenant-a' }, {
    method: 'GET',
    query: { id: event.id },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.speaker_display_mode, 'hidden');
  assert.equal(res.body.sponsor_display_mode, 'expanded');
});

for (const config of [
  {
    label: 'simple event',
    path: 'api/events/[id]/duplicate.js',
    table: 'event',
    extraTables: {
      event_email: [],
      event_sponsor_assignment: [],
      event_resource_link: [],
      event_field: [],
      event_cta_button: [],
      event_booking_terms: [],
      event_timing: [],
      event_discount_code: [],
      event_training_fund: [],
      event_agenda_item: [],
    },
  },
  {
    label: 'complex event',
    path: 'api/complex-events/[id]/duplicate.js',
    table: 'complex_event',
    extraTables: {
      complex_event_track: [],
      complex_event_session: [],
      complex_event_ticket_class: [],
    },
  },
]) {
  test(`${config.label} duplicate handler persists both display modes`, async () => {
    const original = {
      id: `${config.table}-source`,
      tenant_id: 'tenant-a',
      slug: 'source',
      title: 'Source event',
      pricing_config: { ticket_classes: [] },
      speaker_display_mode: 'collapsed',
      sponsor_display_mode: 'hidden',
    };
    const db = createDatabase({
      [config.table]: [original],
      ...config.extraTables,
    });
    const res = await invoke(config.path, {
      db,
      tenantId: 'tenant-a',
      tenantContext: {
        isAuthenticated: true,
        tenantId: 'tenant-a',
        tenantUserId: 'admin-a',
      },
    }, {
      method: 'POST',
      query: { id: original.id },
    });

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const eventInsert = db.effects.find(effect => (
      effect.table === config.table && effect.action === 'insert'
    ));
    assert.ok(eventInsert);
    assert.equal(eventInsert.value.speaker_display_mode, 'collapsed');
    assert.equal(eventInsert.value.sponsor_display_mode, 'hidden');
  });
}