import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isPublicInvoicePo, publicInvoicePurchaser } from './_publicInvoicePo.js';
import { normalizeGroupPayment, normalizeGroupPricePaid, normalizeGroupTicketPrices } from './_pricePaid.js';
import { attachReportCredits, projectCredits } from './_credits.js';
import { currencyFactor } from '../_lib/bookingCreditEvidence.js';

test('classification remains public after member linkage and excludes legacy invoice methods', () => {
  const booking = { payment_method: 'public_invoice_po', member_id: 'later-linked-member', purchaser_context: { classification: 'public_non_member' } };
  assert.equal(isPublicInvoicePo(booking), true);
  assert.equal(isPublicInvoicePo({ ...booking, purchaser_context: null }), false);
  assert.equal(isPublicInvoicePo({ ...booking, purchaser_context: { classification: 'member' } }), false);
  for (const method of ['invoice', 'account', 'card', 'free']) {
    assert.equal(isPublicInvoicePo({ ...booking, payment_method: method }), false);
  }
});

test('purchaser contact is allowlisted, never raw snapshot metadata', () => {
  assert.deepEqual(publicInvoicePurchaser({
    classification: 'public_non_member',
    internal_token: 'must-not-leak',
    details: { first_name: 'Test', email: 'test@example.invalid', phone: '123', organization_name: 'Organisation', access_token: 'must-not-leak', address: { token: 'must-not-leak' } },
  }), { first_name: 'Test', email: 'test@example.invalid', phone: '123', organization_name: 'Organisation' });
  assert.equal(publicInvoicePurchaser({ classification: 'member', details: { email: 'test@example.invalid' } }), null);
});

// Execute the actual route with deterministic auth/DB seams. No live credentials,
// network access or database writes are involved.
async function runRoute(context, admin, feature, { fixtures = {}, query = {}, failTable = null } = {}) {
  let source = await readFile(new URL('./event-registration-report.js', import.meta.url), 'utf8');
  source = source.replace(/^import .*;\r?$/gm, '');
  const prelude = `
    const isPublicInvoicePo = ${isPublicInvoicePo.toString()};
    const publicInvoicePurchaser = ${publicInvoicePurchaser.toString()};
    const buildEventCheckinFlagMap = async () => new Map();
    const currencyFactor = ${currencyFactor.toString()};
    const projectCredits = ${projectCredits.toString()};
    const attachReportCredits = ${attachReportCredits.toString()};
    const normalizeGroupPricePaid = ${normalizeGroupPricePaid.toString()};
    const knownMoney = ${((value) => {
      if (value === null || value === undefined || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }).toString()};
    const moneyToCents = ${((value) => {
      if (value === null || value === undefined || value === '') return 0;
      const number = Number(value);
      return Number.isFinite(number) ? Math.round((number + Number.EPSILON) * 100) : 0;
    }).toString()};
    const centsToMoney = ${(value => value / 100).toString()};
    const complexDiscountKey = ${((booking) => {
      const ticketIdentity = booking.ticket_class_id || booking.ticket_class_name || '';
      return `${ticketIdentity}::${moneyToCents(booking.ticket_price)}`;
    }).toString()};
    const complexDiscountCentsByRow = ${((rows) => {
      const discountByTicket = new Map();
      for (const booking of rows) {
        const discountCents = Math.max(0, moneyToCents(booking.discount_amount));
        if (discountCents > 0) {
          discountByTicket.set(complexDiscountKey(booking), discountCents);
        }
      }
      return rows.map(booking => {
        const ownDiscount = Math.max(0, moneyToCents(booking.discount_amount));
        return ownDiscount || discountByTicket.get(complexDiscountKey(booking)) || 0;
      });
    }).toString()};
    const normalizeGroupPayment = ${normalizeGroupPayment.toString()};
    const normalizeGroupTicketPrices = ${normalizeGroupTicketPrices.toString()};
    const fixtures = ${JSON.stringify(fixtures)};
    const failTable = ${JSON.stringify(failTable)};
    const queries = [];
    const ranges = [];
    const supabase = { from(table) {
      queries.push(table);
      let filters = [], start = 0, end = 1;
      const q = {
        select() { return q; },
        eq(key, value) { filters.push(row => row[key] === value); return q; },
        in(key, values) { filters.push(row => values.includes(row[key])); return q; },
        overlaps(key, values) { filters.push(row => values.some(value => row[key]?.includes(value))); return q; },
        gte(key, value) { filters.push(row => row[key] >= value); return q; },
        lt(key, value) { filters.push(row => row[key] < value); return q; },
        order() { return q; },
        range(from, to) { start = from; end = Math.min(to, from + 1); ranges.push({table, from, to}); return q; },
        then(resolve) {
          return Promise.resolve(table === failTable
            ? {data: null, error: {message: 'Test query failure'}}
            : { data: (fixtures[table] || []).filter(row => filters.every(f => f(row))).slice(start, end + 1), error: null }).then(resolve);
        }
      };
      return q;
    }};
    const getTenantContext = async () => (${JSON.stringify(context)});
    const hasAdminAccess = async () => ${JSON.stringify(admin)};
    const hasFeatureAccess = async (role, resource, exclusions) => {
      if (resource !== 'events.event-report') throw new Error('Incorrect report permission');
      return ${JSON.stringify(feature)} && !(exclusions || []).includes(resource);
    };
    export { queries, ranges };
  `;
  const module = await import(`data:text/javascript;base64,${Buffer.from(prelude + source).toString('base64')}`);
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await module.default({ method: 'GET', query }, res);
  return { ...res, queries: module.queries, ranges: module.ranges };
}

test('report rejects unauthenticated, non-admin, role-excluded and per-member excluded access before any query', async () => {
  for (const [context, admin, feature, status] of [
    [{ tenantId: 'tenant' }, false, true, 401],
    [{ tenantId: 'tenant', isAuthenticated: true }, false, true, 403],
    [{ tenantId: 'tenant', isAuthenticated: true, roleId: 'role' }, true, false, 403],
    [{ tenantId: 'tenant', isAuthenticated: true, roleId: 'role', memberExcludedFeatures: ['events.event-report'] }, true, true, 403],
    [{ tenantId: 'tenant', isAuthenticated: true, tenantMismatch: true }, true, true, 409],
  ]) {
    const result = await runRoute(context, admin, feature);
    assert.equal(result.code, status);
    assert.deepEqual(result.queries, []);
  }
});

test('authorized admin can load report options', async () => {
  const result = await runRoute({ tenantId: 'tenant', isAuthenticated: true, tenantUserId: 'admin' }, true, true);
  assert.equal(result.code, 200);
  assert.deepEqual(result.body.bookingGroups, []);
  assert.deepEqual(result.queries, ['event', 'complex_event']);
});

const adminContext = { tenantId: 'tenant', isAuthenticated: true, tenantUserId: 'admin' };
const contextSnapshot = { classification: 'public_non_member', details: { first_name: 'Public', last_name: 'Purchaser', email: 'public@example.invalid' } };

test('confirmed non-member one-off Invoice / PO registration is returned without invoice or payment', async () => {
  const result = await runRoute(adminContext, true, true, {
    fixtures: {
      event: [{ id: 'simple', title: 'Meeting', tenant_id: 'tenant', status: 'published', is_complex: false }],
      booking: [{
        id: 'public-booking', event_id: 'simple', tenant_id: 'tenant',
        booking_reference: 'OOE-regression', booking_group_reference: 'OOE-regression',
        member_id: null, is_guest_booking: true, status: 'confirmed',
        payment_method: 'public_invoice_po', purchaser_context: contextSnapshot,
        total_cost: 318.6, ticket_price: 318.6,
        xero_invoice_id: null, stripe_payment_intent_id: null,
        created_at: '2026-09-20T16:25:00.000Z',
      }],
    },
    query: { generate: 'true', eventId: 'simple' },
  });
  assert.equal(result.code, 200);
  assert.equal(result.body.bookingGroups.length, 1);
  const group = result.body.bookingGroups[0];
  assert.equal(group.isPublicInvoicePo, true);
  assert.equal(group.groupPayment.bookingReference, 'OOE-regression');
  assert.equal(group.groupPayment.totalCost, 318.6);
  assert.equal(group.groupPayment.ticketTotal, null);
  assert.equal(group.groupPayment.discount, null);
  assert.equal(group.groupPayment.totalAfterDiscount, 318.6);
  assert.equal(group.groupPayment.totalsStatus, 'unavailable_gross_snapshot');
  assert.equal(group.attendees[0].ticket_price, null);
  assert.equal(group.attendees[0].ticket_price_status, 'unavailable_gross_snapshot');
  assert.equal(group.attendees[0].raw_ticket_price, 318.6);
  assert.equal(group.attendees[0].status, 'confirmed');
  assert.equal(group.attendees[0].member_id, null);
  assert.equal(group.attendees[0].price_paid, 318.6);
  assert.equal(group.attendees[0].price_paid_status, 'pending');
});

test('handler pages past server cap, scopes tenant/event/date and preserves complete PO group and value', async () => {
  const events = Array.from({ length: 5 }, (_, i) => ({ id: `event-${i}`, title: `Event ${i}`, tenant_id: 'tenant', status: 'published' }));
  const bookings = Array.from({ length: 5 }, (_, i) => ({
    id: `booking-${i}`, event_id: 'event-4', tenant_id: 'tenant', member_id: 'later-member',
    booking_group_reference: 'GROUP', payment_method: 'public_invoice_po',
    purchaser_context: contextSnapshot, ticket_price: 25, total_paid: 0,
    purchase_order_number: 'PO-5', created_at: '2026-01-20T10:00:00.000Z',
    attendee_email: `attendee-${i}@example.invalid`, status: 'confirmed',
  }));
  const result = await runRoute(adminContext, true, true, {
    fixtures: { complex_event: events, complex_event_booking: [
      ...bookings,
      { ...bookings[0], id: 'other-tenant', tenant_id: 'other' },
      { ...bookings[0], id: 'other-event', event_id: 'event-0' },
      { ...bookings[0], id: 'old', created_at: '2025-01-01T00:00:00.000Z' },
    ] },
    query: { generate: 'true', eventId: 'event-4', dateFrom: '2026-01-01', dateTo: '2026-01-31' },
  });
  assert.equal(result.code, 200);
  assert.equal(result.body.events.length, 5);
  assert.equal(result.body.bookingGroups.length, 1);
  const group = result.body.bookingGroups[0];
  assert.equal(group.isPublicInvoicePo, true);
  assert.equal(group.attendeeCount, 5);
  assert.equal(group.attendees.length, 5);
  assert.equal(group.groupPayment.totalCost, 125);
  assert.equal(group.groupPayment.purchaseOrderNumber, 'PO-5');
  assert.equal(group.publicInvoicePurchaser.email, contextSnapshot.details.email);
  assert.deepEqual(result.ranges.filter(r => r.table === 'complex_event_booking').map(r => r.from), [0, 2, 4, 5]);
});

test('authorized report exposes source-specific complex net price without double-deducting code discount', async () => {
  const result = await runRoute(adminContext, true, true, {
    fixtures: {
      complex_event: [{
        id: 'complex-net', title: 'Complex net event', tenant_id: 'tenant',
        status: 'published', is_complex: true,
      }],
      complex_event_booking: [{
        id: 'complex-booking', event_id: 'complex-net', tenant_id: 'tenant',
        booking_reference: 'CEB-NET', booking_group_reference: 'CEB-NET',
        attendee_email: 'attendee@example.invalid', status: 'confirmed',
        ticket_price: 90, discount_amount: 10, voucher_amount: 20,
        training_fund_amount: 5, account_balance_amount: 15,
        total_paid: 90, payment_method: 'card', payment_status: 'paid',
        created_at: '2026-09-20T16:25:00.000Z',
      }],
    },
    query: { generate: 'true', eventId: 'complex-net' },
  });
  assert.equal(result.code, 200);
  assert.equal(result.body.bookingGroups.length, 1);
  assert.equal(result.body.bookingGroups[0].attendees[0].price_paid, 50);
  assert.equal(result.body.bookingGroups[0].attendees[0].price_paid_status, 'net');
  assert.equal(result.body.bookingGroups[0].attendees[0].ticket_price, 100);
  assert.equal(result.body.bookingGroups[0].attendees[0].raw_ticket_price, 90);
  assert.deepEqual(result.body.bookingGroups[0].groupPayment, {
    ...result.body.bookingGroups[0].groupPayment,
    ticketTotal: 100,
    totalCost: 90,
    totalAfterDiscount: 90,
    discount: 10,
    offerDiscount: 0,
    codeDiscount: 10,
    totalsStatus: 'available',
  });
});

test('standard PO BOGO report uses persisted gross snapshot, not discounted ticket_price', async () => {
  const snapshot = {
    classification: 'public_non_member',
    details: { email: 'buyer@example.invalid' },
    financial_snapshot: {
      version: 1,
      gross_ticket_unit_amount: 100,
      gross_ticket_total_amount: 200,
      offer_discount_amount: 100,
      total_after_offer_discount_amount: 100,
    },
  };
  const result = await runRoute(adminContext, true, true, {
    fixtures: {
      event: [{ id: 'bogo', title: 'BOGO', tenant_id: 'tenant', status: 'published' }],
      booking: [0, 1].map(index => ({
        id: `bogo-${index}`, event_id: 'bogo', tenant_id: 'tenant',
        booking_group_reference: 'BOGO-GROUP', booking_reference: `BOGO-${index}`,
        attendee_email: `a${index}@example.invalid`, status: 'confirmed',
        payment_method: 'public_invoice_po', purchaser_context: snapshot,
        ticket_price: 50, total_cost: 50,
        created_at: `2026-09-20T16:25:0${index}.000Z`,
      })),
    },
    query: { generate: 'true', eventId: 'bogo' },
  });
  const group = result.body.bookingGroups[0];
  assert.deepEqual({
    ticketTotal: group.groupPayment.ticketTotal,
    totalAfterDiscount: group.groupPayment.totalAfterDiscount,
    discount: group.groupPayment.discount,
    offerDiscount: group.groupPayment.offerDiscount,
    codeDiscount: group.groupPayment.codeDiscount,
    totalsStatus: group.groupPayment.totalsStatus,
  }, {
    ticketTotal: 200, totalAfterDiscount: 100, discount: 100,
    offerDiscount: 100, codeDiscount: 0, totalsStatus: 'available',
  });
  assert.deepEqual(group.attendees.map(attendee => attendee.ticket_price), [100, 100]);
  assert.ok(group.attendees.every(attendee => attendee.ticket_price_status === 'available'));
  assert.deepEqual(group.attendees.map(attendee => attendee.raw_ticket_price), [50, 50]);
});

test('complex discovery and booking failures are explicit, not successful empty reports', async () => {
  for (const failTable of ['complex_event', 'complex_event_booking']) {
    const result = await runRoute(adminContext, true, true, {
      failTable,
      fixtures: { complex_event: [{ id: 'complex', title: 'Complex', tenant_id: 'tenant', status: 'published' }] },
      query: { generate: 'true', eventId: 'complex' },
    });
    assert.equal(result.code, 500);
    assert.match(result.body.error, /Failed to fetch complex/);
    assert.equal(result.body.bookingGroups, undefined);
  }
});

test('import placeholders across guest/member and both booking tables are unknown, not free; tenant is isolated', async () => {
  const common = {
    tenant_id: 'tenant', status: 'confirmed', created_at: '2026-09-20T16:25:00.000Z',
    ticket_price: 0, payment_method: 'admin_import',
  };
  const result = await runRoute(adminContext, true, true, {
    fixtures: {
      event: [{ id: 'simple', tenant_id: 'tenant', status: 'published', title: 'Simple' }],
      complex_event: [{ id: 'complex', tenant_id: 'tenant', status: 'published', title: 'Complex' }],
      booking: [
        { ...common, id: 'guest', event_id: 'simple', member_id: null, is_guest_booking: true,
          total_cost: 0, booking_reference: 'IMP-1', booking_group_reference: 'IMPG-1' },
        { ...common, id: 'member', event_id: 'simple', member_id: 'member-1', is_guest_booking: false,
          total_cost: 0, booking_reference: 'IMP-2', booking_group_reference: 'IMPG-1' },
        { ...common, id: 'paid-evidence', event_id: 'simple', member_id: 'member-2',
          ticket_price: 50, total_cost: 50, booking_group_reference: 'KNOWN' },
        { ...common, id: 'foreign', tenant_id: 'other', event_id: 'simple', total_cost: 0 },
      ],
      complex_event_booking: [
        { ...common, id: 'complex-guest', event_id: 'complex', member_id: null,
          total_paid: null, booking_group_reference: 'IMPG-2' },
        { ...common, id: 'complex-member', event_id: 'complex', member_id: 'member-3',
          total_paid: 0, booking_group_reference: 'IMPG-2' },
        { ...common, id: 'foreign-complex', tenant_id: 'other', event_id: 'complex',
          total_paid: 0 },
      ],
    },
    query: { generate: 'true' },
  });
  assert.equal(result.code, 200);
  assert.equal(result.body.summary.totalBookings, 5);
  assert.equal(result.body.summary.countByMethod.admin_import, 3);
  assert.equal(result.body.summary.hasUnavailableRevenue, true);
  assert.equal(result.body.summary.hasUnavailableTicketTotal, true);
  assert.equal(result.body.summary.hasUnavailableDiscount, true);
  assert.equal(result.body.summary.hasUnavailableAfterDiscount, true);
  assert.equal(result.body.summary.hasUnavailablePricePaid, true);
  for (const group of result.body.bookingGroups.filter(group => group.groupRef?.startsWith('IMPG-'))) {
    assert.equal(group.groupPayment.paymentMethod, 'admin_import');
    assert.equal(group.groupPayment.totalCost, null);
    assert.equal(group.groupPayment.ticketTotal, null);
    assert.equal(group.groupPayment.totalAfterDiscount, null);
    assert.equal(group.groupPayment.totalsStatus, 'unavailable_import_financials');
    for (const attendee of group.attendees) {
      assert.equal(attendee.ticket_price, null);
      assert.equal(attendee.price_paid, null);
      assert.equal(attendee.price_paid_status, 'unavailable');
    }
  }
  const positive = result.body.bookingGroups.find(group => group.groupRef === 'KNOWN');
  assert.equal(positive.groupPayment.ticketTotal, 50);
  assert.equal(positive.attendees[0].price_paid, 50);
  assert.equal(positive.attendees[0].price_paid_status, 'unavailable');
});

test('report preserves free, paid, pending invoice/PO and unknown method distinctions', async () => {
  const methods = [
    { id: 'free', payment_method: 'free', ticket_price: 0, total_cost: 0 },
    { id: 'card', payment_method: 'card', ticket_price: 25, total_cost: 25, stripe_payment_intent_id: 'pi_test' },
    { id: 'invoice', payment_method: 'invoice', ticket_price: 30, total_cost: 30 },
    { id: 'po', payment_method: 'public_invoice_po', ticket_price: 40, total_cost: 40 },
    { id: 'unknown', payment_method: null, ticket_price: 35, total_cost: 35 },
  ];
  const result = await runRoute(adminContext, true, true, {
    fixtures: {
      event: [{ id: 'simple', tenant_id: 'tenant', status: 'published', title: 'Simple' }],
      booking: methods.map(row => ({
        ...row, event_id: 'simple', tenant_id: 'tenant', status: 'confirmed',
        created_at: '2026-09-20T16:25:00.000Z',
      })),
    },
    query: { eventId: 'simple' },
  });
  assert.equal(result.code, 200);
  assert.deepEqual(Object.fromEntries(result.body.bookingGroups.map(group => [
    group.attendees[0].id,
    [group.groupPayment.paymentMethod, group.attendees[0].price_paid, group.attendees[0].price_paid_status],
  ])), {
    free: ['free', 0, 'net'], card: ['card', 25, 'net'],
    invoice: ['invoice', 30, 'pending'], po: ['public_invoice_po', 40, 'pending'],
    unknown: [null, 35, 'unavailable'],
  });
});

test('missing gross or cost snapshots never fabricate canonical or legacy discount totals', async () => {
  const result = await runRoute(adminContext, true, true, {
    fixtures: {
      event: [{ id: 'simple', tenant_id: 'tenant', status: 'published' }],
      complex_event: [{ id: 'complex', tenant_id: 'tenant', status: 'published' }],
      booking: [
        { id: 'no-gross', event_id: 'simple', tenant_id: 'tenant', ticket_price: null,
          total_cost: 40, payment_method: 'invoice', status: 'confirmed' },
        { id: 'no-cost', event_id: 'simple', tenant_id: 'tenant', ticket_price: 50,
          total_cost: null, payment_method: 'invoice', status: 'confirmed' },
      ],
      complex_event_booking: [{ id: 'complex-no-price', event_id: 'complex',
        tenant_id: 'tenant', ticket_price: null, total_paid: null,
        payment_method: 'invoice', status: 'confirmed' }],
    },
    query: { generate: 'true' },
  });
  assert.equal(result.code, 200);
  assert.equal(result.body.summary.totalDiscount, 0);
  assert.equal(result.body.summary.hasUnavailableDiscount, true);
  assert.equal(result.body.summary.hasUnavailableRevenue, true);
  const groups = Object.fromEntries(result.body.bookingGroups.map(group => [group.attendees[0].id, group]));
  assert.equal(groups['no-gross'].groupPayment.totalAfterDiscount, 40);
  assert.equal(groups['no-gross'].groupPayment.ticketTotal, null);
  assert.equal(groups['no-gross'].groupPayment.discount, null);
  assert.equal(groups['no-cost'].groupPayment.totalCost, null);
  assert.equal(groups['no-cost'].groupPayment.ticketTotal, 50);
  assert.equal(groups['complex-no-price'].attendees[0].ticket_price, null);
  assert.equal(groups['complex-no-price'].attendees[0].total_cost, null);
  assert.equal(groups['complex-no-price'].groupPayment.totalAfterDiscount, null);
});