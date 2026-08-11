import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseBookingRow,
  computeParticipationSplit,
  bookingMeasureValue,
  matchFilter,
} from './aggregation.js';

// ---------------------------------------------------------------------------
// normaliseBookingRow — the union of the two booking tables
// ---------------------------------------------------------------------------

test('simple booking rows are tagged simple and keep shared columns', () => {
  const row = normaliseBookingRow(
    {
      id: 'b1',
      event_id: 'e1',
      member_id: 'm1',
      organization_id: 'o1',
      attendee_email: 'a@x.com',
      ticket_class_name: 'Standard',
      status: 'confirmed',
      created_at: '2026-05-01T10:00:00Z',
      is_guest_booking: false,
    },
    'simple',
  );
  assert.equal(row.event_kind, 'simple');
  assert.equal(row.id, 'simple:b1');
  assert.equal(row.organization_id, 'o1');
  assert.equal(row.status, 'confirmed');
  assert.equal(row.is_guest_booking, false);
});

test('complex booking rows are tagged complex with kind-prefixed ids', () => {
  const row = normaliseBookingRow(
    { id: 'b1', event_id: 'e9', organization_id: 'o2', status: 'pending', created_at: null },
    'complex',
  );
  assert.equal(row.event_kind, 'complex');
  assert.equal(row.id, 'complex:b1');
  // Ids from the two tables can never collide even when equal raw ids.
  assert.notEqual(row.id, normaliseBookingRow({ id: 'b1' }, 'simple').id);
});

test('guest flag: simple uses is_guest_booking, complex uses missing member', () => {
  // Simple bookings: the explicit column is authoritative.
  assert.equal(
    normaliseBookingRow({ id: '1', organization_id: 'o1', is_guest_booking: true }, 'simple')
      .is_guest_booking,
    true,
  );
  // A member booking without an organisation is NOT a guest booking.
  assert.equal(
    normaliseBookingRow(
      { id: '2', member_id: 'm1', organization_id: null, is_guest_booking: false },
      'simple',
    ).is_guest_booking,
    false,
  );
  // Complex bookings have no explicit column — no linked member means guest
  // (mirrors the event registration report).
  assert.equal(
    normaliseBookingRow({ id: '3', member_id: null, organization_id: null }, 'complex')
      .is_guest_booking,
    true,
  );
  assert.equal(
    normaliseBookingRow({ id: '4', member_id: 'm2', organization_id: null }, 'complex')
      .is_guest_booking,
    false,
  );
});

// ---------------------------------------------------------------------------
// Status / date / kind filtering over the normalised union (matchFilter is
// the same predicate the booking aggregator applies in JS)
// ---------------------------------------------------------------------------

const rows = [
  normaliseBookingRow({ id: '1', member_id: 'm1', organization_id: 'o1', status: 'confirmed', created_at: '2026-01-10T00:00:00Z' }, 'simple'),
  normaliseBookingRow({ id: '2', member_id: 'm2', organization_id: 'o2', status: 'cancelled', created_at: '2026-01-15T00:00:00Z' }, 'simple'),
  normaliseBookingRow({ id: '3', member_id: 'm3', organization_id: 'o1', status: 'confirmed', created_at: '2026-03-01T00:00:00Z' }, 'complex'),
  normaliseBookingRow({ id: '4', member_id: null, organization_id: null, status: 'confirmed', created_at: '2026-01-20T00:00:00Z', is_guest_booking: true }, 'simple'),
  // Member booking with no organisation: not a guest, but has no org to
  // contribute to the participation split.
  normaliseBookingRow({ id: '5', member_id: 'm5', organization_id: null, status: 'confirmed', created_at: '2026-01-22T00:00:00Z', is_guest_booking: false }, 'simple'),
];

test('cancelled bookings can be excluded via a status filter', () => {
  const f = { field: 'status', operator: 'neq', value: 'cancelled' };
  const kept = rows.filter(r => matchFilter(r.status, f, null, false));
  assert.deepEqual(kept.map(r => r.id), ['simple:1', 'complex:3', 'simple:4', 'simple:5']);
});

test('date-range filter applies to the booking date on both kinds', () => {
  const from = { field: 'created_at', operator: 'gte', value: '2026-01-01' };
  const to = { field: 'created_at', operator: 'lt', value: '2026-02-01' };
  const kept = rows.filter(
    r => matchFilter(r.created_at, from, null, false) && matchFilter(r.created_at, to, null, false),
  );
  assert.deepEqual(kept.map(r => r.id), ['simple:1', 'simple:2', 'simple:4', 'simple:5']);
});

test('event_kind filter isolates one booking table', () => {
  const f = { field: 'event_kind', operator: 'eq', value: 'complex' };
  const kept = rows.filter(r => matchFilter(r.event_kind, f, null, false));
  assert.deepEqual(kept.map(r => r.id), ['complex:3']);
});

test('guest bookings can be filtered with the boolean flag', () => {
  const f = { field: 'is_guest_booking', operator: 'eq', value: 'false' };
  const kept = rows.filter(r => matchFilter(r.is_guest_booking, f, null, false));
  assert.deepEqual(kept.map(r => r.id), ['simple:1', 'simple:2', 'complex:3', 'simple:5']);
});

// ---------------------------------------------------------------------------
// Measure values — count_distinct fallback semantics
// ---------------------------------------------------------------------------

test('count_distinct without a field counts distinct bookings, not zero', () => {
  // No field selected → the unique normalised booking id backs the measure,
  // so count_distinct degrades to "distinct bookings".
  const measure = { aggregator: 'count_distinct', field: null };
  const values = rows.map(r => bookingMeasureValue(r, measure));
  assert.ok(values.every(v => v !== null && v !== undefined));
  assert.equal(new Set(values).size, rows.length);
});

test('count_distinct with a field uses that field (nulls excluded)', () => {
  const measure = { aggregator: 'count_distinct', field: 'organization_id' };
  const values = rows.map(r => bookingMeasureValue(r, measure)).filter(v => v != null);
  // rows span o1, o2, o1, null, null → 2 distinct organisations.
  assert.equal(new Set(values).size, 2);
});

// ---------------------------------------------------------------------------
// Organisation-participation split arithmetic
// ---------------------------------------------------------------------------

test('participation: each org counted once, compared to full tenant list', () => {
  const split = computeParticipationSplit(rows, ['o1', 'o2', 'o3', 'o4']);
  assert.deepEqual(split.bookedOrgIds.sort(), ['o1', 'o2']);
  assert.deepEqual(split.notBookedOrgIds.sort(), ['o3', 'o4']);
  assert.equal(split.totalOrganisations, 4);
  // Booked + not booked always partitions the tenant org list.
  assert.equal(split.bookedOrgIds.length + split.notBookedOrgIds.length, 4);
});

test('participation: org-less bookings (guest or member) join neither bucket', () => {
  const split = computeParticipationSplit(rows, ['o1', 'o2', 'o3']);
  // One guest booking + one member booking without an organisation.
  assert.equal(split.noOrganisationCount, 2);
  assert.ok(!split.bookedOrgIds.includes(null));
  assert.ok(!split.notBookedOrgIds.includes(null));
});

test('participation: bookings from deleted orgs are ignored', () => {
  const split = computeParticipationSplit(rows, ['o1', 'o3']);
  // o2 has a booking but is no longer a tenant organisation.
  assert.deepEqual(split.bookedOrgIds, ['o1']);
  assert.deepEqual(split.notBookedOrgIds, ['o3']);
  assert.equal(split.totalOrganisations, 2);
});

test('participation: no bookings means every org is not booked', () => {
  const split = computeParticipationSplit([], ['o1', 'o2']);
  assert.deepEqual(split.bookedOrgIds, []);
  assert.deepEqual(split.notBookedOrgIds.sort(), ['o1', 'o2']);
  assert.equal(split.noOrganisationCount, 0);
});

test('participation: empty org list yields empty split', () => {
  const split = computeParticipationSplit(rows, []);
  assert.deepEqual(split.bookedOrgIds, []);
  assert.deepEqual(split.notBookedOrgIds, []);
  assert.equal(split.totalOrganisations, 0);
});
