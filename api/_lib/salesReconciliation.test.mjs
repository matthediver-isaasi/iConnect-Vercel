import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseSalesReconciliationQuery, scanSalesReconciliationData,
} from './salesReconciliation.js';
import { createSalesReconciliationHandler } from '../sales/reconciliation.js';

const now = Date.parse('2026-09-15T12:00:00.000Z');

test('Sales reconciliation scanner detects allocation, booking, invoice, and stale-claim drift', () => {
  const findings = scanSalesReconciliationData({
    allocations: [{ id: 'allocation-1', event_id: 'event-1', ticket_type_id: 'ticket-1', allocated_places: 2 }],
    movements: [
      { allocation_id: 'allocation-1', movement_kind: 'allocated', places: 1 },
      { allocation_id: 'allocation-1', movement_kind: 'named', places: 2, metadata: { bookingKind: 'simple', bookingId: 'booking-1' } },
    ],
    bookingLinks: [{ id: 'link-1', allocation_id: 'allocation-1', booking_kind: 'simple', booking_id: 'booking-1' }],
    bookings: [{ id: 'booking-1', status: 'cancelled', event_id: 'event-1', ticket_class_id: 'ticket-1' }],
    sales: [{ id: 'sale-1', quote_version_id: 'version-1' }],
    invoices: [{ id: 'invoice-1', sale_id: 'sale-1', quote_version_id: 'version-other' }],
    invoiceAttempts: [{ id: 'attempt-1', state: 'started', started_at: '2026-09-15T11:49:00.000Z' }],
    customerMappings: [{ id: 'mapping-1', match_kind: 'creating', created_at: '2026-09-15T11:49:00.000Z' }],
  }, { now });
  assert.deepEqual(findings.map((item) => item.code), [
    'ACTIVE_ALLOCATION_BOOKING_NOT_CONFIRMED',
    'ALLOCATION_DESIGNATION_OUT_OF_BOUNDS',
    'ALLOCATION_MOVEMENT_TOTAL_MISMATCH',
    'INVOICE_SALE_SOURCE_MISMATCH',
    'STALE_CUSTOMER_MAPPING_CLAIM',
    'STALE_INVOICE_ATTEMPT',
  ]);
});

test('balanced cancelled booking links and current claims do not create findings', () => {
  assert.deepEqual(scanSalesReconciliationData({
    allocations: [{ id: 'allocation-1', event_id: 'event-1', ticket_type_id: 'ticket-1', allocated_places: 1 }],
    movements: [
      { allocation_id: 'allocation-1', movement_kind: 'allocated', places: 1 },
      { allocation_id: 'allocation-1', movement_kind: 'named', places: 1, metadata: { bookingKind: 'simple', bookingId: 'booking-1' } },
      { allocation_id: 'allocation-1', movement_kind: 'unnamed', places: 1, metadata: { bookingKind: 'simple', bookingId: 'booking-1' } },
    ],
    bookingLinks: [{ id: 'link-1', allocation_id: 'allocation-1', booking_kind: 'simple', booking_id: 'booking-1' }],
    bookings: [{ id: 'booking-1', status: 'cancelled', event_id: 'event-1', ticket_class_id: 'ticket-1' }],
    invoiceAttempts: [{ id: 'attempt-1', state: 'started', started_at: '2026-09-15T11:51:00.000Z' }],
  }, { now }), []);
});

test('invitation claim conversion keeps the named booking active for reconciliation', () => {
  const base = {
    allocations: [{ id: 'allocation-1', event_id: 'event-1', ticket_type_id: 'ticket-1', allocated_places: 1 }],
    movements: [
      { allocation_id: 'allocation-1', movement_kind: 'allocated', places: 1 },
      {
        allocation_id: 'allocation-1',
        movement_kind: 'reserved',
        places: 1,
        metadata: { invitationId: 'invite-1' },
      },
      {
        allocation_id: 'allocation-1',
        movement_kind: 'unreserved',
        places: 1,
        metadata: { invitationId: 'invite-1', bookingKind: 'simple', bookingId: 'booking-1' },
      },
      {
        allocation_id: 'allocation-1',
        movement_kind: 'named',
        places: 1,
        metadata: { invitationId: 'invite-1', bookingKind: 'simple', bookingId: 'booking-1' },
      },
    ],
    bookingLinks: [{ id: 'link-1', allocation_id: 'allocation-1', booking_kind: 'simple', booking_id: 'booking-1' }],
  };

  const cancelled = scanSalesReconciliationData({
    ...base,
    bookings: [{ id: 'booking-1', status: 'cancelled', event_id: 'event-1', ticket_class_id: 'ticket-1' }],
  }, { now });
  assert.deepEqual(cancelled.map((item) => item.code), ['ACTIVE_ALLOCATION_BOOKING_NOT_CONFIRMED']);

  const mismatched = scanSalesReconciliationData({
    ...base,
    bookings: [{ id: 'booking-1', status: 'confirmed', event_id: 'event-other', ticket_class_id: 'ticket-1' }],
  }, { now });
  assert.deepEqual(mismatched.map((item) => item.code), ['ALLOCATION_BOOKING_SOURCE_MISMATCH']);
});

test('Sales reconciliation endpoint is authenticated, bounded, and read-only', async () => {
  const response = {
    statusCode: null, body: null, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const handler = createSalesReconciliationHandler({
    db: {},
    now,
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant', tenantUserId: 'user' }),
    loadSalesReconciliationData: async () => ({}),
    scanSalesReconciliationData: () => [{ code: 'A' }, { code: 'B' }],
  });
  await handler({ method: 'GET', query: { limit: '1' } }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.items, [{ code: 'A' }]);
  assert.equal(response.body.truncated, true);
  assert.throws(() => parseSalesReconciliationQuery({ limit: '1001' }), /limit must be/);
});