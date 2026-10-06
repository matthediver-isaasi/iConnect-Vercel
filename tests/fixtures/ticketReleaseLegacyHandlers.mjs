import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

// Importing this fixture registers no tests, changes no environment variables,
// and starts no server. invoke() runs the real simple handlers behind in-memory
// database/provider boundaries. Call sequentially when sharing this fixture.
const slot = '__legacyReleaseHandlerFixture';
let handlerPromise;
async function loadHandler() {
  const path = resolve('api/functions/[functionName].js');
  const source = await readFile(path, 'utf8');
  const replacements = new Map();
  for (const [, names, specifier] of source.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g)) {
    if (specifier.startsWith('node:') || specifier === 'crypto'
      || /ticketReleaseAccess|eventPaymentPolicyCompensation|complexEventPricing|ticketAccess|eventOptionSelections|attendeeJobTitleEnrichment/.test(specifier)) continue;
    const exports = [];
    if (names.trim().startsWith('{')) {
      for (const entry of names.replace(/[{}]/g, '').split(',').map(s => s.trim()).filter(Boolean)) {
        const name = entry.split(/\s+as\s+/)[0];
        exports.push(name === 'supabase'
          ? `export const supabase = { from: (...a) => globalThis.${slot}.db.from(...a), rpc: (...a) => globalThis.${slot}.db.rpc(...a) };`
          : `export function ${name}(...args) { return globalThis.${slot}.dependency(${JSON.stringify(name)}, args); }`);
      }
    } else {
      exports.push(`export default function(...args) { return globalThis.${slot}.dependency(${JSON.stringify(names.trim())}, args); }`);
    }
    replacements.set(specifier, exports.join('\n'));
  }
  const result = await build({
    entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{
      name: 'legacy-release-handler-boundaries',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (replacements.has(args.path) || args.path === '@supabase/supabase-js') {
            return { path: args.path, namespace: 'fixture' };
          }
        });
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
          contents: args.path === '@supabase/supabase-js'
            ? `export const createClient = () => globalThis.${slot}.db;`
            : replacements.get(args.path), loader: 'js',
        }));
      },
    }],
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).default;
}

export function createLegacySimpleHarness({ event: eventInput = {}, sessionMember = null } = {}) {
  const event = { id: 'event-a', tenant_id: 'tenant-a', title: 'Legacy event',
    status: 'published', event_state: 'active', available_seats: 20, ...eventInput };
  const rows = { event: [event], booking: [], member: [], organization: [],
    system_settings: [], event_email: [], scheduled_email: [], webinar: [] };
  const calls = [], unexpected = [], paymentIntents = new Map();
  const db = {
    from(table) {
      if (!(table in rows)) unexpected.push(`table:${table}`);
      assert.ok(table in rows, `Unexpected table ${table}`);
      const filters = [];
      let singular = false, operation = 'select', value, fields = '*';
      const q = {
        select(columns = '*') { fields = columns; return q; }, eq(k, v) { filters.push(r => r[k] === v); return q; },
        ilike(k, v) { filters.push(r => String(r[k]).toLowerCase() === v.toLowerCase()); return q; },
        in(k, values) { filters.push(r => values.includes(r[k])); return q; },
        neq(k, v) { filters.push(r => r[k] !== v); return q; },
        is(k, v) { filters.push(r => (r[k] ?? null) === v); return q; },
        order() { return q; }, limit() { return q; },
        single() { singular = true; return q; }, maybeSingle() { singular = true; return q; },
        insert(data) { operation = 'insert'; value = data; return q; },
        update(data) { operation = 'update'; value = data; return q; },
        delete() { operation = 'delete'; return q; },
        then(ok, fail) {
          calls.push({ table, operation, value });
          let selected = rows[table].filter(r => filters.every(f => f(r)));
          if (operation === 'insert') {
            selected = (Array.isArray(value) ? value : [value]).map((row, i) => ({ id: `${table}-${rows[table].length + i + 1}`, ...row }));
            rows[table].push(...selected);
          } else if (operation === 'update') selected.forEach(r => Object.assign(r, value));
          else if (operation === 'delete') rows[table] = rows[table].filter(r => !selected.includes(r));
          const projected = fields === '*' ? selected : selected.map(row => Object.fromEntries(
            fields.split(',').map(field => field.trim()).map(field => [field, row[field]]),
          ));
          return Promise.resolve({ data: singular ? projected[0] || null : projected, error: null, count: selected.length }).then(ok, fail);
        },
        catch(fail) { return q.then(x => x, fail); },
      };
      return q;
    },
    async rpc(name, args) {
      calls.push({ rpc: name, args });
      if (name === 'adjust_event_seats' || name.startsWith('atomic_decrement_')) return { data: 18, error: null };
      // A synthetic default must never enter the ticket-class capacity path.
      unexpected.push(`rpc:${name}`);
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  const stripe = { paymentIntents: {
    async create(payload) {
      const id = `pi_legacy_${paymentIntents.size + 1}`;
      calls.push({ provider: 'stripe.create', payload });
      const intent = { ...payload, id, status: 'succeeded', client_secret: `${id}_secret_fixture` };
      paymentIntents.set(id, intent);
      return intent;
    },
    async retrieve(id) {
      calls.push({ provider: 'stripe.retrieve', id });
      assert.ok(paymentIntents.has(id), 'Payment must be initialized by this harness');
      return paymentIntents.get(id);
    },
  } };
  const state = {
    rows, calls, unexpected, paymentIntents, db,
    dependency(name) {
      calls.push({ dependency: name });
      if (name === 'createClient') return db;
      if (name === 'resolveTenantFromRequest') return { id: event.tenant_id };
      if (name === 'getTenantContext') return { tenantId: event.tenant_id };
      if (name === 'getSessionMember') return sessionMember;
      if (name === 'needsPublicTicketMemberCreation') return false;
      if (name === 'loadPublicTicketPurchase') return null;
      if (name === 'eventInvoiceContact') return {};
      if (name === 'enqueueCheckoutEventInvoice') return { queued: true };
      if (name === 'getSession') return null;
      if (name === 'getStripeClient' || name === 'Stripe') return stripe;
      if (name === 'getStripeCredentials') return { secret_key: 'fixture', is_enabled: true };
      if (name === 'findOrCreateStripeCustomer') return { id: 'cus_legacy_fixture' };
      if (name === 'sharedSendConfirmationEmailsFromTemplate' || name === 'sendConfirmationEmailsFromTemplate') return [];
      unexpected.push(`dependency:${name}`);
      throw new Error(`Unexpected dependency ${name}`);
    },
    async invoke(functionName, body) {
      assert.ok(['createStripePaymentIntent', 'createOneOffEventBooking'].includes(functionName));
      const previous = { state: globalThis[slot], fetch: globalThis.fetch,
        url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY };
      globalThis[slot] = state;
      globalThis.fetch = async () => { unexpected.push('network'); throw new Error('Unexpected network'); };
      process.env.SUPABASE_URL = 'https://fixture.invalid';
      process.env.SUPABASE_SERVICE_KEY = 'fixture';
      try {
        handlerPromise ||= loadHandler();
        const handler = await handlerPromise;
        const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
          json(data) { this.body = data; return this; } };
        await handler({ method: 'POST', query: { functionName }, body, headers: {} }, res);
        return { res, response: res.body, bookings: rows.booking, calls, unexpected, paymentIntents };
      } finally {
        globalThis[slot] = previous.state;
        globalThis.fetch = previous.fetch;
        for (const [key, value] of [['SUPABASE_URL', previous.url], ['SUPABASE_SERVICE_KEY', previous.key]]) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
      }
    },
  };
  return state;
}

export async function runLegacySimpleRequest({ functionName, body, event, harness }) {
  const state = harness || createLegacySimpleHarness({ event });
  return state.invoke(functionName, body);
}