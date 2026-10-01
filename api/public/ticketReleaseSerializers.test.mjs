import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const slot = '__ticketReleasePublicFixture';
const handlers = new Map();

async function handler(file) {
  if (!handlers.has(file)) {
    const result = await build({
      entryPoints: [fileURLToPath(new URL(file, import.meta.url))],
      bundle: true, write: false, platform: 'node', format: 'esm',
      plugins: [{
        name: 'ticket-release-fixture',
        setup(builder) {
          builder.onResolve({ filter: /^@supabase\/supabase-js$|\/_lib\/(tenantResolver|eventCommercialCapacity)\.js$/ }, args => ({
            path: args.path, namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
            loader: 'js',
            contents: args.path === '@supabase/supabase-js'
              ? `export const createClient = () => globalThis.${slot};`
              : args.path.endsWith('/tenantResolver.js')
                ? 'export const resolveTenantFromRequest = async () => ({ id: "tenant-a" });'
                : 'export const getEventCommercialCapacity = async () => new Map(); export const mergeTicketCommercialCapacity = () => ({ true_available: null });',
          }));
        },
      }],
    });
    handlers.set(file, (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).default);
  }
  return handlers.get(file);
}

function database(seed) {
  return {
    from(table) {
      let filters = [];
      let single = false;
      let fields = '*';
      const query = {
        select(value) { fields = value; return query; },
        eq(key, value) { filters.push(row => row[key] === value); return query; },
        in(key, values) { filters.push(row => values.includes(row[key])); return query; },
        or() { return query; },
        order() { return query; },
        single() { single = true; return query; },
        maybeSingle() { single = true; return query; },
        then(resolve, reject) {
          // Honor column projections so missing release columns fail the tests.
          const rows = (seed[table] || []).filter(row => filters.every(filter => filter(row))).map(row => (
            fields === '*' ? row : Object.fromEntries(fields.split(',').map(field => field.trim()).map(field => [field, row[field]]))
          ));
          return Promise.resolve({ data: single ? rows[0] || null : rows, count: rows.length, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

async function invoke(file, tickets, extraPricing = {}) {
  const event = {
    id: 'event-a', tenant_id: 'tenant-a', title: 'Event', slug: 'event-a',
    status: 'published', start_date: '2036-01-01T12:00:00Z',
    pricing_config: { ticket_classes: tickets, ...extraPricing },
  };
  globalThis[slot] = database({
    event: [event], complex_event: [event],
    complex_event_ticket_class: tickets.map(ticket => ({ ...ticket, tenant_id: 'tenant-a', complex_event_id: event.id })),
  });
  process.env.SUPABASE_URL = 'https://fixture.invalid';
  process.env.SUPABASE_SERVICE_KEY = 'fixture-key';
  const res = {
    statusCode: 200, setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await (await handler(file))({ method: 'GET', query: { id: event.id } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return Array.isArray(res.body) ? res.body[0] : res.body;
}

const release = { release_at: '2035-07-01T09:00:00.000Z', release_timezone: 'Europe/London' };
const scheduled = {
  id: 'scheduled', name: 'Scheduled', price: 75, visibility_mode: 'members_and_public',
  is_unlimited_tickets: true, ...release,
  early_bird_enabled: true, early_bird_price: 55, early_bird_deadline: '2035-08-01T00:00:00Z',
};

for (const file of ['./event.js', './events.js', './complex-event.js', './complex-events.js']) {
  test(`${file} preserves future-release metadata and early bird prices without hiding upcoming tickets`, async () => {
    const payload = await invoke(file, [scheduled, { id: 'legacy', name: 'Legacy', price: 90, visibility_mode: 'public_only', is_unlimited_tickets: true }]);
    const tickets = payload.pricing_config.ticket_classes;
    assert.deepEqual(tickets.map(ticket => ticket.id), ['scheduled', 'legacy']);
    assert.equal(tickets[0].release_at, release.release_at);
    assert.equal(tickets[0].release_timezone, release.release_timezone);
    assert.equal(tickets[0].price, 75);
    assert.equal(tickets[0].early_bird_enabled, true);
    assert.equal(tickets[0].early_bird_price, 55);
    assert.equal(tickets[0].early_bird_deadline, scheduled.early_bird_deadline);
    assert.equal(tickets[1].release_at, null);
    assert.equal(tickets[1].release_timezone, null);
  });

  test(`${file} does not manufacture a ticket for empty pricing configuration`, async () => {
    const payload = await invoke(file, []);
    assert.equal(payload.pricing_config?.ticket_classes?.length || 0, 0);
  });

  test(`${file} keeps its existing audience visibility policy`, async () => {
    const payload = await invoke(file, [scheduled, { ...scheduled, id: 'members', visibility_mode: 'members_only' }]);
    const ids = payload.pricing_config.ticket_classes.map(ticket => ticket.id);
    // Complex detail deliberately returns all classes for downstream audience
    // handling; list endpoints and simple detail filter members-only classes.
    assert.deepEqual(ids, file === './complex-event.js' ? ['scheduled', 'members'] : ['scheduled']);
  });
}

test('simple detail retains allowGuestsToViewAllTickets for scheduled members-only tickets', async () => {
  const payload = await invoke('./event.js', [{ ...scheduled, visibility_mode: 'members_only' }], { allowGuestsToViewAllTickets: true });
  assert.equal(payload.pricing_config.ticket_classes[0].release_at, release.release_at);
});