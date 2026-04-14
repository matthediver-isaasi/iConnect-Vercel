import { supabase } from './database.js';
import { getZoomAccessTokenForTenant } from './zoomClient.js';

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

  if (emails.length === 0) return {};

  const bookingsByEmail = {};

  if (isComplexEvent) {
    const { data: bookings } = await supabase
      .from('complex_event_booking')
      .select('id, member_id, attendee_email')
      .eq('event_id', eventId)
      .eq('tenant_id', tenantId)
      .neq('status', 'cancelled');

    if (bookings) {
      for (const b of bookings) {
        const email = (b.attendee_email || '').toLowerCase().trim();
        if (email) {
          bookingsByEmail[email] = { booking_id: b.id, member_id: b.member_id };
        }
      }
    }
  } else {
    const { data: bookings } = await supabase
      .from('booking')
      .select('id, member_id, attendee_email')
      .eq('event_id', eventId)
      .eq('tenant_id', tenantId)
      .neq('status', 'cancelled');

    if (bookings) {
      for (const b of bookings) {
        const email = (b.attendee_email || '').toLowerCase().trim();
        if (email) {
          bookingsByEmail[email] = { booking_id: b.id, member_id: b.member_id };
        }
      }
    }
  }

  return bookingsByEmail;
}

export async function syncAttendanceForMeeting({
  tenantId,
  eventId,
  complexEventSessionId,
  zoomMeetingId,
  zoomType,
  isComplexEvent,
}) {
  if (!supabase || !tenantId || !zoomMeetingId) {
    throw new Error('Missing required parameters for attendance sync');
  }

  const token = await getZoomAccessTokenForTenant(tenantId);
  const { participants, error: fetchError } = await fetchZoomParticipants(token, zoomMeetingId, zoomType);

  if (fetchError === 'not_found') {
    return { success: false, error: 'Meeting data not yet available in Zoom Reports API. Try again in a few minutes after the meeting has ended.', participantCount: 0, matchedCount: 0 };
  }

  if (fetchError === 'bad_request') {
    return { success: false, error: 'Invalid meeting ID or meeting has not ended yet.', participantCount: 0, matchedCount: 0 };
  }

  if (participants.length === 0) {
    return { success: true, participantCount: 0, matchedCount: 0, unmatchedCount: 0 };
  }

  const bookingsByEmail = await matchParticipantsToBookings(tenantId, eventId, isComplexEvent, participants);

  const now = new Date().toISOString();
  let matchedCount = 0;
  let unmatchedCount = 0;

  const records = participants.map(p => {
    const email = (p.user_email || p.email || '').toLowerCase().trim();
    const match = email ? bookingsByEmail[email] : null;

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

  let deleteQuery = supabase
    .from('zoom_attendance')
    .delete()
    .eq('zoom_meeting_id', zoomMeetingId)
    .eq('tenant_id', tenantId)
    .eq('event_id', eventId);

  if (complexEventSessionId) {
    deleteQuery = deleteQuery.eq('complex_event_session_id', complexEventSessionId);
  }

  await deleteQuery;

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
  };
}

export async function syncAttendanceForEvent(tenantId, eventId) {
  const { data: event, error: eventError } = await supabase
    .from('event')
    .select('id, title, zoom_meeting_id, zoom_webinar_id, is_complex')
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

  if (!zoomRecordId) {
    throw new Error('Event is not linked to a Zoom meeting or webinar');
  }

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

  return syncAttendanceForMeeting({
    tenantId,
    eventId,
    complexEventSessionId: null,
    zoomMeetingId: zoomApiId,
    zoomType,
    isComplexEvent: false,
  });
}

async function syncAttendanceForComplexEvent(tenantId, eventId) {
  const { data: sessions } = await supabase
    .from('complex_event_session')
    .select('id, title, zoom_meeting_id, zoom_webinar_id')
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
