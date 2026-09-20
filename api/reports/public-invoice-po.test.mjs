import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isPublicInvoicePo, publicInvoicePurchaser } from './_publicInvoicePo.js';

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