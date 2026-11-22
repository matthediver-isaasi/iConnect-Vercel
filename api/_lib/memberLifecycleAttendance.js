import { lifecycleDay } from '../../shared/memberLifecyclePolicy.mjs';

const exactPattern = value => `^${String(value).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
const scope = (rows, tenantId) => {
  if (!Array.isArray(rows) || rows.some(row => row.tenant_id !== tenantId)) throw new Error('Attendance scope mismatch');
  return rows;
};

// Timestamp provenance is mandatory. Event dates, report completion dates and
// import timestamps are not substitutes for actually recorded attendance.
export function attendanceOccurrence(checkedIn, reversedAt, now) {
  if (!checkedIn) return null;
  const checked = new Date(checkedIn).getTime();
  if (!Number.isFinite(checked) || checked > +now) throw new Error('Invalid check-in occurrence');
  if (reversedAt) {
    const reversed = new Date(reversedAt).getTime();
    if (!Number.isFinite(reversed)) throw new Error('Invalid reversal occurrence');
    if (checked <= reversed) return null;
  }
  return checkedIn;
}

export async function loadLifecycleAttendance(db, tenantId, member, policy, now, read) {
  const reasons = new Set(), dates = [];
  const observe = date => {
    if (!date) return;
    if (!Number.isFinite(+new Date(date)) || +new Date(date) > +now) throw new Error('Invalid attendance timestamp');
    dates.push(lifecycleDay(date, policy.timezone));
  };
  const load = async (table, filters, options = {}) => scope(await read(db, table, tenantId,
    filters, { maxRows: 2000, ...options }), tenantId);
  // A booking's member_id can be the purchaser, not the attendee. Only an
  // independently unique exact attendee identity establishes ownership.
  if (!member.email?.trim()) return { complete: false, lastOccurredAt: null, reasons: ['attendance_identity_unavailable'] };
  const pattern = exactPattern(member.email);
  const owners = await load('member', [['email', pattern, 'imatch']]);
  if (owners.length !== 1 || owners[0].id !== member.id) {
    return { complete: false, lastOccurredAt: null, reasons: ['attendance_identity_ambiguous'] };
  }
  for (const bookingType of ['booking', 'complex_event_booking']) {
    const bookings = await load(bookingType, [['attendee_email', pattern, 'imatch']], { maxRows: 100 });
    for (const booking of bookings) {
      if (booking.attendee_email?.trim().toLowerCase() !== member.email.trim().toLowerCase()) {
        throw new Error('Attendance attendee mismatch');
      }
      try {
        if (bookingType === 'booking') observe(attendanceOccurrence(booking.checked_in_at, booking.check_in_reversed_at, now));
        else {
          const checkins = await load('complex_event_session_checkin', [['booking_id', booking.id]]);
          for (const checkin of checkins) {
            if (checkin.complex_event_id !== booking.event_id) throw new Error('Check-in event mismatch');
            // Session belongs to the same complex event; do not interpret a
            // foreign/reparented session as this attendee's evidence.
            const sessions = await load('complex_event_session', [['id', checkin.session_id]]);
            if (sessions.length !== 1 || sessions[0].complex_event_id !== booking.event_id) {
              throw new Error('Check-in session mismatch');
            }
            observe(attendanceOccurrence(checkin.checked_in_at, checkin.check_in_reversed_at, now));
          }
        }
        const outcomes = await load('attendance_current_outcome',
          [['booking_type', bookingType], ['booking_id', booking.id]], {
            keyColumns: ['provider', 'attendance_target_id', 'booking_type', 'booking_id'],
          });
        for (const outcome of outcomes) {
          if (['absent', 'below_threshold'].includes(outcome.status)) continue;
          if (outcome.status !== 'attended') { reasons.add('attendance_outcome_unresolved'); continue; }
          const revisions = await load('attendance_outcome_revision', [['id', outcome.outcome_revision_id]]);
          const revision = revisions[0];
          if (revisions.length !== 1 || revision.booking_id !== booking.id || revision.booking_type !== bookingType
            || revision.attendance_target_id !== outcome.attendance_target_id || revision.provider !== outcome.provider
            || revision.status !== 'attended' || !revision.sync_run_id) throw new Error('Attendance revision mismatch');
          const targets = await load('attendance_target', [['id', outcome.attendance_target_id]]);
          if (targets.length !== 1 || targets[0].event_id !== booking.event_id || targets[0].provider !== outcome.provider) {
            throw new Error('Attendance target mismatch');
          }
          const matches = await load('attendance_participant_match',
            [['attendance_target_id', outcome.attendance_target_id], ['provider', outcome.provider],
              ['booking_type', bookingType], ['booking_id', booking.id]]);
          const matched = matches.filter(row => row.match_status === 'matched' && row.sync_run_id === revision.sync_run_id);
          if (!matched.length || matches.some(row => row.match_status === 'ambiguous')) throw new Error('Attendance match unavailable');
          let observed = false;
          for (const match of matched) {
            if (match.member_id && match.member_id !== member.id) throw new Error('Attendance member mismatch');
            const intervals = await load('attendance_participant_interval',
              [['attendance_target_id', outcome.attendance_target_id], ['provider', outcome.provider],
                ['participant_key', match.participant_key], ['sync_run_id', revision.sync_run_id]]);
            for (const interval of intervals) {
              const joined = new Date(interval.joined_at).getTime(), left = new Date(interval.left_at).getTime();
              if (!interval.joined_at || !interval.left_at || !Number.isFinite(joined) || !Number.isFinite(left)
                || left < joined || left > +now) throw new Error('Attendance interval unavailable');
              observe(interval.left_at);
              observed = true;
            }
          }
          if (!observed) throw new Error('Attendance occurrence unavailable');
        }
      } catch { reasons.add('attendance_occurrence_unverified'); }
    }
  }
  return { complete: reasons.size === 0, lastOccurredAt: dates.sort().at(-1) || null,
    source: 'recorded_attendance', reasons: [...reasons] };
}
