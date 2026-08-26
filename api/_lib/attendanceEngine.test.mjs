import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateParticipantIntervals,
  evaluateAttendance,
  normalizeParticipantKey,
  persistAttendanceReport,
  buildAttendanceSnapshotIdempotencyKey,
} from './attendanceEngine.js';

test('normalizes email identities and aggregates reconnect intervals', () => {
  assert.equal(normalizeParticipantKey({ email: ' Person@Example.COM ' }), 'person@example.com');
  const totals = aggregateParticipantIntervals([
    { participantKey: 'person@example.com', durationSeconds: 40 },
    { participantKey: 'person@example.com', durationSeconds: 35 },
    { participantKey: 'other@example.com', durationSeconds: 20 },
  ]);
  assert.equal(totals.get('person@example.com'), 75);
  assert.equal(totals.get('other@example.com'), 20);
});

test('snapshots threshold and distinguishes attended, below threshold and absent', () => {
  const outcomes = evaluateAttendance({
    bookings: [
      { id: 'a', bookingType: 'booking' },
      { id: 'b', bookingType: 'booking' },
      { id: 'c', bookingType: 'booking' },
    ],
    intervals: [
      { participantKey: 'one', durationSeconds: 31 },
      { participantKey: 'one', durationSeconds: 30 },
      { participantKey: 'two', durationSeconds: 59 },
    ],
    matches: [
      { participantKey: 'one', bookingId: 'a', matchStatus: 'matched' },
      { participantKey: 'two', bookingId: 'b', matchStatus: 'matched' },
    ],
    thresholdMinutes: 1,
    syncStatus: 'succeeded',
  });
  assert.deepEqual(outcomes.map(({ status, durationSeconds, thresholdMinutes }) => ({
    status, durationSeconds, thresholdMinutes,
  })), [
    { status: 'attended', durationSeconds: 61, thresholdMinutes: 1 },
    { status: 'below_threshold', durationSeconds: 59, thresholdMinutes: 1 },
    { status: 'absent', durationSeconds: 0, thresholdMinutes: 1 },
  ]);
});

test('provider pending and error are never represented as absence', () => {
  const input = {
    bookings: [{ id: 'a', bookingType: 'complex_event_booking' }],
    intervals: [],
    matches: [],
    thresholdMinutes: 10,
  };
  assert.equal(evaluateAttendance({ ...input, syncStatus: 'pending' })[0].status, 'pending');
  assert.equal(evaluateAttendance({ ...input, syncStatus: 'error' })[0].status, 'error');
});

test('unmatched provider participants do not turn a booking into attendance', () => {
  const [outcome] = evaluateAttendance({
    bookings: [{ id: 'a', bookingType: 'booking' }],
    intervals: [{ participantKey: 'unknown', durationSeconds: 3600 }],
    matches: [{ participantKey: 'unknown', matchStatus: 'unmatched' }],
    thresholdMinutes: 1,
    syncStatus: 'succeeded',
  });
  assert.equal(outcome.status, 'absent');
});

test('an unresolved candidate linked to a booking is explicitly unmatched', () => {
  const [outcome] = evaluateAttendance({
    bookings: [{ id: 'a', bookingType: 'booking' }],
    intervals: [{ participantKey: 'candidate', durationSeconds: 3600 }],
    matches: [{ participantKey: 'candidate', bookingId: 'a', matchStatus: 'ambiguous' }],
    thresholdMinutes: 1,
    syncStatus: 'succeeded',
  });
  assert.equal(outcome.status, 'unmatched');
});

test('snapshot persistence makes one atomic RPC call with deterministic outcomes', async () => {
  const calls = [];
  const db = {
    rpc(name, args) {
      calls.push({ name, args });
      return Promise.resolve({ data: [{ target_id: 'target-1', sync_run_id: 'run-1' }], error: null });
    },
    from() { throw new Error('report replacement must not use independent table writes'); },
  };
  const result = await persistAttendanceReport(db, {
    tenantId: 'tenant-1', provider: 'zoom', idempotencyKey: 'same-report',
    target: {
      type: 'event', id: 'event-1', eventId: 'event-1', providerTargetId: '123',
      providerTargetType: 'meeting', thresholdMinutes: 1,
    },
    intervals: [{ participantKey: 'person', intervalKey: 'one', durationSeconds: 60 }],
    matches: [{ participantKey: 'person', bookingId: 'booking-1', bookingType: 'booking', matchStatus: 'matched' }],
    bookings: [{ id: 'booking-1', bookingType: 'booking' }],
  });
  assert.deepEqual(result, {
    targetId: 'target-1', syncRunId: 'run-1',
    outcomes: [{ bookingId: 'booking-1', bookingType: 'booking', status: 'attended', durationSeconds: 60, thresholdMinutes: 1 }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'replace_attendance_report_snapshot');
  assert.equal(calls[0].args.p_idempotency_key, 'same-report');
  assert.equal(calls[0].args.p_snapshot.outcomes[0].resultFingerprint.length, 64);
});

test('snapshot idempotency changes for late confirmation, cancellation, and threshold changes', () => {
  const base = {
    provider: 'zoom',
    target: {
      type: 'event', id: 'event-1', providerTargetId: 'zoom-1', providerTargetType: 'meeting',
      thresholdMinutes: 1,
      policy: { ownerType: 'event', ownerId: 'event-1', enabled: true, provider: 'zoom', thresholdMinutes: 1 },
    },
    intervals: [{ participantKey: 'person', intervalKey: 'i-1', durationSeconds: 60 }],
    matches: [{ participantKey: 'person', bookingId: 'booking-a', bookingType: 'booking', matchStatus: 'matched' }],
    bookings: [{ id: 'booking-a', bookingType: 'booking' }],
  };
  const original = buildAttendanceSnapshotIdempotencyKey(base);
  const lateConfirmation = buildAttendanceSnapshotIdempotencyKey({
    ...base, bookings: [...base.bookings, { id: 'booking-b', bookingType: 'booking' }],
  });
  const cancellation = buildAttendanceSnapshotIdempotencyKey({ ...base, bookings: [] });
  const thresholdChange = buildAttendanceSnapshotIdempotencyKey({
    ...base,
    target: {
      ...base.target, thresholdMinutes: 2,
      policy: { ...base.target.policy, thresholdMinutes: 2 },
    },
  });
  assert.notEqual(lateConfirmation, original);
  assert.notEqual(cancellation, original);
  assert.notEqual(thresholdChange, original);
  assert.equal(buildAttendanceSnapshotIdempotencyKey({ ...base }), original);
});