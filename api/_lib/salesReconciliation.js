import { SalesHttpError } from './salesAccess.js';
import { readSalesReportSource, SALES_REPORT_MAX_SCAN } from './salesReports.js';

export const SALES_RECONCILIATION_MAX_FINDINGS = 1000;
const STALE_CLAIM_MS = 10 * 60 * 1000;

const id = (value) => String(value ?? '');
const integer = (value) => Number.isSafeInteger(Number(value)) ? Number(value) : 0;

export function parseSalesReconciliationQuery(query = {}) {
  const limit = Number(query.limit || 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > SALES_RECONCILIATION_MAX_FINDINGS) {
    throw new SalesHttpError(400, `limit must be an integer between 1 and ${SALES_RECONCILIATION_MAX_FINDINGS}`);
  }
  return { limit };
}

function finding(severity, code, entityType, entityId, message) {
  return { severity, code, entityType, entityId, message };
}

export function scanSalesReconciliationData(data = {}, { now = Date.now() } = {}) {
  const findings = [];
  const allocations = new Map((data.allocations || []).map((row) => [id(row.id), row]));
  const movements = new Map();
  const activeBookings = new Map();
  for (const movement of data.movements || []) {
    const allocationId = id(movement.allocation_id);
    const totals = movements.get(allocationId) || {
      allocated: 0, named: 0, reserved: 0, released: 0, cancelled: 0,
    };
    const places = integer(movement.places);
    if (movement.movement_kind === 'allocated') totals.allocated += places;
    if (movement.movement_kind === 'named') totals.named += places;
    if (movement.movement_kind === 'unnamed') totals.named -= places;
    if (movement.movement_kind === 'reserved') totals.reserved += places;
    if (movement.movement_kind === 'unreserved') totals.reserved -= places;
    if (movement.movement_kind === 'released') totals.released += places;
    if (movement.movement_kind === 'cancelled') totals.cancelled += places;
    movements.set(allocationId, totals);
    const bookingId = movement.metadata?.bookingId;
    const bookingKind = movement.metadata?.bookingKind;
    if (bookingId && bookingKind && ['named', 'reserved', 'unnamed', 'unreserved'].includes(movement.movement_kind)) {
      const key = `${bookingKind}:${bookingId}`;
      const current = activeBookings.get(key) || 0;
      const isDesignation = ['named', 'reserved'].includes(movement.movement_kind);
      // Claiming an invitation converts its reserved place into a named place.
      // That conversion writes an invitation-scoped `unreserved` movement with
      // the booking metadata for audit provenance; it does not unreconcile the
      // booking. Only booking-scoped inverse movements clear a designation.
      const isBookingReversal = !isDesignation && !movement.metadata?.invitationId;
      if (isDesignation || isBookingReversal) {
        activeBookings.set(key, current + (isDesignation ? places : -places));
      }
    }
  }
  for (const allocation of allocations.values()) {
    const total = movements.get(id(allocation.id)) || {
      allocated: 0, named: 0, reserved: 0, released: 0, cancelled: 0,
    };
    const remaining = total.allocated - total.released - total.cancelled;
    if (total.allocated !== integer(allocation.allocated_places)) {
      findings.push(finding('error', 'ALLOCATION_MOVEMENT_TOTAL_MISMATCH', 'allocation', allocation.id,
        'Allocated movement total does not equal the immutable allocation place count'));
    }
    if (remaining < 0 || total.named < 0 || total.reserved < 0 || total.named + total.reserved > remaining) {
      findings.push(finding('error', 'ALLOCATION_DESIGNATION_OUT_OF_BOUNDS', 'allocation', allocation.id,
        'Allocation movements produce an invalid remaining, named, or reserved balance'));
    }
  }
  const simpleBookings = new Map((data.bookings || []).map((row) => [id(row.id), row]));
  const complexBookings = new Map((data.complexBookings || []).map((row) => [id(row.id), row]));
  for (const link of data.bookingLinks || []) {
    const key = `${link.booking_kind}:${link.booking_id}`;
    if ((activeBookings.get(key) || 0) <= 0) continue;
    const allocation = allocations.get(id(link.allocation_id));
    const booking = link.booking_kind === 'complex'
      ? complexBookings.get(id(link.booking_id)) : simpleBookings.get(id(link.booking_id));
    if (!booking || booking.status !== 'confirmed') {
      findings.push(finding('error', 'ACTIVE_ALLOCATION_BOOKING_NOT_CONFIRMED', 'allocation_booking', link.id,
        'An active allocation designation has no matching confirmed booking'));
    } else if (!allocation || id(booking.event_id) !== id(allocation.event_id)
        || id(booking.ticket_class_id) !== id(allocation.ticket_type_id)) {
      findings.push(finding('error', 'ALLOCATION_BOOKING_SOURCE_MISMATCH', 'allocation_booking', link.id,
        'The active booking does not match its allocation event and ticket'));
    }
  }
  const sales = new Map((data.sales || []).map((row) => [id(row.id), row]));
  for (const invoice of data.invoices || []) {
    const sale = sales.get(id(invoice.sale_id));
    if (!sale || id(invoice.quote_version_id) !== id(sale.quote_version_id)) {
      findings.push(finding('error', 'INVOICE_SALE_SOURCE_MISMATCH', 'invoice_link', invoice.id,
        'Invoice linkage does not match its commercial sale quote version'));
    }
  }
  const stale = (value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && time <= now - STALE_CLAIM_MS;
  };
  for (const attempt of data.invoiceAttempts || []) {
    if (attempt.state === 'started' && stale(attempt.started_at)) {
      findings.push(finding('warning', 'STALE_INVOICE_ATTEMPT', 'invoice_attempt', attempt.id,
        'Invoice conversion has remained started for more than ten minutes and can be safely retried'));
    }
  }
  for (const mapping of data.customerMappings || []) {
    if (mapping.match_kind === 'creating' && stale(mapping.created_at)) {
      findings.push(finding('warning', 'STALE_CUSTOMER_MAPPING_CLAIM', 'customer_mapping', mapping.id,
        'Provider customer mapping claim has remained creating for more than ten minutes and can be retried'));
    }
  }
  return findings.sort((a, b) => `${a.severity}:${a.code}:${a.entityId}`
    .localeCompare(`${b.severity}:${b.code}:${b.entityId}`));
}

export async function loadSalesReconciliationData(db, tenantId) {
  const sources = {
    allocations: 'sales_commercial_allocation',
    movements: 'sales_commercial_allocation_movement',
    bookingLinks: 'sales_commercial_allocation_booking',
    bookings: 'booking',
    complexBookings: 'complex_event_booking',
    sales: 'sales_commercial_sale',
    invoices: 'sales_accounting_invoice_link',
    invoiceAttempts: 'sales_accounting_invoice_attempt',
    customerMappings: 'sales_accounting_customer_mapping',
  };
  const entries = await Promise.all(Object.entries(sources).map(async ([key, table]) => [
    key, await readSalesReportSource(db, table, tenantId),
  ]));
  return Object.fromEntries(entries);
}

export const salesReconciliationMetadata = Object.freeze({
  maxSourceRows: SALES_REPORT_MAX_SCAN,
  staleClaimMinutes: STALE_CLAIM_MS / 60000,
  recovery: 'Findings are read-only. Retry the existing idempotent invoice command or booking reconciliation; do not edit append-only commercial records.',
});