import { supabase } from './database.js';
import {
  buildAttendanceSnapshotIdempotencyKey,
  normalizeParticipantKey,
  persistAttendanceReport,
  persistAttendanceSyncState,
} from './attendanceEngine.js';
import { eventAttendancePolicy, resolveInheritedPolicy } from './attendancePolicy.js';
import { agendaScheduledEndAtWithFallback } from './attendanceSchedule.js';
import { fetchTeamsAttendance, getTeamsConnection, resolveOnlineMeetingId, TeamsGraphError } from './teamsGraphClient.js';

function requireRow(result, message) {
  if (result.error || !result.data) throw new Error(`${message}${result.error?.message ? `: ${result.error.message}` : ''}`);
  return result.data;
}

export async function resolveTeamsTarget(db, tenantId, { eventId, sessionId, agendaItemId }) {
  if (sessionId && agendaItemId) throw new Error('Only one of sessionId or agendaItemId may be supplied');
  if (sessionId) {
    const session = requireRow(await db.from('complex_event_session')
      .select('id,complex_event_id,end_time,online_provider,teams_meeting_lifecycle,teams_online_meeting_id,teams_join_web_url,teams_organiser_microsoft_user_id,teams_outlook_connection_id,attendance_policy_override,attendance_tracking_enabled,attendance_provider,attendance_threshold_minutes')
      .eq('tenant_id', tenantId).eq('id', sessionId).single(), 'Session not found');
    if (eventId && session.complex_event_id !== eventId) throw new Error('Session does not belong to the requested event');
    const parent = requireRow(await db.from('complex_event')
      .select('id,attendance_tracking_enabled,attendance_provider,attendance_threshold_minutes')
      .eq('tenant_id', tenantId).eq('id', session.complex_event_id).single(), 'Complex event not found');
    const effective = resolveInheritedPolicy(parent, session);
    return {
      type: 'complex_event_session', id: session.id, eventId: session.complex_event_id,
      scheduledEndAt: session.end_time || null, effective,
      teamsIdentity: teamsIdentityFromRow(session),
      policy: {
        ownerType: 'complex_event_session', ownerId: session.id, ...policyFields(effective),
        parent: { ownerType: 'complex_event', ownerId: parent.id, ...policyFields(eventAttendancePolicy(parent)) },
      },
    };
  }
  if (agendaItemId) {
    const item = requireRow(await db.from('event_agenda_item')
      .select('id,event_id,end_date,end_time,online_provider,teams_meeting_lifecycle,teams_online_meeting_id,teams_join_web_url,teams_organiser_microsoft_user_id,teams_outlook_connection_id,attendance_policy_override,attendance_tracking_enabled,attendance_provider,attendance_threshold_minutes')
      .eq('tenant_id', tenantId).eq('id', agendaItemId).single(), 'Agenda item not found');
    if (eventId && item.event_id !== eventId) throw new Error('Agenda item does not belong to the requested event');
    const parent = requireRow(await db.from('event')
      .select('id,end_date,timezone,attendance_tracking_enabled,attendance_provider,attendance_threshold_minutes')
      .eq('tenant_id', tenantId).eq('id', item.event_id).single(), 'Event not found');
    const effective = resolveInheritedPolicy(parent, item);
    return {
      type: 'agenda_item', id: item.id, eventId: item.event_id,
      scheduledEndAt: agendaScheduledEndAtWithFallback(item.end_date, item.end_time, parent.timezone)
        || parent.end_date || null, effective,
      teamsIdentity: teamsIdentityFromRow(item),
      policy: {
        ownerType: 'agenda_item', ownerId: item.id, ...policyFields(effective),
        parent: { ownerType: 'event', ownerId: parent.id, ...policyFields(eventAttendancePolicy(parent)) },
      },
    };
  }
  if (!eventId) throw new Error('eventId is required');
  const event = requireRow(await db.from('event')
    .select('id,end_date,online_provider,teams_meeting_lifecycle,teams_online_meeting_id,teams_join_web_url,teams_organiser_microsoft_user_id,teams_outlook_connection_id,attendance_tracking_enabled,attendance_provider,attendance_threshold_minutes')
    .eq('tenant_id', tenantId).eq('id', eventId).single(), 'Event not found');
  const effective = eventAttendancePolicy(event);
  return {
    type: 'event', id: event.id, eventId: event.id, scheduledEndAt: event.end_date || null,
    effective,
    teamsIdentity: teamsIdentityFromRow(event),
    policy: { ownerType: 'event', ownerId: event.id, ...policyFields(effective) },
  };
}

export function teamsIdentityFromRow(row) {
  if (row?.online_provider && row.online_provider !== 'teams') return null;
  if (['deleted', 'detached', 'cancelled'].includes(String(row?.teams_meeting_lifecycle || '').toLowerCase())) {
    return null;
  }
  const onlineMeetingId = row?.teams_online_meeting_id || null;
  const connectionId = row?.teams_outlook_connection_id || null;
  const organiserMicrosoftUserId = row?.teams_organiser_microsoft_user_id || null;
  if (!onlineMeetingId || !connectionId || !organiserMicrosoftUserId) return null;
  return {
    onlineMeetingId,
    joinWebUrl: row.teams_join_web_url || null,
    connectionId,
    organiserMicrosoftUserId,
  };
}

export function teamsBindingPayloadFromTarget(tenantId, target) {
  const identity = target?.teamsIdentity;
  if (!identity) return null;
  return {
    tenant_id: tenantId,
    target_type: target.type,
    target_id: target.id,
    event_id: target.eventId,
    outlook_connection_id: identity.connectionId,
    organiser_microsoft_user_id: identity.organiserMicrosoftUserId,
    online_meeting_id: identity.onlineMeetingId,
    join_web_url: identity.joinWebUrl,
    scheduled_end_at: target.scheduledEndAt || null,
    enabled: true,
    updated_at: new Date().toISOString(),
  };
}

function policyFields(policy) {
  return {
    enabled: policy.enabled,
    provider: policy.provider,
    thresholdMinutes: policy.thresholdMinutes,
  };
}

async function loadBookings(db, tenantId, target) {
  const complex = target.type === 'complex_event_session';
  const table = complex ? 'complex_event_booking' : 'booking';
  const bookingType = complex ? 'complex_event_booking' : 'booking';
  const { data, error } = await db.from(table).select('id,member_id,attendee_email,ticket_class_id')
    .eq('tenant_id', tenantId).eq('event_id', target.eventId).eq('status', 'confirmed');
  if (error) throw new Error(`Failed to load bookings: ${error.message}`);
  return teamsBookingFactsFromRows(data || [], bookingType);
}

export function teamsBookingFactsFromRows(rows, bookingType) {
  const byEmail = new Map();
  for (const booking of rows) {
    const email = String(booking.attendee_email || '').trim().toLowerCase();
    if (email) {
      const list = byEmail.get(email) || [];
      list.push(booking);
      byEmail.set(email, list);
    }
  }
  return {
    rows, byEmail, bookingType,
    bookings: rows.map(row => ({
      id: row.id,
      bookingType,
      memberId: row.member_id || null,
      ticketId: row.ticket_class_id || null,
    })),
  };
}

function secondsBetween(start, end) {
  const milliseconds = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(milliseconds) ? Math.max(0, Math.round(milliseconds / 1000)) : 0;
}

export function normalizeTeamsAttendanceRecords(records) {
  const intervals = [];
  for (const [recordIndex, record] of records.entries()) {
    const email = String(
      record.emailAddress || record.identity?.emailAddress || record.identity?.userPrincipalName || '',
    ).trim().toLowerCase() || null;
    const providerParticipantId = String(record.identity?.id || record.id || `anonymous-${recordIndex}`);
    const participantKey = normalizeParticipantKey({
      email, providerParticipantId, intervalKey: `record-${recordIndex}`,
    });
    const sourceIntervals = record.attendanceIntervals?.length
      ? record.attendanceIntervals
      : [{
        joinDateTime: null, leaveDateTime: null,
        durationInSeconds: record.totalAttendanceInSeconds,
      }];
    sourceIntervals.forEach((interval, intervalIndex) => {
      const joinedAt = interval.joinDateTime || null;
      const leftAt = interval.leaveDateTime || null;
      const durationSeconds = Math.max(0, Number(interval.durationInSeconds)
        || (joinedAt && leftAt ? secondsBetween(joinedAt, leftAt) : 0));
      intervals.push({
        participantKey,
        intervalKey: `${record.id || providerParticipantId}:${intervalIndex}:${joinedAt || 'unknown'}`,
        email,
        name: record.identity?.displayName || record.displayName || null,
        joinedAt,
        leftAt,
        durationSeconds,
        providerParticipantId,
        metadata: { role: record.role || null },
      });
    });
  }
  return intervals;
}

function matchTeamsParticipants(intervals, bookingFacts) {
  const participants = new Map();
  for (const interval of intervals) if (!participants.has(interval.participantKey)) {
    participants.set(interval.participantKey, interval);
  }
  return [...participants.values()].flatMap(participant => {
    const candidates = participant.email ? bookingFacts.byEmail.get(participant.email) || [] : [];
    if (!candidates.length) return [{
      participantKey: participant.participantKey, matchStatus: 'unmatched', matchedBy: null,
    }];
    if (candidates.length > 1) return candidates.map(booking => ({
      participantKey: participant.participantKey, bookingType: bookingFacts.bookingType,
      bookingId: booking.id, memberId: booking.member_id,
      matchStatus: 'ambiguous', matchedBy: 'email_duplicate',
    }));
    return [{
      participantKey: participant.participantKey, bookingType: bookingFacts.bookingType,
      bookingId: candidates[0].id, memberId: candidates[0].member_id,
      matchStatus: 'matched', matchedBy: 'email',
    }];
  });
}

function engineTarget(target, binding) {
  return {
    type: target.type, id: target.id, eventId: target.eventId,
    providerTargetId: binding.online_meeting_id, providerTargetType: 'onlineMeeting',
    thresholdMinutes: target.effective.thresholdMinutes,
    scheduledEndAt: binding.scheduled_end_at || target.scheduledEndAt,
    policy: target.policy,
  };
}

export async function upsertTeamsAttendanceBinding({
  tenantId, eventId, sessionId, agendaItemId, connectionId,
  organiserMicrosoftUserId, onlineMeetingId, joinWebUrl,
}, { db = supabase, fetchImpl = fetch } = {}) {
  const target = await resolveTeamsTarget(db, tenantId, { eventId, sessionId, agendaItemId });
  if (!target.effective.enabled || target.effective.provider !== 'teams') {
    throw new Error('The effective attendance policy for this target must enable Teams');
  }
  const { token } = await getTeamsConnection({
    tenantId, connectionId, organiserMicrosoftUserId, db, fetchImpl,
  });
  const stableId = await resolveOnlineMeetingId({
    token, organiserMicrosoftUserId, onlineMeetingId, joinWebUrl, fetchImpl,
  });
  const existingResult = await db.from('teams_attendance_binding').select('*')
    .eq('tenant_id', tenantId).eq('target_type', target.type).eq('target_id', target.id).maybeSingle();
  if (existingResult.error) throw new Error(`Failed to inspect Teams attendance binding: ${existingResult.error.message}`);
  const existing = existingResult.data;
  if (existing && (
    existing.online_meeting_id !== stableId
    || existing.outlook_connection_id !== connectionId
    || existing.organiser_microsoft_user_id !== organiserMicrosoftUserId
  )) {
    const { error: disableError } = await db.from('attendance_target')
      .update({ tracking_enabled: false, updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId).eq('provider', 'teams')
      .eq('target_type', target.type).eq('target_id', target.id);
    if (disableError) throw new Error(`Failed to hide replaced Teams attendance target: ${disableError.message}`);
  }
  const { data, error } = await db.from('teams_attendance_binding').upsert({
    tenant_id: tenantId, target_type: target.type, target_id: target.id, event_id: target.eventId,
    outlook_connection_id: connectionId, organiser_microsoft_user_id: organiserMicrosoftUserId,
    online_meeting_id: stableId, join_web_url: joinWebUrl || null,
    scheduled_end_at: target.scheduledEndAt, enabled: true, updated_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id,target_type,target_id' }).select('*').single();
  if (error) throw new Error(`Failed to bind Teams meeting: ${error.message}`);
  return data;
}

export async function syncTeamsAttendanceBinding(binding, {
  db = supabase, fetchImpl = fetch, sleepImpl,
} = {}) {
  const target = await resolveTeamsTarget(db, binding.tenant_id, {
    eventId: binding.event_id,
    sessionId: binding.target_type === 'complex_event_session' ? binding.target_id : null,
    agendaItemId: binding.target_type === 'agenda_item' ? binding.target_id : null,
  });
  if (!target.effective.enabled || target.effective.provider !== 'teams' || !target.effective.supported) {
    return { success: true, skipped: true, reason: 'Teams attendance tracking is disabled' };
  }
  const snapshotTarget = engineTarget(target, binding);
  let providerData;
  try {
    const { token } = await getTeamsConnection({
      tenantId: binding.tenant_id,
      connectionId: binding.outlook_connection_id,
      organiserMicrosoftUserId: binding.organiser_microsoft_user_id,
      db, fetchImpl,
    });
    providerData = await fetchTeamsAttendance({
      token, organiserMicrosoftUserId: binding.organiser_microsoft_user_id,
      onlineMeetingId: binding.online_meeting_id, fetchImpl, sleepImpl,
    });
  } catch (error) {
    const pending = error instanceof TeamsGraphError && error.retryable;
    const retrySeconds = error.retryAfterSeconds || (pending ? 300 : null);
    await db.from('teams_attendance_binding').update({
      last_attempt_at: new Date().toISOString(),
      next_attempt_at: retrySeconds ? new Date(Date.now() + retrySeconds * 1000).toISOString() : null,
      attempt_count: (binding.attempt_count || 0) + 1,
      terminal_error: pending ? null : (error.message || 'provider_error'),
      // enabled is lifecycle/policy eligibility, not provider health. Keep a
      // terminal consent failure discoverable for an admin's manual retry.
      enabled: true,
      updated_at: new Date().toISOString(),
    }).eq('tenant_id', binding.tenant_id).eq('id', binding.id);
    await persistAttendanceSyncState(db, {
      tenantId: binding.tenant_id, provider: 'teams', target: snapshotTarget,
      idempotencyKey: `teams:${binding.online_meeting_id}:${error.code || 'provider_error'}`,
      status: pending ? 'pending' : 'error',
      errorCode: error.code || 'provider_error', errorMessage: error.message,
      // A replacement meeting must not reactivate the previous meeting's
      // snapshot until a fresh report has been persisted successfully.
      trackingEnabled: false,
    });
    return {
      success: false, pending, error: error.message, errorCode: error.code || 'provider_error',
      retryAfterSeconds: error.retryAfterSeconds || null,
      participantCount: 0, matchedCount: 0, unmatchedCount: 0,
    };
  }
  const intervals = normalizeTeamsAttendanceRecords(providerData.records);
  const bookingFacts = await loadBookings(db, binding.tenant_id, target);
  const matches = matchTeamsParticipants(intervals, bookingFacts);
  const idempotencyKey = buildAttendanceSnapshotIdempotencyKey({
    provider: 'teams', target: snapshotTarget, intervals, matches, bookings: bookingFacts.bookings,
  });
  const persisted = await persistAttendanceReport(db, {
    tenantId: binding.tenant_id, provider: 'teams', target: snapshotTarget,
    intervals, matches, bookings: bookingFacts.bookings, idempotencyKey,
    metadata: {
      source: 'microsoft_graph', reportId: providerData.report.id,
      connectionId: binding.outlook_connection_id,
      organiserMicrosoftUserId: binding.organiser_microsoft_user_id,
    },
  });
  const { error: updateError } = await db.from('teams_attendance_binding')
    .update({
      last_sync_at: new Date().toISOString(), last_attempt_at: new Date().toISOString(),
      next_attempt_at: null, attempt_count: 0, terminal_error: null, enabled: true,
      updated_at: new Date().toISOString(),
    })
    .eq('tenant_id', binding.tenant_id).eq('id', binding.id)
    .eq('outlook_connection_id', binding.outlook_connection_id)
    .eq('organiser_microsoft_user_id', binding.organiser_microsoft_user_id);
  if (updateError) throw new Error(`Failed to update Teams binding sync time: ${updateError.message}`);
  const matchedCount = matches.filter(match => match.matchStatus === 'matched').length;
  return {
    success: true, participantCount: new Set(intervals.map(item => item.participantKey)).size,
    matchedCount, unmatchedCount: matches.length - matchedCount,
    attendanceTargetId: persisted.targetId, syncRunId: persisted.syncRunId,
    thresholdMinutes: target.effective.thresholdMinutes,
  };
}

export async function syncTeamsAttendanceTarget(tenantId, targetInput, options = {}) {
  const db = options.db || supabase;
  const target = await resolveTeamsTarget(db, tenantId, targetInput);
  const { data, error } = await db.from('teams_attendance_binding').select('*')
    .eq('tenant_id', tenantId).eq('target_type', target.type).eq('target_id', target.id)
    .eq('enabled', true).maybeSingle();
  if (error) throw new Error(`Failed to load Teams attendance binding: ${error.message}`);
  let binding = data;
  if (!binding) {
    const payload = teamsBindingPayloadFromTarget(tenantId, target);
    if (!payload) {
      throw new Error('Teams attendance binding not found and target has no complete Teams meeting identity');
    }
    const created = await db.from('teams_attendance_binding').upsert(payload, {
      onConflict: 'tenant_id,target_type,target_id',
    }).select('*').single();
    if (created.error || !created.data) {
      throw new Error(`Failed to recover Teams attendance binding: ${created.error?.message || 'unknown error'}`);
    }
    binding = created.data;
  }
  return syncTeamsAttendanceBinding(binding, options);
}