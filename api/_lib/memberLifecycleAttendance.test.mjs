import test from 'node:test';
import assert from 'node:assert/strict';
import { attendanceOccurrence, loadLifecycleAttendance } from './memberLifecycleAttendance.js';
const now = new Date('2026-11-22T12:00:00Z'), tenant = 'tenant';
const member = { id: 'member', email: 'fixture@example.invalid' };
const scoped = row => ({ tenant_id: tenant, ...row });
function reader(overrides = {}) {
  return async (_db, table, tenantId, filters) => {
    assert.equal(tenantId, tenant);
    const rows = {
      member: [scoped(member)],
      booking: [scoped({ id: 'b', event_id: 'e', member_id: 'different-purchaser',
        attendee_email: member.email, checked_in_at: '2020-02-01T10:00:00Z' })],
      complex_event_booking: [], attendance_current_outcome: [],
      ...overrides,
    }[table];
    if (!rows) throw new Error(`Unconfigured source ${table}`);
    return rows.filter(row => filters.every(([key, value, op]) => op === 'imatch' || row[key] === value));
  };
}
test('QR attendance uses actual check-in and ignores reversed occurrences', () => {
  assert.equal(attendanceOccurrence('2020-01-01', '2020-01-02', now), null);
  assert.equal(attendanceOccurrence('2020-01-03', '2020-01-02', now), '2020-01-03');
  assert.throws(() => attendanceOccurrence('2027-01-01', null, now));
});
test('attendee identity, not purchaser ID, owns recorded attendance', async () => {
  const evidence = await loadLifecycleAttendance({}, tenant, member, { timezone: 'UTC' }, now, reader());
  assert.equal(evidence.complete, true);
  assert.equal(evidence.lastOccurredAt, '2020-02-01');
});
test('duplicate identities hold review instead of picking one', async () => {
  const evidence = await loadLifecycleAttendance({}, tenant, member, { timezone: 'UTC' }, now,
    reader({ member: [scoped(member), scoped({ ...member, id: 'duplicate' })] }));
  assert.equal(evidence.complete, false);
});
test('online attendance requires the current matched report and actual intervals', async () => {
  const online = {
    attendance_current_outcome: [scoped({ booking_type: 'booking', booking_id: 'b', provider: 'teams',
      attendance_target_id: 't', outcome_revision_id: 'r', status: 'attended' })],
    attendance_outcome_revision: [scoped({ id: 'r', booking_type: 'booking', booking_id: 'b',
      provider: 'teams', attendance_target_id: 't', sync_run_id: 'run', status: 'attended' })],
    attendance_target: [scoped({ id: 't', event_id: 'e', provider: 'teams' })],
    attendance_participant_match: [scoped({ id: 'match', booking_type: 'booking', booking_id: 'b',
      provider: 'teams', attendance_target_id: 't', sync_run_id: 'run', match_status: 'matched', participant_key: 'p' })],
    attendance_participant_interval: [scoped({ id: 'interval', provider: 'teams', attendance_target_id: 't',
      sync_run_id: 'run', participant_key: 'p', joined_at: '2025-01-01T12:00:00Z', left_at: '2025-01-01T13:00:00Z' })],
  };
  const evidence = await loadLifecycleAttendance({}, tenant, member, { timezone: 'UTC' }, now, reader(online));
  assert.equal(evidence.complete, true);
  assert.equal(evidence.lastOccurredAt, '2025-01-01');
  online.attendance_participant_interval[0].left_at = null;
  const missing = await loadLifecycleAttendance({}, tenant, member, { timezone: 'UTC' }, now, reader(online));
  assert.equal(missing.complete, false);
  assert.equal(missing.lastOccurredAt, '2020-02-01');
});
