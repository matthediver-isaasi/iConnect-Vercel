import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { assertRequestedTicketsReleased, assertSimpleTicketsReleased } from '../_lib/ticketReleaseAccess.js';

// Real exported endpoints and release/compensation helpers, with fail-closed
// database/provider boundaries. Run under scripts/run-isolated-tests.mjs.
const slot = '__ticketReleaseFixture';
const handlers = {};
async function loadHandler(kind) {
  const path = resolve(kind.startsWith('simple') ? 'api/functions/[functionName].js'
    : `api/public/complex-event-${kind.endsWith('intent') ? 'payment-intent' : 'booking'}.js`);
  const source = await readFile(path, 'utf8');
  const replacements = new Map();
  for (const [, names, specifier] of source.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g)) {
    if (specifier.startsWith('node:') || specifier === 'crypto'
      || /ticketReleaseAccess|eventPaymentPolicyCompensation|complexEventPricing/.test(specifier)) continue;
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
      name: 'release-test-boundaries',
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

const email = 'person@example.test';
const attendee = { email, first_name: 'Test', last_name: 'Person' };
function fixture({ release = '2099-01-01T12:00:00Z', noTickets = false, completed = false,
  allocation = false, ticketReadError = false, intentStatus = 'succeeded', bound = true,
  scheduledFree = false, soleTicket = false, otherScheduled = false, missingPaymentEmail = false } = {}) {
  const tickets = noTickets ? [] : [
    { id: 'open', name: 'Open', price: 10, visibility_mode: 'members_and_public' },
    { id: 'scheduled', name: 'Scheduled', price: scheduledFree ? 0 : 10, is_free: scheduledFree, visibility_mode: 'members_and_public',
      release_at: release, release_timezone: release ? 'Europe/London' : null },
  ];
  if (soleTicket) tickets.splice(0, 1);
  if (otherScheduled && tickets[0]) Object.assign(tickets[0], { release_at: release, release_timezone: 'Europe/London' });
  const event = { id: 'event', tenant_id: 'tenant', status: 'published', event_state: 'active',
    pricing_config: { ticket_classes: tickets } };
  const rows = {
    event: [event], complex_event: [event],
    complex_event_ticket_class: tickets.map(t => ({ ...t, tenant_id: 'tenant', complex_event_id: 'event' })),
    booking: completed ? [{ id: 'booked', tenant_id: 'tenant', event_id: 'event', stripe_payment_intent_id: 'pi_paid', booking_reference: 'BK1', status: 'confirmed' }] : [],
    complex_event_booking: completed ? [{ id: 'booked', tenant_id: 'tenant', event_id: 'event', stripe_payment_intent_id: 'pi_paid' }] : [],
    member: [{ id: 'member', tenant_id: 'tenant', email }], organization: [],
  };
  const effects = [], unexpected = [];
  const paymentIntent = {
    id: 'pi_paid', status: intentStatus, metadata: {
      event_id: 'event', tenant_id: bound ? 'tenant' : 'foreign', member_email: missingPaymentEmail ? '' : email,
      ticket_class_id: 'scheduled',
    },
  };
  const db = {
    from(table) {
      assert.ok(table in rows, `Unexpected table ${table}`);
      let singular = false;
      const filters = [];
      const q = {
        select() { return q; }, eq(k, v) { filters.push(r => r[k] === v); return q; },
        ilike(k, v) { filters.push(r => r[k]?.toLowerCase() === v.toLowerCase()); return q; },
        in(k, values) { filters.push(r => values.includes(r[k])); return q; },
        limit() { return q; }, single() { singular = true; return q; }, maybeSingle() { singular = true; return q; },
        insert() { effects.push('insert'); throw new Error('Unexpected write'); },
        update() { effects.push('update'); throw new Error('Unexpected write'); },
        delete() { effects.push('delete'); throw new Error('Unexpected write'); },
        then(ok, fail) {
          const selected = rows[table].filter(r => filters.every(f => f(r)));
          return Promise.resolve({
            data: singular ? selected[0] || null : selected,
            error: ticketReadError && table === 'complex_event_ticket_class' ? { message: 'offline' } : null,
          }).then(ok, fail);
        },
      };
      return q;
    },
    rpc(name) { effects.push(`rpc:${name}`); throw new Error('Unexpected mutation RPC'); },
  };
  const stripe = {
    paymentIntents: {
      async create(payload) { effects.push({ intent: payload }); return { id: 'pi_created', client_secret: 'secret' }; },
      async retrieve() { return paymentIntent; },
      async cancel() { effects.push('cancel'); },
    },
    refunds: { async create() { effects.push('refund'); } },
  };
  return {
    rows, db, effects, unexpected, event, tickets,
    dependency(name) {
      if (name === 'createClient') return db;
      if (name === 'resolveTenantFromRequest') return { id: 'tenant' };
      if (name === 'getTenantContext') return { tenantId: 'tenant' };
      if (name === 'getSessionMember') return null;
      if (name === 'loadEventPaymentPolicy') return {};
      if (name === 'assertEventPaymentMethodsAllowed') return;
      if (name === 'normalizeRequestedVoucherIds') return [];
      if (name === 'getStripeClient' || name === 'Stripe') return stripe;
      if (name === 'getStripeCredentials') return { secret_key: 'fixture', publishable_key: 'fixture', is_enabled: true };
      if (name === 'calculateComplexEventCreditQuote') return { remainingMinor: 1000, trainingFundMinor: 0, voucherMinor: 0 };
      if (name === 'buildComplexEventCreditBinding') return 'binding';
      if (name === 'resolveAllocationInvitation' && allocation) {
        return { tenantId: 'tenant', eventId: 'event', eventKind: 'complex', ticketTypeId: 'scheduled', delegateEmail: email };
      }
      unexpected.push(name);
      throw new Error(`Unexpected dependency ${name}`);
    },
    async fetch(url) {
      if (url.endsWith('/payment_intents/pi_paid')) return { ok: true, json: async () => paymentIntent };
      if (url.endsWith('/refunds')) { effects.push('refund'); return { ok: true }; }
      if (url.endsWith('/cancel')) { effects.push('cancel'); return { ok: true }; }
      unexpected.push(url);
      throw new Error('Unexpected network');
    },
  };
}
async function invoke(kind, options = {}, override = {}) {
  const state = fixture(options);
  globalThis[slot] = state;
  globalThis.fetch = state.fetch;
  process.env.SUPABASE_URL = 'https://fixture.invalid';
  process.env.SUPABASE_SERVICE_KEY = 'fixture';
  handlers[kind] ||= await loadHandler(kind);
  const body = kind === 'simple-intent'
    ? { amount: 10, metadata: { event_id: 'event', ticket_class_id: 'scheduled' } }
    : kind === 'simple-booking' || kind === 'simple-program'
      ? { eventId: 'event', ticketsRequired: 1, totalCost: 10, ticketClassId: 'scheduled',
          paymentMethod: 'free', isGuestBooking: true, guestInfo: attendee, attendees: [attendee], memberEmail: email }
      : kind === 'complex-intent'
        ? { event_id: 'event', ticket_class_id: 'scheduled' }
        : { event_id: 'event', ticket_class_id: 'scheduled', payment_method: 'free', attendees: [attendee] };
  const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  await handlers[kind]({
    method: 'POST', query: { functionName: kind === 'simple-intent' ? 'createStripePaymentIntent'
      : kind === 'simple-program' ? 'createBooking' : 'createOneOffEventBooking' },
    body: { ...body, ...override }, headers: {},
  }, res);
  return { ...state, res };
}
const kinds = ['simple-intent', 'complex-intent', 'simple-booking', 'complex-booking', 'simple-program'];
for (const kind of kinds) {
  test(`${kind}: sole free ticket is still gated; caller clock/allocation flags ignored`, async () => {
    const result = await invoke(kind, { scheduledFree: true, soleTicket: true }, {
      now: '2100-01-01T00:00:00Z', allocationCovered: true,
      allocationContext: { ticketTypeId: 'scheduled', tenantId: 'tenant', eventId: 'event' },
    });
    assert.match(result.res.body.error, /Tickets available from/);
    assert.deepEqual(result.effects, []);
    assert.deepEqual(result.unexpected, []);
  });
  for (const id of ['scheduled', 'forged', 'default', null]) {
    test(`${kind}: future/missing/forged ticket ${id} has no side effects`, async () => {
      const override = kind === 'simple-intent' ? { metadata: { event_id: 'event', ticket_class_id: id } }
        : kind.startsWith('simple') ? { ticketClassId: id } : { ticket_class_id: id };
      const result = await invoke(kind, {}, override);
      assert.match(result.res.body.error, /Tickets available from|ticket class|ticket_class_id/);
      assert.deepEqual(result.effects, []);
      assert.deepEqual(result.unexpected, []);
    });
  }
}
for (const kind of ['simple-booking', 'complex-booking']) {
  for (const method of ['free', 'account', 'account_balance', 'invoice', 'public_invoice_po', 'voucher', 'training_fund', 'card']) {
    test(`${kind}: ${method} cannot bypass future release`, async () => {
      const result = await invoke(kind, {}, kind === 'simple-booking' ? { paymentMethod: method } : { payment_method: method });
      assert.match(result.res.body.error, /Tickets available from/);
      assert.deepEqual(result.effects, []);
      assert.deepEqual(result.unexpected, []);
    });
  }
  for (const [status, effect] of [['succeeded', 'refund'], ['requires_capture', 'cancel'], ['requires_payment_method', null]]) {
    test(`${kind}: rescheduled ${status} payment uses existing compensation`, async () => {
      const result = await invoke(kind, { intentStatus: status }, kind === 'simple-booking'
        ? { paymentMethod: 'card', stripePaymentIntentId: 'pi_paid' }
        : { payment_method: 'card', stripe_payment_intent_id: 'pi_paid' });
      assert.match(result.res.body.error, /Tickets available from/);
      assert.deepEqual(result.effects, effect ? [effect] : []);
      assert.deepEqual(result.unexpected, []);
    });
  }
  test(`${kind}: foreign payment never refunded`, async () => {
    const result = await invoke(kind, { bound: false }, kind === 'simple-booking'
      ? { paymentMethod: 'card', stripePaymentIntentId: 'pi_paid' }
      : { payment_method: 'card', stripe_payment_intent_id: 'pi_paid' });
    assert.equal(result.res.body.refund_failed, true);
    assert.deepEqual(result.effects, []);
  });
  test(`${kind}: legacy unbound card requires support rather than an unsafe refund`, async () => {
    const result = await invoke(kind, { missingPaymentEmail: true }, kind === 'simple-booking'
      ? { paymentMethod: 'card', stripePaymentIntentId: 'pi_paid' }
      : { payment_method: 'card', stripe_payment_intent_id: 'pi_paid' });
    assert.equal(result.res.body.refund_failed, true);
    assert.match(result.res.body.error, /contact support.*pi_paid/);
    assert.deepEqual(result.effects, []);
  });
  test(`${kind}: completed card response survives rescheduling`, async () => {
    const result = await invoke(kind, { completed: true }, kind === 'simple-booking'
      ? { paymentMethod: 'card', stripePaymentIntentId: 'pi_paid' }
      : { payment_method: 'card', stripe_payment_intent_id: 'pi_paid' });
    if (kind === 'simple-booking') assert.equal(result.res.body.already_processed, true);
    else assert.equal(result.res.statusCode, 409);
    assert.deepEqual(result.effects, []);
    assert.deepEqual(result.unexpected, []);
  });
}
for (const kind of ['complex-intent', 'complex-booking']) {
  test(`${kind}: every cart item checked before effects`, async () => {
    const result = await invoke(kind, {}, { items: [
      { ticket_class_id: 'open', attendee_count: 1, attendees: [attendee] },
      { ticket_class_id: 'scheduled', attendee_count: 1, attendees: [attendee] },
    ] });
    assert.match(result.res.body.error, /Tickets available from/);
    assert.deepEqual(result.effects, []);
  });
  test(`${kind}: ticket read failure fails closed`, async () => {
    const result = await invoke(kind, { ticketReadError: true });
    assert.match(result.res.body.error, /Unable to verify ticket availability/);
    assert.deepEqual(result.effects, []);
  });
}
for (const kind of ['simple-intent', 'complex-intent']) {
  for (const release of [null, '2000-01-01T12:00:00Z']) {
    test(`${kind}: unset/past release creates payment with stable ticket metadata`, async () => {
      const result = await invoke(kind, { release });
      assert.equal(result.res.statusCode, 200, JSON.stringify(result.res.body));
      const payload = result.effects.find(effect => effect.intent)?.intent;
      assert.equal(payload?.metadata.ticket_class_id, 'scheduled');
      assert.deepEqual(result.unexpected, []);
    });
  }
}
test('simple legacy no-ticket intent remains valid; configured ticket omission does not', async () => {
  const result = await invoke('simple-intent', { noTickets: true }, { metadata: { event_id: 'event' } });
  assert.equal(result.res.body.success, true);
});
test('simple payment requires an authoritative tenant-scoped event', async () => {
  const result = await invoke('simple-intent', {}, { metadata: { event_id: 'foreign', ticket_class_id: 'scheduled' } });
  assert.match(result.res.body.error, /Event not found/);
  assert.deepEqual(result.effects, []);
});
test('simple event payment cannot omit the event identifier', async () => {
  const result = await invoke('simple-intent', {}, { metadata: { ticket_class_id: 'scheduled' } });
  assert.match(result.res.body.error, /event_id is required/);
  assert.deepEqual(result.effects, []);
});
test('non-event program payment remains valid', async () => {
  const result = await invoke('simple-intent', {}, { metadata: { program_name: 'program' } });
  assert.equal(result.res.body.success, true);
});
test('forged donation flag does not bypass a scheduled ticket', async () => {
  const result = await invoke('simple-intent', {}, { metadata: { event_id: 'event', payment_type: 'donation' } });
  assert.match(result.res.body.error, /confirmed booking is required/);
  assert.deepEqual(result.effects, []);
});
test('post-booking donation remains valid after ticket rescheduling', async () => {
  const result = await invoke('simple-intent', { completed: true }, {
    metadata: { event_id: 'event', payment_type: 'donation', booking_reference: 'BK1' },
  });
  assert.equal(result.res.body.success, true);
});
test('complex guest intent binds supplied purchaser email for safe compensation', async () => {
  const result = await invoke('complex-intent', { release: null }, { purchaser_email: email });
  const intent = result.effects.find(effect => effect.intent)?.intent;
  assert.equal(intent.metadata.member_email, email);
  assert.equal(intent.receipt_email, email);
});
test('complex purchased invitation exempts only its fixed ticket in a cart', async () => {
  const result = await invoke('complex-intent', { allocation: true }, {
    allocation_invitation_token: 'verified-by-server',
    items: [{ ticket_class_id: 'scheduled', attendee_count: 1 }, { ticket_class_id: 'open', attendee_count: 1 }],
  });
  assert.equal(result.res.statusCode, 200, JSON.stringify(result.res.body));
  assert.equal(result.effects.filter(effect => effect.intent).length, 1);
  assert.deepEqual(result.unexpected, []);
});
test('complex invitation does not exempt a second unreleased ticket', async () => {
  const result = await invoke('complex-intent', { allocation: true, otherScheduled: true }, {
    allocation_invitation_token: 'verified-by-server',
    items: [{ ticket_class_id: 'scheduled', attendee_count: 1 }, { ticket_class_id: 'open', attendee_count: 1 }],
  });
  assert.match(result.res.body.error, /Tickets available from/);
  assert.deepEqual(result.effects, []);
});
test('simple multi-item payload is explicitly rejected before charging', async () => {
  const result = await invoke('simple-intent', {}, {
    metadata: { event_id: 'event', ticket_class_id: 'open' },
    items: [{ ticket_class_id: 'open' }, { ticket_class_id: 'scheduled' }],
  });
  assert.match(result.res.body.error, /one ticket class/);
  assert.deepEqual(result.effects, []);
});
test('release helper: exact instant, legacy flow and scoped purchased entitlement', () => {
  const { event, tickets } = fixture();
  assert.deepEqual(assertSimpleTicketsReleased({ ...event, pricing_config: {} }, [null]), [null]);
  const context = { tenantId: 'tenant', eventId: 'event', eventKind: 'simple', ticketTypeId: 'scheduled' };
  assert.equal(assertSimpleTicketsReleased(event, ['scheduled'], context)[0].id, 'scheduled');
  for (const change of [{ tenantId: 'other' }, { eventId: 'other' }, { eventKind: 'complex' }, { ticketTypeId: 'open' }]) {
    assert.throws(() => assertSimpleTicketsReleased(event, ['scheduled'], { ...context, ...change }), /Tickets available from/);
  }
  const originalNow = Date.now;
  try {
    Date.now = () => Date.parse(tickets[1].release_at);
    assert.equal(assertRequestedTicketsReleased({ event, tickets, ticketIds: ['scheduled'] })[0].id, 'scheduled');
  } finally { Date.now = originalNow; }
});