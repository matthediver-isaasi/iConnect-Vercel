import { supabase } from './database.js';
import { getZoomAccessTokenForTenant } from './zoomClient.js';
import {
  normalizeParticipantKey,
  persistAttendanceReport,
  persistAttendanceSyncState,
  buildAttendanceSnapshotIdempotencyKey,
} from './attendanceEngine.js';
import { eventAttendancePolicy, resolveInheritedPolicy } from './attendancePolicy.js';
import { agendaScheduledEndAt } from './attendanceSchedule.js';
import { legacyBookingMatch } from './attendanceMatching.js';

async function fetchZoomParticipants(token, zoomId, zoomType) {
  const isWebinar = zoomType === 'webinar';
  const baseUrl = isWebinar
    ? `https://api.zoom.us/v2/report/webinars/${zoomId}/participants`
    : `https://api.zoom.us/v2/report/meetings/${zoomId}/participants`;

  const allParticipants = [];
  let nextPageToken = '';
  let page = 0;
  const maxPages = 20;

  do {
    const url = new URL(baseUrl);
    url.searchParams.set('page_size', '300');
    if (nextPageToken) {
      url.searchParams.set('next_page_token', nextPageToken);
    }

    const response = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
      const errText = await response.text();
      if (response.status === 404) {
        console.log(`[ZoomAttendance] Meeting/webinar ${zoomId} not found in Zoom Reports API (may not have ended yet or data not available)`);
        return { participants: [], error: 'not_found' };
      }
      if (response.status === 400) {
        console.log(`[ZoomAttendance] Bad request for ${zoomId}: ${errText}`);
        return { participants: [], error: 'bad_request' };
      }
      throw new Error(`Zoom Reports API error (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const participants = data.participants || [];
    allParticipants.push(...participants);

    nextPageToken = data.next_page_token || '';
    page++;
  } while (nextPageToken && page < maxPages);

  return { participants: allParticipants, error: null };
}

async function matchParticipantsToBookings(tenantId, eventId, isComplexEvent, participants) {
  const emails = [...new Set(
    participants
      .map(p => (p.user_email || p.email || '').toLowerCase().trim())
      .filter(Boolean)
  )];

  const bookingsByEmail = {};
  let confirmedBookings = [];

  if (isComplexEvent) {
    const { data: bookings, error } = await supabase
      .from('complex_event_booking')
      .select('id, member_id, attendee_email')
      .eq('event_id', eventId)
      .eq('tenant_id', tenantId)
      .eq('status', 'confirmed');
    if (error) throw new Error(`Failed to load complex event bookings: ${error.message}`);
    confirmedBookings = bookings || [];

    if (bookings) {
      for (const b of bookings) {
        const email = (b.attendee_email || '').toLowerCase().trim();
        if (email) {
          (bookingsByEmail[email] ||= []).push({ booking_id: b.id, member_id: b.member_id });
        }
      }
    }
  } else {
    const { data: bookings, error } = await supabase
      .from('booking')
      .select('id, member_id, attendee_email')
      .eq('event_id', eventId)
      .eq('tenant_id', tenantId)
      .eq('status', 'confirmed');
    if (error) throw new Error(`Failed to load event bookings: ${error.message}`);
    confirmedBookings = bookings || [];

    if (bookings) {
      for (const b of bookings) {
        const email = (b.attendee_email || '').toLowerCase().trim();
        if (email) {
          (bookingsByEmail[email] ||= []).push({ booking_id: b.id, member_id: b.member_id });
        }
      }
    }
  }

  return {
    bookingsByEmail,
    bookings: confirmedBookings.map((booking) => ({
      id: booking.id,
      bookingType: isComplexEvent ? 'complex_event_booking' : 'booking',
    })),
  };
}

async function resolveAttendancePolicy(tenantId, eventId, complexEventSessionId, agendaItemId) {
  if (complexEventSessionId) {
    const { data: session, error } = await supabase.from('complex_event_session')
      .select('attendance_policy_override,attendance_tracking_enabled,attendance_provider,attendance_threshold_minutes')
      .eq('tenant_id', tenantId).eq('id', complexEventSessionId).single();
    if (error) throw new Error(`Failed to resolve session attendance policy: ${error.message}`);
    const { data: parent, error: parentError } = await supabase.from('complex_event')
      .select('attendance_tracking_enabled,attendance_provider,attendance_threshold_minutes')
      .eq('tenant_id', tenantId).eq('id', eventId).single();
    if (parentError) throw new Error(`Failed to resolve event attendance policy: ${parentError.message}`);
    const effective = resolveInheritedPolicy(parent, session);
    return {
      ...effective,
      policy: {
        ownerType: 'complex_event_session', ownerId: complexEventSessionId,
        enabled: effective.enabled, provider: effective.provider, thresholdMinutes: effective.thresholdMinutes,
        parent: {
          ownerType: 'complex_event', ownerId: eventId,
          enabled: Boolean(parent.attendance_tracking_enabled), provider: parent.attendance_provider || null,
          thresholdMinutes: Math.max(0, parent.attendance_threshold_minutes ?? 1),
        },
      },
    };
  }
  const { data: event, error } = await supabase.from('event')
    .select('attendance_tracking_enabled,attendance_provider,attendance_threshold_minutes')
    .eq('tenant_id', tenantId).eq('id', eventId).single();
  if (error) throw new Error(`Failed to resolve event attendance policy: ${error.message}`);
  if (agendaItemId) {
    const { data: agenda, error: agendaError } = await supabase.from('event_agenda_item')
      .select('attendance_policy_override,attendance_tracking_enabled,attendance_provider,attendance_threshold_minutes')
      .eq('tenant_id', tenantId).eq('id', agendaItemId).eq('event_id', eventId).single();
    if (agendaError) throw new Error(`Failed to resolve agenda attendance policy: ${agendaError.message}`);
    const effective = resolveInheritedPolicy(event, agenda);
    return {
      ...effective,
      policy: {
        ownerType: 'agenda_item', ownerId: agendaItemId,
        enabled: effective.enabled, provider: effective.provider, thresholdMinutes: effective.thresholdMinutes,
        parent: {
          ownerType: 'event', ownerId: eventId, enabled: Boolean(event.attendance_tracking_enabled),
          provider: event.attendance_provider || null,
          thresholdMinutes: Math.max(0, event.attendance_threshold_minutes ?? 1),
        },
      },
    };
  }
  const effective = eventAttendancePolicy(event);
  return {
    ...effective,
    policy: {
      ownerType: 'event', ownerId: eventId, enabled: effective.enabled,
      provider: effective.provider, thresholdMinutes: effective.thresholdMinutes,
    },
  };
}

export async function syncAttendanceForMeeting({
  tenantId,
  eventId,
  complexEventSessionId,
  zoomMeetingId,
  zoomType,
  isComplexEvent,
  agendaItemId = null,
  scheduledEndAt = null,
}) {
  if (!supabase || !tenantId || !zoomMeetingId) {
    throw new Error('Missing required parameters for attendance sync');
  }

  const policy = await resolveAttendancePolicy(tenantId, eventId, complexEventSessionId, agendaItemId);
  if (!policy.enabled || policy.provider !== 'zoom' || !policy.supported) {
    return {
      success: true, skipped: true, participantCount: 0, matchedCount: 0, unmatchedCount: 0,
      reason: !policy.enabled ? 'Attendance tracking is disabled' : 'Attendance provider is not supported',
    };
  }
  let participants;
  let fetchError;
  try {
    const token = await getZoomAccessTokenForTenant(tenantId);
    ({ participants, error: fetchError } = await fetchZoomParticipants(token, zoomMeetingId, zoomType));
  } catch (providerError) {
    const errorMessage = providerError?.message || 'Zoom attendance provider request failed';
    await persistAttendanceSyncState(supabase, {
      tenantId,
      provider: 'zoom',
      target: {
        type: agendaItemId ? 'agenda_item' : (complexEventSessionId ? 'complex_event_session' : 'event'),
        id: agendaItemId || complexEventSessionId || eventId,
        eventId,
        providerTargetId: String(zoomMeetingId),
        providerTargetType: zoomType || 'meeting',
        thresholdMinutes: policy.thresholdMinutes,
        scheduledEndAt,
        policy: policy.policy,
      },
      idempotencyKey: `zoom-provider-error:${zoomMeetingId}`,
      status: 'error',
      errorCode: 'provider_error',
      errorMessage,
    });
    return {
      success: false,
      pending: false,
      error: errorMessage,
      participantCount: 0,
      matchedCount: 0,
      unmatchedCount: 0,
    };
  }

  if (fetchError) {
    const thresholdMinutes = policy.thresholdMinutes;
    const pending = fetchError === 'not_found';
    const error = pending
      ? 'Meeting data not yet available in Zoom Reports API. Try again in a few minutes after the meeting has ended.'
      : 'Invalid meeting ID or meeting has not ended yet.';
    await persistAttendanceSyncState(supabase, {
      tenantId,
      provider: 'zoom',
      target: {
        type: agendaItemId ? 'agenda_item' : (complexEventSessionId ? 'complex_event_session' : 'event'),
        id: agendaItemId || complexEventSessionId || eventId,
        eventId,
        providerTargetId: String(zoomMeetingId),
        providerTargetType: zoomType || 'meeting',
        thresholdMinutes,
        scheduledEndAt,
        policy: policy.policy,
      },
      idempotencyKey: `zoom-fetch:${fetchError}:${zoomMeetingId}`,
      status: pending ? 'pending' : 'error',
      errorCode: fetchError,
      errorMessage: error,
    });
    return { success: false, pending, error, participantCount: 0, matchedCount: 0, unmatchedCount: 0 };
  }

  const { bookingsByEmail, bookings } = await matchParticipantsToBookings(
    tenantId, eventId, isComplexEvent, participants,
  );
  const thresholdMinutes = policy.thresholdMinutes;

  const now = new Date().toISOString();
  let matchedCount = 0;
  let unmatchedCount = 0;

  const allRecords = participants.map(p => {
    const email = (p.user_email || p.email || '').toLowerCase().trim();
    const candidates = email ? bookingsByEmail[email] : null;
    // Keep the legacy ledger's one-to-one booking fields truthful. Ambiguous
    // email matches are represented in provider-neutral match rows instead.
    const match = legacyBookingMatch(candidates);

    if (match) {
      matchedCount++;
    } else {
      unmatchedCount++;
    }

    return {
      tenant_id: tenantId,
      event_id: eventId,
      complex_event_session_id: complexEventSessionId || null,
      zoom_meeting_id: zoomMeetingId,
      zoom_type: zoomType || 'meeting',
      participant_email: email || null,
      participant_name: p.name || p.user_name || null,
      join_time: p.join_time || null,
      leave_time: p.leave_time || null,
      duration_minutes: p.duration != null ? Math.round(p.duration) : 0,
      matched_booking_id: match?.booking_id || null,
      matched_member_id: match?.member_id || null,
      synced_at: now,
    };
  });

  const deduped = new Map();
  const nullKeyRecords = [];
  for (const rec of allRecords) {
    if (!rec.participant_email || !rec.join_time) {
      nullKeyRecords.push(rec);
      continue;
    }
    const key = `${rec.zoom_meeting_id}|${rec.participant_email}|${rec.join_time}`;
    const existing = deduped.get(key);
    if (!existing || rec.duration_minutes > existing.duration_minutes) {
      deduped.set(key, rec);
    }
  }
  const records = [...deduped.values(), ...nullKeyRecords];

  const intervals = records.map((record, index) => {
    const providerParticipantId = null;
    const intervalKey = `${record.participant_email || 'anonymous'}:${record.join_time || index}`;
    const participantKey = normalizeParticipantKey({
      email: record.participant_email, providerParticipantId, intervalKey,
    });
    return {
      participantKey,
      intervalKey,
      email: record.participant_email,
      name: record.participant_name,
      joinedAt: record.join_time,
      leftAt: record.leave_time,
      durationSeconds: Math.max(0, record.duration_minutes * 60),
      providerParticipantId,
      metadata: { zoomType: zoomType || 'meeting' },
    };
  });
  const participantFacts = new Map();
  for (const interval of intervals) {
    if (!participantFacts.has(interval.participantKey)) participantFacts.set(interval.participantKey, interval);
  }
  const matches = [...participantFacts.values()].flatMap((participant) => {
    const candidates = participant.email ? bookingsByEmail[participant.email] : null;
    if (!candidates?.length) return [{
      participantKey: participant.participantKey, matchStatus: 'unmatched', matchedBy: null,
    }];
    if (candidates.length > 1) return candidates.map((booking) => ({
      participantKey: participant.participantKey,
      bookingType: isComplexEvent ? 'complex_event_booking' : 'booking',
      bookingId: booking.booking_id, memberId: booking.member_id,
      matchStatus: 'ambiguous', matchedBy: 'email_duplicate',
    }));
    const booking = candidates[0];
    return [{
      participantKey: participant.participantKey,
      bookingType: isComplexEvent ? 'complex_event_booking' : 'booking',
      bookingId: booking.booking_id, memberId: booking.member_id,
      matchStatus: 'matched', matchedBy: 'email',
    }];
  });
  matchedCount = matches.filter((match) => match.matchStatus === 'matched').length;
  unmatchedCount = matches.length - matchedCount;

  const persisted = await persistAttendanceReport(supabase, {
    tenantId,
    provider: 'zoom',
    target: {
      type: agendaItemId ? 'agenda_item' : (complexEventSessionId ? 'complex_event_session' : 'event'),
      id: agendaItemId || complexEventSessionId || eventId,
      eventId,
      providerTargetId: String(zoomMeetingId),
      providerTargetType: zoomType || 'meeting',
      thresholdMinutes,
      scheduledEndAt,
      policy: policy.policy,
    },
    intervals,
    matches,
    bookings,
    idempotencyKey: buildAttendanceSnapshotIdempotencyKey({
      provider: 'zoom',
      target: {
        type: agendaItemId ? 'agenda_item' : (complexEventSessionId ? 'complex_event_session' : 'event'),
        id: agendaItemId || complexEventSessionId || eventId,
        providerTargetId: String(zoomMeetingId),
        providerTargetType: zoomType || 'meeting',
        thresholdMinutes,
        policy: policy.policy,
      },
      intervals,
      matches,
      bookings,
    }),
    metadata: { source: 'zoom_reports_api' },
  });

  const { error: deleteError } = await supabase
    .from('zoom_attendance')
    .delete()
    .eq('zoom_meeting_id', zoomMeetingId)
    .eq('tenant_id', tenantId);

  if (deleteError) {
    console.error('[ZoomAttendance] Delete error:', deleteError);
    throw new Error(`Failed to clear existing attendance data: ${deleteError.message}`);
  }

  const batchSize = 100;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const { error: insertError } = await supabase
      .from('zoom_attendance')
      .insert(batch);

    if (insertError) {
      console.error('[ZoomAttendance] Insert error:', insertError);
      throw new Error(`Failed to store attendance data: ${insertError.message}`);
    }
  }

  console.log(`[ZoomAttendance] Synced ${records.length} participants for Zoom ${zoomType} ${zoomMeetingId} (${matchedCount} matched, ${unmatchedCount} unmatched)`);

  return {
    success: true,
    participantCount: records.length,
    matchedCount,
    unmatchedCount,
    attendanceTargetId: persisted.targetId,
    syncRunId: persisted.syncRunId,
    thresholdMinutes,
  };
}

export async function syncAttendanceForEvent(tenantId, eventId) {
  const { data: event, error: eventError } = await supabase
    .from('event')
    .select('id, title, zoom_meeting_id, zoom_webinar_id, is_complex, end_date')
    .eq('id', eventId)
    .eq('tenant_id', tenantId)
    .single();

  if (eventError || !event) {
    const { data: complexEvent, error: ceError } = await supabase
      .from('complex_event')
      .select('id, title')
      .eq('id', eventId)
      .eq('tenant_id', tenantId)
      .single();

    if (ceError || !complexEvent) {
      throw new Error('Event not found');
    }

    return syncAttendanceForComplexEvent(tenantId, eventId);
  }

  if (event.is_complex) {
    return syncAttendanceForComplexEvent(tenantId, eventId);
  }

  const isWebinar = !!event.zoom_webinar_id;
  const zoomRecordId = isWebinar ? event.zoom_webinar_id : event.zoom_meeting_id;
  const zoomType = isWebinar ? 'webinar' : 'meeting';

  if (!zoomRecordId) return syncAttendanceForEventAgendaItems(tenantId, eventId);

  const tableName = isWebinar ? 'zoom_webinar' : 'zoom_meeting';
  const zoomIdColumn = isWebinar ? 'zoom_webinar_id' : 'zoom_meeting_id';

  const { data: zoomRecord, error: zoomRecordError } = await supabase
    .from(tableName)
    .select(`id, ${zoomIdColumn}`)
    .eq('id', zoomRecordId)
    .eq('tenant_id', tenantId)
    .single();

  if (zoomRecordError || !zoomRecord) {
    throw new Error('Zoom record not found in database');
  }

  const zoomApiId = zoomRecord[zoomIdColumn];

  if (!zoomApiId) {
    throw new Error('Zoom record exists but has no Zoom API ID');
  }

  const eventResult = await syncAttendanceForMeeting({
    tenantId,
    eventId,
    complexEventSessionId: null,
    zoomMeetingId: zoomApiId,
    zoomType,
    isComplexEvent: false,
    scheduledEndAt: event.end_date || null,
  });
  const agendaResult = await syncAttendanceForEventAgendaItems(tenantId, eventId, { allowEmpty: true });
  if (!agendaResult.sessionResults?.length) return eventResult;
  return {
    success: eventResult.success || agendaResult.success,
    participantCount: eventResult.participantCount + agendaResult.participantCount,
    matchedCount: eventResult.matchedCount + agendaResult.matchedCount,
    unmatchedCount: eventResult.unmatchedCount + agendaResult.unmatchedCount,
    sessionResults: [{ targetType: 'event', ...eventResult }, ...agendaResult.sessionResults],
  };
}

export async function syncAttendanceForAgendaItem(tenantId, agendaItemId) {
  const { data: agenda, error } = await supabase.from('event_agenda_item')
    .select('id,event_id,zoom_meeting_id,zoom_webinar_id,end_date,end_time')
    .eq('tenant_id', tenantId).eq('id', agendaItemId).single();
  if (error || !agenda) throw new Error('Agenda item not found');
  const isWebinar = Boolean(agenda.zoom_webinar_id);
  const localZoomId = agenda.zoom_webinar_id || agenda.zoom_meeting_id;
  if (!localZoomId) throw new Error('Agenda item is not linked to a Zoom meeting or webinar');
  const zoomType = isWebinar ? 'webinar' : 'meeting';
  const tableName = isWebinar ? 'zoom_webinar' : 'zoom_meeting';
  const zoomIdColumn = isWebinar ? 'zoom_webinar_id' : 'zoom_meeting_id';
  const { data: zoom, error: zoomError } = await supabase.from(tableName).select(zoomIdColumn)
    .eq('tenant_id', tenantId).eq('id', localZoomId).single();
  if (zoomError || !zoom?.[zoomIdColumn]) throw new Error('Zoom record not found in database');
  const { data: event, error: eventError } = await supabase.from('event').select('timezone')
    .eq('tenant_id', tenantId).eq('id', agenda.event_id).single();
  if (eventError) throw new Error(`Failed to resolve agenda event timezone: ${eventError.message}`);
  return syncAttendanceForMeeting({
    tenantId, eventId: agenda.event_id, complexEventSessionId: null, agendaItemId: agenda.id,
    zoomMeetingId: zoom[zoomIdColumn], zoomType, isComplexEvent: false,
    scheduledEndAt: agendaScheduledEndAt(agenda.end_date, agenda.end_time, event?.timezone),
  });
}

async function syncAttendanceForEventAgendaItems(tenantId, eventId, { allowEmpty = false } = {}) {
  const { data: items, error } = await supabase.from('event_agenda_item')
    .select('id,description,zoom_meeting_id,zoom_webinar_id')
    .eq('tenant_id', tenantId).eq('event_id', eventId);
  if (error) throw new Error(`Failed to load agenda items: ${error.message}`);
  const online = (items || []).filter((item) => item.zoom_meeting_id || item.zoom_webinar_id);
  if (!online.length && !allowEmpty) throw new Error('Event is not linked to a Zoom meeting, webinar, or online agenda item');
  const sessionResults = [];
  for (const item of online) {
    try {
      sessionResults.push({ agendaItemId: item.id, targetType: 'agenda_item', ...await syncAttendanceForAgendaItem(tenantId, item.id) });
    } catch (err) {
      sessionResults.push({ agendaItemId: item.id, targetType: 'agenda_item', success: false, error: err.message });
    }
  }
  return {
    success: sessionResults.some((result) => result.success),
    sessionResults,
    participantCount: sessionResults.reduce((sum, result) => sum + (result.participantCount || 0), 0),
    matchedCount: sessionResults.reduce((sum, result) => sum + (result.matchedCount || 0), 0),
    unmatchedCount: sessionResults.reduce((sum, result) => sum + (result.unmatchedCount || 0), 0),
  };
}

async function syncAttendanceForComplexEvent(tenantId, eventId) {
  const { data: sessions } = await supabase
    .from('complex_event_session')
    .select('id, title, zoom_meeting_id, zoom_webinar_id, end_time')
    .eq('complex_event_id', eventId)
    .eq('tenant_id', tenantId);

  if (!sessions || sessions.length === 0) {
    throw new Error('No sessions found for this complex event');
  }

  const zoomSessions = sessions.filter(s => s.zoom_meeting_id || s.zoom_webinar_id);

  if (zoomSessions.length === 0) {
    throw new Error('No sessions in this complex event have Zoom integration');
  }

  const results = [];

  for (const session of zoomSessions) {
    const isWebinar = !!session.zoom_webinar_id;
    const zoomRecordId = isWebinar ? session.zoom_webinar_id : session.zoom_meeting_id;
    const zoomType = isWebinar ? 'webinar' : 'meeting';
    const tableName = isWebinar ? 'zoom_webinar' : 'zoom_meeting';
    const zoomIdColumn = isWebinar ? 'zoom_webinar_id' : 'zoom_meeting_id';

    try {
      const { data: zoomRecord, error: zoomRecordError } = await supabase
        .from(tableName)
        .select(`id, ${zoomIdColumn}`)
        .eq('id', zoomRecordId)
        .eq('tenant_id', tenantId)
        .single();

      if (zoomRecordError || !zoomRecord) {
        throw new Error('Zoom record not found in database');
      }

      const zoomApiId = zoomRecord[zoomIdColumn];

      if (!zoomApiId) {
        throw new Error('Zoom record exists but has no Zoom API ID');
      }

      const result = await syncAttendanceForMeeting({
        tenantId,
        eventId,
        complexEventSessionId: session.id,
        zoomMeetingId: zoomApiId,
        zoomType,
        isComplexEvent: true,
        scheduledEndAt: session.end_time || null,
      });
      results.push({ sessionId: session.id, sessionTitle: session.title, ...result });
    } catch (err) {
      console.error(`[ZoomAttendance] Error syncing session "${session.title}":`, err.message);
      results.push({ sessionId: session.id, sessionTitle: session.title, success: false, error: err.message });
    }
  }

  const totalParticipants = results.reduce((sum, r) => sum + (r.participantCount || 0), 0);
  const totalMatched = results.reduce((sum, r) => sum + (r.matchedCount || 0), 0);

  return {
    success: results.some(r => r.success),
    sessionResults: results,
    participantCount: totalParticipants,
    matchedCount: totalMatched,
    unmatchedCount: totalParticipants - totalMatched,
  };
}
