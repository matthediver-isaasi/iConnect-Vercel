import { createHash } from 'node:crypto';

export function normalizeParticipantKey(participant) {
  const email = String(participant.email || '').trim().toLowerCase();
  return email || `provider:${participant.providerParticipantId || participant.intervalKey}`;
}

export function aggregateParticipantIntervals(intervals) {
  const totals = new Map();
  for (const interval of intervals) {
    const key = interval.participantKey || normalizeParticipantKey(interval);
    totals.set(key, (totals.get(key) || 0) + Math.max(0, Number(interval.durationSeconds) || 0));
  }
  return totals;
}

export function evaluateAttendance({ bookings, intervals, matches, thresholdMinutes, syncStatus }) {
  const totals = aggregateParticipantIntervals(intervals);
  const matchByBooking = new Map();
  const unresolvedBookings = new Set();
  for (const match of matches) {
    if (match.bookingId && match.matchStatus === 'matched') matchByBooking.set(match.bookingId, match.participantKey);
    else if (match.bookingId) unresolvedBookings.add(match.bookingId);
  }
  return bookings.map((booking) => {
    const participantKey = matchByBooking.get(booking.id);
    const durationSeconds = participantKey ? (totals.get(participantKey) || 0) : 0;
    let status;
    if (syncStatus === 'pending' || syncStatus === 'running') status = 'pending';
    else if (syncStatus === 'error') status = 'error';
    else if (unresolvedBookings.has(booking.id)) status = 'unmatched';
    else if (!participantKey) status = 'absent';
    else status = durationSeconds >= thresholdMinutes * 60 ? 'attended' : 'below_threshold';
    return {
      bookingId: booking.id,
      bookingType: booking.bookingType,
      memberId: booking.memberId || null,
      ticketId: booking.ticketId || null,
      status,
      durationSeconds,
      thresholdMinutes,
    };
  });
}

function fingerprint(outcome) {
  return createHash('sha256')
    .update([outcome.status, outcome.durationSeconds, outcome.thresholdMinutes].join('|'))
    .digest('hex');
}

/**
 * A completed run may only be reused when every fact capable of changing the
 * materialized result is identical.  Arrays are canonicalized because provider
 * pagination/order is not itself an attendance fact.
 */
export function buildAttendanceSnapshotIdempotencyKey({ provider, target, intervals, matches, bookings }) {
  const canonical = {
    provider,
    target: {
      type: target.type,
      id: target.id,
      providerTargetId: target.providerTargetId,
      providerTargetType: target.providerTargetType,
      thresholdMinutes: target.thresholdMinutes,
      policy: target.policy
        ? {
          ownerType: target.policy.ownerType, ownerId: target.policy.ownerId,
          enabled: target.policy.enabled, provider: target.policy.provider,
          thresholdMinutes: target.policy.thresholdMinutes,
        }
        : null,
    },
    bookings: [...bookings].map(({ id, bookingType, memberId, ticketId }) => ({
      id, bookingType, memberId: memberId || null, ticketId: ticketId || null,
    }))
      .sort((a, b) => `${a.bookingType}:${a.id}`.localeCompare(`${b.bookingType}:${b.id}`)),
    intervals: [...intervals].map((item) => ({
      participantKey: item.participantKey, intervalKey: item.intervalKey,
      durationSeconds: item.durationSeconds, joinedAt: item.joinedAt || null,
      leftAt: item.leftAt || null, email: item.email || null,
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    matches: [...matches].map((item) => ({
      participantKey: item.participantKey, bookingId: item.bookingId || null,
      bookingType: item.bookingType || null, matchStatus: item.matchStatus,
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
  return `attendance-snapshot:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

async function requireResult(query, message) {
  const { data, error } = await query;
  if (error) throw new Error(`${message}: ${error.message}`);
  return data;
}

async function persistPolicy(db, tenantId, policy) {
  if (!policy) return null;
  const parent = policy.parent ? await persistPolicy(db, tenantId, policy.parent) : null;
  return requireResult(db.from('attendance_policy').upsert({
    tenant_id: tenantId,
    owner_type: policy.ownerType,
    owner_id: policy.ownerId,
    enabled: policy.enabled,
    provider: policy.provider,
    threshold_minutes: policy.thresholdMinutes,
    inherits_from_policy_id: parent?.id || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id,owner_type,owner_id' }).select('id').single(),
  'Failed to store attendance policy');
}

export async function persistAttendanceSyncState(db, {
  tenantId, provider, target, idempotencyKey, status, errorCode = null, errorMessage = null,
}) {
  const attemptedAt = new Date().toISOString();
  const policy = await persistPolicy(db, tenantId, target.policy);
  const targetRow = await requireResult(
    db.from('attendance_target').upsert({
      tenant_id: tenantId, provider, target_type: target.type, target_id: target.id,
      event_id: target.eventId, provider_target_id: target.providerTargetId,
      provider_target_type: target.providerTargetType,
      effective_threshold_minutes: target.thresholdMinutes,
      policy_id: policy?.id || null,
      tracking_enabled: true, scheduled_end_at: target.scheduledEndAt || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,provider,target_type,target_id' }).select('id').single(),
    'Failed to store attendance target',
  );
  const completed = status === 'error' ? new Date().toISOString() : null;
  const run = await requireResult(db.from('attendance_sync_run').upsert({
    tenant_id: tenantId, provider, attendance_target_id: targetRow.id,
    idempotency_key: idempotencyKey, status, attempted_at: attemptedAt, completed_at: completed,
    provider_report_available: false, error_code: errorCode, error_message: errorMessage,
  }, { onConflict: 'tenant_id,provider,attendance_target_id,idempotency_key' }).select('id').single(),
  'Failed to store attendance sync state');
  return { targetId: targetRow.id, syncRunId: run.id };
}

export async function persistAttendanceReport(db, {
  tenantId, provider, target, intervals, matches, bookings, idempotencyKey, metadata = {},
}) {
  const outcomes = evaluateAttendance({
    bookings, intervals, matches, thresholdMinutes: target.thresholdMinutes, syncStatus: 'succeeded',
  });
  const payload = {
    target: {
      type: target.type, id: target.id, eventId: target.eventId, providerTargetId: target.providerTargetId,
      providerTargetType: target.providerTargetType, thresholdMinutes: target.thresholdMinutes,
      scheduledEndAt: target.scheduledEndAt || null, policy: target.policy || null,
    },
    intervals,
    matches,
    outcomes: outcomes.map((outcome) => ({ ...outcome, resultFingerprint: fingerprint(outcome) })),
    metadata,
  };
  const result = await requireResult(db.rpc('replace_attendance_report_snapshot', {
    p_tenant_id: tenantId, p_provider: provider, p_idempotency_key: idempotencyKey, p_snapshot: payload,
  }), 'Failed to atomically persist attendance report');
  const row = Array.isArray(result) ? result[0] : result;
  return { targetId: row.target_id, syncRunId: row.sync_run_id, outcomes };
}