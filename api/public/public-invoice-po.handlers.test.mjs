import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { eventInvoiceContact } from '../_lib/eventInvoiceProducer.js';

// Run with scripts/run-isolated-tests.mjs. Only module boundaries are replaced;
// the actual exported HTTP handlers, validation, pricing and persistence run.
const slot = '__publicInvoicePoHandlerFixture';
const purchaser = { first_name: 'Public', last_name: 'Purchaser', email: 'purchaser@example.test', organization: 'Independent company' };
const attendee = { first_name: 'Different', last_name: 'Attendee', email: 'attendee@example.test' };
const imports = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g;
const handlers = {};

async function loadHandler(path) {
  const source = await readFile(path, 'utf8');
  const replacements = new Map();
  for (const [, names, specifier] of source.matchAll(imports)) {
    if (specifier.startsWith('node:') || specifier === 'crypto') continue;
    if (/publicTicket|publicInvoicePo|complexEventPricing|ticketAccess|ticketReleaseAccess|eventOptionSelections|attendeeJobTitleEnrichment/.test(specifier)) continue;
    const exports = [];
    if (names.trim().startsWith('{')) {
      for (const entry of names.replace(/[{}]/g, '').split(',').map(s => s.trim()).filter(Boolean)) {
        const name = entry.split(/\s+as\s+/)[0];
        if (name === 'supabase') exports.push(`export const supabase = { from: (...a) => globalThis.${slot}.db.from(...a), rpc: (...a) => globalThis.${slot}.db.rpc(...a) };`);
        else exports.push(`export function ${name}(...args) { return globalThis.${slot}.dependency(${JSON.stringify(name)}, args); }`);
      }
    } else {
      exports.push(`export default function(...args) { return globalThis.${slot}.dependency(${JSON.stringify(names.trim())}, args); }`);
    }
    replacements.set(specifier, exports.join('\n'));
  }
  const result = await build({
    entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{
      name: 'controlled-handler-dependencies',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (args.path.endsWith('/stripeCredentials.js')) return { path: 'ticket-credentials', namespace: 'fixture' };
          if (args.path === 'stripe') return { path: 'stripe', namespace: 'fixture' };
          if (replacements.has(args.path)) return { path: args.path, namespace: 'fixture' };
          // Supabase used by real pricing/helper modules shares the same fixture.
          if (args.path === '@supabase/supabase-js') return { path: args.path, namespace: 'fixture' };
        });
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
          contents: args.path === 'ticket-credentials'
            ? `export function getStripeCredentials(...args){return globalThis.${slot}.dependency('getStripeCredentials',args);} export function findOrCreateStripeCustomer(...args){return globalThis.${slot}.dependency('findOrCreateStripeCustomer',args);}`
            : args.path === 'stripe'
            ? `export default function(){return globalThis.${slot}.dependency('getStripeClient',[]);}`
            : args.path === '@supabase/supabase-js'
            ? `export const createClient = () => globalThis.${slot}.db;`
            : replacements.get(args.path), loader: 'js',
        }));
      },
    }],
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).default;
}

function fixture({ enabled = true, member = null, memberEmail = null, free = false, soldOut = false, loseRace = false, visibility = 'members_and_public', noTickets = false, paid = false, paymentStatus = 'succeeded', atomicSoldOut = false, refundFails = false } = {}) {
  const tickets = noTickets ? [] : [
    { id: 'ticket-a', name: 'Standard', price: free ? 0 : 25, is_free: free, visibility_mode: visibility, is_unlimited_tickets: false, available_count: 20 },
    { id: 'ticket-b', name: 'Premium', price: 50, visibility_mode: 'public_only', is_unlimited_tickets: false, available_count: 20 },
  ];
  const event = { id: 'event-a', tenant_id: 'tenant-a', title: 'Fixture event', status: 'published', event_state: 'active', available_seats: 20, allow_public_invoice_po: enabled, pricing_config: { ticket_classes: tickets } };
  const rows = {
    role: [{ id: 'contact-role', tenant_id: 'tenant-a' }],
    public_ticket_member_purchase: [],
    event: [event], complex_event: [event], complex_event_ticket_class: tickets.map(t => ({ ...t, tenant_id: 'tenant-a', complex_event_id: event.id })),
    booking: [], complex_event_booking: [], member: memberEmail ? [{ id: 'member-email', email: memberEmail, tenant_id: 'tenant-a', status: 'active' }] : [],
    system_settings: [{ tenant_id: 'tenant-a', setting_key: 'xero_invoice_enabled', setting_value: 'true' }],
    event_email: [], scheduled_email: [], complex_event_session: [], organization: [],
  };
  const calls = [];
  const paymentIntent = {
    id: 'pi_fixture', status: paymentStatus, amount: 5000, currency: 'gbp',
    metadata: { event_id: 'event-a', tenant_id: 'tenant-a',
      public_ticket_purchase_id: '00000000-0000-4000-8000-000000000001',
      ticket_class_id: 'ticket-a', ticket_class_ids: 'ticket-a', booking_type: 'guest_one_off_event' },
    latest_charge: { paid: true, captured: true, refunded: false, amount_refunded: 0 },
  };
  const unexpected = [];
  const db = {
    from(table) {
      if (!(table in rows)) unexpected.push(`table:${table}`);
      assert.ok(table in rows, `Unexpected table: ${table}`);
      let filters = [], operation = 'select', value, singular = false;
      const query = {
        select() { return query; },
        eq(k, v) { filters.push(r => r[k] === v); return query; },
        ilike(k, v) { filters.push(r => String(r[k]).toLowerCase() === v.toLowerCase()); return query; },
        filter(k, op, v) { assert.equal(op, 'imatch'); filters.push(r => new RegExp(v.replaceAll('[[:space:]]', '\\s'), 'i').test(String(r[k]))); return query; },
        in(k, values) { filters.push(r => values.includes(r[k])); return query; },
        neq(k, v) { filters.push(r => r[k] !== v); return query; },
        is(k, v) { filters.push(r => (r[k] ?? null) === v); return query; },
        order() { return query; }, limit() { return query; },
        single() { singular = true; return query; }, maybeSingle() { singular = true; return query; },
        insert(data) { operation = 'insert'; value = data; return query; },
        update(data) { operation = 'update'; value = data; return query; },
        delete() { operation = 'delete'; return query; },
        then(ok, fail) {
          calls.push({ table, operation, value });
          let selected = rows[table].filter(r => filters.every(f => f(r)));
          if (operation === 'insert') {
            selected = (Array.isArray(value) ? value : [value]).map((r, i) => ({ id: `${table}-${rows[table].length + i + 1}`, ...r }));
            rows[table].push(...selected);
          } else if (operation === 'update') selected.forEach(r => Object.assign(r, value));
          else if (operation === 'delete') rows[table] = rows[table].filter(r => !selected.includes(r));
          return Promise.resolve({ data: singular ? selected[0] || null : selected, error: null, count: selected.length }).then(ok, fail);
        },
        catch(fail) { return query.then(x => x, fail); },
      };
      return query;
    },
    async rpc(name, args) {
      calls.push({ rpc: name, args });
      if (name === 'lookup_public_ticket_member_emails') {
        return { data: rows.member.filter(row => row.tenant_id === args.p_tenant_id && args.p_emails.includes(row.email.trim().toLowerCase()))
          .map(row => ({ normalized_email: row.email.trim().toLowerCase() })) };
      }
      if (name === 'prepare_public_ticket_member_purchase') {
        const existing = rows.public_ticket_member_purchase.find(row => row.id === args.p_id);
        if (existing && JSON.stringify(existing.snapshot) !== JSON.stringify(args.p_snapshot)) return { error: { code: '23514' } };
        if (!existing) rows.public_ticket_member_purchase.push({
          id: args.p_id, tenant_id: args.p_tenant_id, event_id: args.p_event_id, event_kind: args.p_event_kind,
          snapshot: args.p_snapshot, state: 'prepared', booking_ids: [],
        });
        return { data: { id: args.p_id } };
      }
      if (name === 'insert_public_ticket_booking_batch') {
        const receipt = rows.public_ticket_member_purchase.find(row => row.id === args.p_purchase_id);
        if (atomicSoldOut) {
          receipt.state = 'retryable';
          receipt.last_error_code = 'capacity_refund_pending';
          return { data: { error: 'capacity_unavailable' } };
        }
        const table = receipt.event_kind === 'simple' ? 'booking' : 'complex_event_booking';
        const batch = args.p_rows.map((row, index) => ({ ...row, id: `atomic-${index}`, member_id: null, organization_id: null }));
        rows[table].push(...batch);
        receipt.booking_ids = batch.map(row => row.id);
        return { data: batch };
      }
      if (name === 'provision_public_ticket_members') {
        const receipt = rows.public_ticket_member_purchase.find(row => row.id === args.p_purchase_id);
        assert.equal(receipt.state, 'ready');
        for (const person of receipt.snapshot.people) rows.member.push({
          ...person.identity, tenant_id: receipt.tenant_id, role_id: person.role_id,
          login_enabled: false, show_in_directory: false,
        });
        receipt.state = 'completed';
        return { data: { state: 'completed', created: receipt.snapshot.people.length } };
      }
      if (name.startsWith('check_') && name.endsWith('ticket_capacity')) {
        const denied = soldOut || (loseRace && args.p_booking_ids?.length);
        // The real RPC removes the losing transaction's rows under an advisory
        // lock. Simulate that response to exercise handler compensation.
        if (denied && args.p_booking_ids) {
          for (const table of ['booking', 'complex_event_booking']) rows[table] = rows[table].filter(r => !args.p_booking_ids.includes(r.id));
        }
        return { data: { ok: !denied, remaining: denied ? 0 : 20 }, error: null };
      }
      if (name.startsWith('atomic_decrement_') || name === 'adjust_event_seats') return { data: 18, error: null };
      unexpected.push(`rpc:${name}`);
      throw new Error(`Unexpected RPC: ${name}`);
    },
  };
  return {
    rows, calls, db, unexpected, paymentIntent,
    dependency(name, args) {
      calls.push({ dependency: name });
      if (name === 'createClient') return db;
      if (name === 'resolveTenantFromRequest') return { id: 'tenant-a' };
      if (name === 'getTenantContext') return { tenantId: 'tenant-a' };
      if (name === 'getSessionMember') return member;
      if (name === 'getSession') return null;
      if (paid && name === 'getStripeClient') return {
        paymentIntents: { retrieve: async () => paymentIntent },
        refunds: { create: async (body, options) => {
          calls.push({ refund: body, options });
          if (refundFails) throw new Error('Temporary provider outage');
          paymentIntent.latest_charge.refunded = true;
          return { id: 're_fixture', status: 'succeeded' };
        } },
      };
      if (paid && name === 'getStripeCredentials') return { secret_key: 'fixture-not-a-secret', is_enabled: true };
      if (name === 'sharedSendConfirmationEmailsFromTemplate' || name === 'sendConfirmationEmailsFromTemplate') return [];
      if (name === 'scheduleComplexEventReminders') return;
      if (name === 'eventInvoiceContact') return eventInvoiceContact(...args);
      if (name === 'enqueueCheckoutEventInvoice') return { status: 'pending', queued: true };
      unexpected.push(`dependency:${name}`);
      throw new Error(`Unexpected provider/dependency call: ${name}`);
    },
  };
}

async function invoke(kind, options = {}, bodyOverride = {}) {
  const state = fixture(options);
  if (options.provisioning) {
    for (const ticket of [...state.rows.event[0].pricing_config.ticket_classes, ...state.rows.complex_event_ticket_class]) {
      ticket.create_member_records = true;
      ticket.new_member_role_id = 'contact-role';
      ticket.visibility_mode = 'public_only';
    }
  }
  globalThis[slot] = state;
  process.env.SUPABASE_URL = 'https://fixture.invalid';
  process.env.SUPABASE_SERVICE_KEY = 'fixture-not-a-secret';
  globalThis.fetch = async url => {
    if (options.paid && String(url).startsWith('https://api.stripe.com/v1/payment_intents/pi_fixture')) {
      state.calls.push({ dependency: 'providerPaymentVerification' });
      return { ok: true, json: async () => state.paymentIntent };
    }
    state.unexpected.push('network'); throw new Error('Unexpected network request');
  };
  handlers[kind] ||= await loadHandler(resolve(kind === 'simple' ? 'api/functions/[functionName].js' : 'api/public/complex-event-booking.js'));
  const body = kind === 'simple'
    ? { eventId: 'event-a', ticketsRequired: 2, totalCost: 50, paymentMethod: 'public_invoice_po', ticketClassId: 'ticket-a', isGuestBooking: true, guestInfo: purchaser, purchaser_info: purchaser, attendees: [attendee, { ...attendee, email: 'second@example.test' }], registrationMode: 'individual' }
    : { event_id: 'event-a', payment_method: 'public_invoice_po', purchaser_info: purchaser, items: [{ ticket_class_id: 'ticket-a', attendees: [attendee, { ...attendee, email: 'second@example.test' }] }] };
  const res = { statusCode: 200, setHeader() {}, status(n) { this.statusCode = n; return this; }, json(data) { this.body = data; return this; } };
  await handlers[kind]({ method: 'POST', query: { functionName: 'createOneOffEventBooking' }, headers: { host: 'fixture.invalid' }, body: { ...body, ...bodyOverride } }, res);
  return { ...state, res, bookings: state.rows[kind === 'simple' ? 'booking' : 'complex_event_booking'] };
}

for (const kind of ['simple', 'complex']) {
  for (const refundFails of [false, true]) {
    test(`${kind}: atomic capacity loss ${refundFails ? 'durably queues provider retry' : 'refunds captured payment'} without bookings or contacts`, async () => {
      const contact = { ...attendee, organization: 'Attendee company' };
      const result = await invoke(kind, { paid: true, provisioning: true, atomicSoldOut: true, refundFails }, {
        purchase_request_id: '00000000-0000-4000-8000-000000000001',
        ...(kind === 'simple'
          ? { paymentMethod: 'card', stripePaymentIntentId: 'pi_fixture', purchaserInfo: purchaser, attendees: [contact, { ...contact, email: 'second@example.test' }] }
          : { payment_method: 'card', stripe_payment_intent_id: 'pi_fixture', items: [{ ticket_class_id: 'ticket-a', attendees: [contact, { ...contact, email: 'second@example.test' }] }] }),
      });
      assert.equal(result.bookings.length, 0);
      assert.equal(result.rows.member.length, 0);
      assert.equal(result.res.body.refunded, !refundFails, JSON.stringify(result.res.body));
      assert.equal(result.rows.public_ticket_member_purchase[0].state, refundFails ? 'retryable' : 'excluded');
      assert.equal(result.rows.public_ticket_member_purchase[0].last_error_code, refundFails ? 'capacity_refund_pending' : 'capacity_refunded');
      const refunds = result.calls.filter(call => call.refund);
      assert.equal(refunds.length, 1);
      assert.match(refunds[0].options.idempotencyKey, /^public-ticket-capacity:/);
      assert.deepEqual(result.unexpected, []);
    });
  }
  for (const status of ['succeeded', 'requires_capture', 'canceled']) {
    test(`${kind}: enabled card checkout uses captured settlement, not ${status === 'succeeded' ? 'caller-supplied success' : status}`, async () => {
      const contact = { ...attendee, organization: 'Attendee company' };
      const result = await invoke(kind, { paid: true, provisioning: true, paymentStatus: status }, {
        purchase_request_id: '00000000-0000-4000-8000-000000000001',
        ...(kind === 'simple'
          ? { paymentMethod: 'card', stripePaymentIntentId: 'pi_fixture', purchaserInfo: purchaser, attendees: [contact, { ...contact, email: 'second@example.test' }] }
          : { payment_method: 'card', stripe_payment_intent_id: 'pi_fixture', items: [{ ticket_class_id: 'ticket-a', attendees: [contact, { ...contact, email: 'second@example.test' }] }] }),
      });
      assert.equal(result.rows.member.length, status === 'succeeded' ? 3 : 0, JSON.stringify(result.res.body));
      assert.equal(result.bookings.length, status === 'succeeded' ? 2 : 0, JSON.stringify(result.res.body));
      assert.deepEqual(result.unexpected, []);
    });
  }
  test(`${kind}: enabled free purchase provisions explicit buyer and attendees after atomic guest bookings`, async () => {
    const contact = { ...attendee, organization: 'Attendee company' };
    const result = await invoke(kind, { free: true, provisioning: true }, {
      purchase_request_id: '00000000-0000-4000-8000-000000000001',
      ...(kind === 'simple'
        ? { paymentMethod: 'free', totalCost: 0, purchaserInfo: purchaser, attendees: [contact, { ...contact, email: 'second@example.test' }] }
        : { payment_method: 'free', items: [{ ticket_class_id: 'ticket-a', attendees: [contact, { ...contact, email: 'second@example.test' }] }] }),
    });
    assert.equal(result.res.body.success, true, JSON.stringify(result.res.body));
    assert.equal(result.bookings.length, 2);
    assert.equal(result.rows.member.length, 3);
    assert.ok(result.bookings.every(row => row.member_id === null && row.organization_id === null));
    assert.ok(result.rows.member.every(row => row.login_enabled === false && row.show_in_directory === false));
    const insert = result.calls.findIndex(call => call.rpc === 'insert_public_ticket_booking_batch');
    const provision = result.calls.findIndex(call => call.rpc === 'provision_public_ticket_members');
    assert.ok(insert >= 0 && provision > insert);
    assert.deepEqual(result.unexpected, []);
  });
  test(`${kind}: enabling contact creation never provisions an unpaid Invoice / PO purchase`, async () => {
    const result = await invoke(kind, { provisioning: true });
    assert.equal(result.bookings.length, 2, JSON.stringify(result.res.body));
    assert.equal(result.rows.member.length, 0);
    assert.ok(!result.calls.some(call => /public_ticket/.test(call.rpc || '')));
  });
  test(`${kind}: legacy free registration without ticket classes still succeeds`, async () => {
    const result = await invoke(kind, { noTickets: true, free: true }, kind === 'simple'
      ? { paymentMethod: 'free', ticketClassId: null, totalCost: 0 }
      : { payment_method: 'free', items: [{ attendees: [attendee] }] });
    assert.equal(result.bookings.length, kind === 'simple' ? 2 : 1, JSON.stringify(result.res.body));
    assert.deepEqual(result.unexpected, []);
  });
  test(`${kind}: toggle off rejects invoice intention before bookings/providers`, async () => {
    const result = await invoke(kind, { enabled: false });
    assert.equal(result.bookings.length, 0);
    assert.match(result.res.body.error, /invoice|enabled|available/i);
  });
  for (const po of [undefined, 'PO-4575']) {
    test(`${kind}: public purchaser registers two attendees confirmed and unpaid, optional PO ${po || 'absent'}`, async () => {
      const result = await invoke(kind, {}, { purchase_order_number: po });
      assert.equal(result.bookings.length, 2, JSON.stringify(result.res.body));
      for (const booking of result.bookings) {
        assert.equal(booking.status, 'confirmed');
        assert.equal(booking.payment_method, 'public_invoice_po');
        assert.equal(booking.purchaser_context.classification, 'public_non_member');
        assert.equal(booking.purchaser_context.details.email, purchaser.email);
        assert.equal(booking.purchase_order_number || null, po || null);
        assert.equal(booking.stripe_payment_intent_id || null, null);
        assert.equal(booking.account_amount || booking.account_balance_amount || 0, 0);
        if (kind === 'complex') { assert.equal(booking.total_paid, 0); assert.equal(booking.payment_status, 'pending'); }
      }
      assert.ok(result.calls.some(c => c.rpc?.startsWith('check_')));
      assert.ok(!result.calls.some(c => /Accounting|Stripe|Xero/.test(c.dependency || '')));
      assert.deepEqual(result.unexpected, [], 'No caught-and-silenced provider or unconfigured fixture calls');
    });
  }
  test(`${kind}: member session cannot masquerade as public purchaser`, async () => {
    const result = await invoke(kind, { member: { id: 'member-a', tenant_id: 'tenant-a', email: purchaser.email } });
    assert.equal(result.bookings.length, 0);
    assert.match(result.res.body.error, /member|public|guest/i);
  });
  test(`${kind}: member purchaser email cannot masquerade as guest`, async () => {
    const result = await invoke(kind, { memberEmail: purchaser.email });
    assert.equal(result.bookings.length, 0);
    assert.match(result.res.body.error, /member|public|guest/i);
  });
  test(`${kind}: payment extras rejected without any charge`, async () => {
    const extras = kind === 'simple' ? { stripePaymentIntentId: 'pi_forged', trainingFundAmount: 10 } : { stripe_payment_intent_id: 'pi_forged', training_fund_amount: 10 };
    const result = await invoke(kind, {}, extras);
    assert.equal(result.bookings.length, 0);
    assert.ok(result.res.body.error);
    assert.ok(!result.calls.some(c => /Accounting|Stripe|Xero/.test(c.dependency || '')));
  });
  test(`${kind}: missing independent purchaser name is rejected`, async () => {
    const result = await invoke(kind, {}, { purchaser_info: { email: purchaser.email } });
    assert.equal(result.bookings.length, 0);
    assert.match(result.res.body.error, /purchaser|name|contact/i);
  });
  test(`${kind}: event toggle does not override members-only ticket visibility`, async () => {
    const result = await invoke(kind, { visibility: 'members_only' });
    assert.equal(result.bookings.length, 0);
    assert.match(result.res.body.error, /access|member|public|ticket/i);
  });
  test(`${kind}: vouchers alone cannot accompany public Invoice / PO`, async () => {
    const result = await invoke(kind, {}, kind === 'simple' ? { selectedVoucherIds: ['voucher-a'] } : { selected_voucher_ids: ['voucher-a'] });
    assert.equal(result.bookings.length, 0);
    assert.match(result.res.body.error, /combined|voucher|fund|payment/i);
  });
  test(`${kind}: sold out does not create unpaid bookings`, async () => {
    const result = await invoke(kind, { soldOut: true });
    assert.equal(result.bookings.length, 0);
    assert.match(result.res.body.error, /sold|seat|capacity|available/i);
  });
  test(`${kind}: losing post-insert capacity race returns failure with no retained bookings`, async () => {
    const result = await invoke(kind, { loseRace: true });
    assert.equal(result.bookings.length, 0);
    assert.ok(result.res.body.error);
    assert.ok(result.calls.some(c => c.rpc?.startsWith('check_') && c.args.p_booking_ids?.length === 2));
  });
  test(`${kind}: zero-cost invoice intentions rejected but ordinary free bookings succeed`, async () => {
    const override = kind === 'simple' ? { totalCost: 0 } : {};
    const rejected = await invoke(kind, { free: true }, override);
    assert.equal(rejected.bookings.length, 0);
    assert.match(rejected.res.body.error, /paid|zero|free/i);
    const freeOverride = kind === 'simple' ? { totalCost: 0, paymentMethod: 'free' } : { payment_method: 'free' };
    const result = await invoke(kind, { free: true, enabled: false }, freeOverride);
    assert.equal(result.bookings.length, 2, JSON.stringify(result.res.body));
    assert.ok(result.bookings.every(b => b.payment_method === 'free' && !b.purchaser_context));
  });
  test(`${kind}: ordinary card request without payment proof cannot create bookings`, { todo: kind === 'simple' ? 'Existing simple-handler card-without-intent bypass; needs separate security fix' : false }, async () => {
    const result = await invoke(kind, { enabled: false }, kind === 'simple' ? { paymentMethod: 'card' } : { payment_method: 'card' });
    assert.equal(result.bookings.length, 0);
    assert.ok(result.res.body.error);
  });
}

test('complex: mixed publicly available tickets preserve individual amounts and one purchaser snapshot', async () => {
  const result = await invoke('complex', {}, {
    items: [{ ticket_class_id: 'ticket-a', attendees: [attendee] }, { ticket_class_id: 'ticket-b', attendees: [{ ...attendee, email: 'other@example.test' }] }],
  });
  assert.equal(result.bookings.length, 2, JSON.stringify(result.res.body));
  assert.deepEqual(result.bookings.map(b => b.ticket_price), [25, 50]);
  assert.ok(result.bookings.every(b => b.total_paid === 0 && b.purchaser_context.details.email === purchaser.email));
});

test('public purchaser may book an attendee who is independently a member', async () => {
  for (const kind of ['simple', 'complex']) {
    const result = await invoke(kind, { memberEmail: attendee.email });
    assert.equal(result.bookings.length, 2, JSON.stringify(result.res.body));
    assert.ok(result.bookings.every(b => b.purchaser_context.classification === 'public_non_member'));
  }
});

test('complex: legacy member invoice remains its own pending payment method', async () => {
  const result = await invoke('complex', {
    enabled: false,
    member: { id: 'member-a', tenant_id: 'tenant-a', first_name: 'Member', last_name: 'Purchaser', email: 'member@example.test' },
  }, { payment_method: 'invoice' });
  assert.equal(result.bookings.length, 2, JSON.stringify(result.res.body));
  assert.ok(result.bookings.every(b => b.payment_method === 'invoice' && b.payment_status === 'pending' && !b.purchaser_context));
  // Legacy invoices now reach the durable queue, never an independent writer.
  assert.equal(result.res.statusCode, 201);
  assert.deepEqual(result.res.body.invoice_recovery, { status: 'pending', queued: true });
  assert.ok(result.calls.some(c => c.dependency === 'enqueueCheckoutEventInvoice'));
  assert.ok(!result.calls.some(c => c.dependency === 'getAccountingProvider'));
  assert.deepEqual(result.unexpected, []);
});