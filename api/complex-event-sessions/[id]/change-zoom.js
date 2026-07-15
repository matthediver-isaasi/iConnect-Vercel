import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import {
  cancelZoomRegistrant,
  cancelZoomMeetingRegistrant,
  registerZoomWebinarAttendee,
  registerZoomMeetingAttendee,
} from '../../_lib/zoomClient.js';
import { sendConfirmationEmailsFromTemplate } from '../../_lib/eventConfirmationEmail.js';

// Loads a zoom_webinar / zoom_meeting row from the local table by its PK.
// Returns the cached row including the external Zoom resource ID + URLs +
// schedule fields. Returns null if missing or cross-tenant.
async function loadLocalZoomRecord(table, pkId, tenantId) {
  if (!pkId) return null;
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('id', pkId)
    .maybeSingle();
  if (error) {
    // Surface DB errors (e.g. missing column) as a real error instead of
    // silently returning null, which callers misreport as "not found".
    const err = new Error(`Failed to load ${table}: ${error.message}`);
    err.isDbError = true;
    throw err;
  }
  if (!data) return null;
  if (tenantId && data.tenant_id && data.tenant_id !== tenantId) return null;
  return data;
}

// IMPORTANT: complex_event_session.zoom_webinar_id / zoom_meeting_id store the
// EXTERNAL Zoom resource ID (a string), not the local zoom_* table PK.
// (see api/complex-event-sessions/[id]/sync-zoom.js which calls Zoom API
// directly with `session.zoom_webinar_id` in the URL).  The single `event`
// table uses the OPPOSITE convention (local PK).  This helper resolves the
// external ID for a given local Zoom row regardless of column naming.
function externalZoomIdFromLocal(table, row) {
  if (!row) return null;
  // Both local tables expose a column with the same name as the external ID.
  return row[table === 'zoom_webinar' ? 'zoom_webinar_id' : 'zoom_meeting_id'] || null;
}

// A booking impacts a session if its ticket grants access to a track that
// includes the session, OR the ticket has all_tracks=true.
async function resolveSessionScopedBookings(session, tenantId) {
  const { data: stRows } = await supabase
    .from('complex_event_session_track')
    .select('complex_event_track_id')
    .eq('complex_event_session_id', session.id)
    .eq('tenant_id', tenantId);
  const trackIds = (stRows || []).map(r => r.complex_event_track_id).filter(Boolean);

  const { data: tcRows } = await supabase
    .from('complex_event_ticket_class')
    .select('id, all_tracks, linked_track_ids')
    .eq('complex_event_id', session.complex_event_id)
    .eq('tenant_id', tenantId);

  const matchingTcIds = (tcRows || []).filter(tc => {
    if (tc.all_tracks) return true;
    const linked = Array.isArray(tc.linked_track_ids) ? tc.linked_track_ids : [];
    return linked.some(tid => trackIds.includes(tid));
  }).map(tc => tc.id);

  if (matchingTcIds.length === 0) return [];

  const { data: bookings } = await supabase
    .from('complex_event_booking')
    .select('id, attendee_email, attendee_first_name, attendee_last_name, status, event_id, tenant_id, total_paid, ticket_class_id')
    .eq('event_id', session.complex_event_id)
    .eq('tenant_id', tenantId)
    .eq('status', 'confirmed')
    .in('ticket_class_id', matchingTcIds);

  return bookings || [];
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Session id is required' });

  const ctx = await getTenantContext(req);
  if (!ctx?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
  if (!await hasAdminAccess(ctx)) return res.status(403).json({ error: 'Admin access required' });
  if (!ctx.tenantId) return res.status(403).json({ error: 'No tenant context' });

  const tenantId = ctx.tenantId;

  // GET → preview the attendee impact count for this session.
  if (req.method === 'GET') {
    const { data: session } = await supabase
      .from('complex_event_session')
      .select('id, complex_event_id, tenant_id')
      .eq('id', id).eq('tenant_id', tenantId).single();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const bookings = await resolveSessionScopedBookings(session, tenantId);
    return res.status(200).json({ confirmedBookings: bookings.length });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Inputs are LOCAL zoom_webinar / zoom_meeting PKs (UUIDs) coming from the
  // admin UI's Zoom selector, matching how single-event change-zoom works.
  const {
    zoom_webinar_id: webinarLocalPk = null,
    zoom_meeting_id: meetingLocalPk = null,
    cancelOld = true,
    registerNew = true,
    resendConfirmations = true,
    convert_to_in_person = false,
  } = req.body || {};

  if (webinarLocalPk && meetingLocalPk) {
    return res.status(400).json({ error: 'Provide only one of zoom_webinar_id or zoom_meeting_id' });
  }

  try {
    const { data: session, error: sErr } = await supabase
      .from('complex_event_session')
      .select('id, complex_event_id, tenant_id, zoom_webinar_id, zoom_meeting_id, zoom_type, start_time, end_time, history_log, zoom_join_url, zoom_start_url, zoom_registration_url')
      .eq('id', id).eq('tenant_id', tenantId).single();
    if (sErr || !session) return res.status(404).json({ error: 'Session not found' });

    // Resolve the prior external Zoom IDs by joining the local cache tables.
    // The session columns hold external IDs already, so we can use them
    // directly for cancelling registrants. We still load the local rows when
    // possible to read tenant-scoped metadata.
    const priorExternalWebinarId = session.zoom_webinar_id || null;
    const priorExternalMeetingId = session.zoom_meeting_id || null;

    // Load the new local zoom record (if any)
    const newLocalWebinar = webinarLocalPk ? await loadLocalZoomRecord('zoom_webinar', webinarLocalPk, tenantId) : null;
    const newLocalMeeting = meetingLocalPk ? await loadLocalZoomRecord('zoom_meeting', meetingLocalPk, tenantId) : null;

    if (webinarLocalPk && !newLocalWebinar) return res.status(400).json({ error: 'Selected Zoom webinar not found for this tenant' });
    if (meetingLocalPk && !newLocalMeeting) return res.status(400).json({ error: 'Selected Zoom meeting not found for this tenant' });

    const newExternalWebinarId = externalZoomIdFromLocal('zoom_webinar', newLocalWebinar);
    const newExternalMeetingId = externalZoomIdFromLocal('zoom_meeting', newLocalMeeting);

    // Build session update.  For complex_event_session, store EXTERNAL Zoom
    // IDs (consistent with sync-zoom).  Pull join/start/registration URLs +
    // schedule from the local Zoom row's cached fields.
    const newLocal = newLocalWebinar || newLocalMeeting;
    const sessionUpdate = {
      zoom_webinar_id: newExternalWebinarId,
      zoom_meeting_id: newExternalMeetingId,
      zoom_join_url: newLocal?.join_url || null,
      zoom_start_url: newLocal?.start_url || null,
      zoom_registration_url: newLocal?.registration_url || null,
    };
    if (newExternalWebinarId) sessionUpdate.zoom_type = 'webinar';
    else if (newExternalMeetingId) sessionUpdate.zoom_type = 'meeting';
    else sessionUpdate.zoom_type = null;

    if (newLocal?.start_time) {
      sessionUpdate.start_time = newLocal.start_time;
      // Local zoom_meeting/zoom_webinar use `duration_minutes`; fall back to
      // `duration` for any legacy rows.
      const minutes = Number(newLocal.duration_minutes ?? newLocal.duration ?? 0);
      if (minutes > 0) {
        sessionUpdate.end_time = new Date(new Date(newLocal.start_time).getTime() + minutes * 60000).toISOString();
      }
    }
    if (newLocal?.timezone) sessionUpdate.timezone = newLocal.timezone;

    const isClearing = !newExternalWebinarId && !newExternalMeetingId;
    if (isClearing && convert_to_in_person) {
      sessionUpdate.delivery_mode = 'in_person';
    }

    const { error: updErr } = await supabase
      .from('complex_event_session').update(sessionUpdate).eq('id', id).eq('tenant_id', tenantId);
    if (updErr) {
      console.error('[ChangeZoomSession] update error:', updErr);
      return res.status(500).json({ error: updErr.message });
    }

    const bookings = await resolveSessionScopedBookings(session, tenantId);
    const summary = { cancelled: 0, registered: 0, emailed: 0, errors: [], bookingsConsidered: bookings.length };

    // Helpers expect objects shaped like the local zoom row (registerZoom*).
    const newWebinarForRegister = newLocalWebinar
      ? { zoom_webinar_id: newExternalWebinarId, registration_required: !!newLocalWebinar.registration_required }
      : null;
    const newMeetingForRegister = newLocalMeeting
      ? { zoom_meeting_id: newExternalMeetingId, registration_required: !!newLocalMeeting.registration_required }
      : null;

    for (const b of bookings) {
      if (!b.attendee_email) continue;
      const attendee = {
        first_name: b.attendee_first_name || '',
        last_name: b.attendee_last_name || '',
        email: b.attendee_email,
      };

      if (cancelOld) {
        try {
          if (priorExternalWebinarId) {
            await cancelZoomRegistrant(tenantId, priorExternalWebinarId, b.attendee_email);
            summary.cancelled += 1;
          } else if (priorExternalMeetingId) {
            await cancelZoomMeetingRegistrant(tenantId, priorExternalMeetingId, b.attendee_email);
            summary.cancelled += 1;
          }
        } catch (err) { summary.errors.push({ bookingId: b.id, phase: 'cancel', message: err.message }); }
      }

      let personalizedJoinUrl = null;
      if (registerNew) {
        try {
          if (newWebinarForRegister) {
            const r = await registerZoomWebinarAttendee(tenantId, newWebinarForRegister, attendee);
            if (r?.success) { summary.registered += 1; personalizedJoinUrl = r.join_url || null; }
            else if (r && !r.success) summary.errors.push({ bookingId: b.id, phase: 'register', message: r.error || 'Register failed' });
          } else if (newMeetingForRegister) {
            const r = await registerZoomMeetingAttendee(tenantId, newMeetingForRegister, attendee);
            if (r?.success) { summary.registered += 1; personalizedJoinUrl = r.join_url || null; }
            else if (r && !r.success) summary.errors.push({ bookingId: b.id, phase: 'register', message: r.error || 'Register failed' });
          }
        } catch (err) { summary.errors.push({ bookingId: b.id, phase: 'register', message: err.message }); }
      }

      if (resendConfirmations) {
        try {
          const results = await sendConfirmationEmailsFromTemplate(
            session.complex_event_id, b, attendee, personalizedJoinUrl, null, tenantId,
          );
          if (results && results.some(r => r.success)) summary.emailed += 1;
        } catch (err) { summary.errors.push({ bookingId: b.id, phase: 'email', message: err.message }); }
      }
    }

    // Append history_log AFTER processing with real outcome counts.
    const prevHistory = Array.isArray(session.history_log) ? session.history_log : [];
    const historyEntry = {
      action: 'change_zoom',
      at: new Date().toISOString(),
      by: ctx.tenantUserId || ctx.memberId || null,
      prior: { zoom_webinar_id: priorExternalWebinarId, zoom_meeting_id: priorExternalMeetingId },
      next: { zoom_webinar_id: newExternalWebinarId, zoom_meeting_id: newExternalMeetingId },
      cleared: isClearing,
      converted_to_in_person: !!(isClearing && convert_to_in_person),
      side_effects: { cancelOld: !!cancelOld, registerNew: !!registerNew, resendConfirmations: !!resendConfirmations },
      outcome: { cancelled: summary.cancelled, registered: summary.registered, emailed: summary.emailed, errors: summary.errors.length },
    };
    await supabase
      .from('complex_event_session')
      .update({ history_log: [...prevHistory, historyEntry] })
      .eq('id', id).eq('tenant_id', tenantId);

    console.log(`[ChangeZoomSession] session=${id} tenant=${tenantId} summary=${JSON.stringify(summary)}`);
    return res.status(200).json({ success: true, ...summary });
  } catch (err) {
    console.error('[ChangeZoomSession] error:', err);
    return res.status(500).json({ error: err.message || 'Failed to change Zoom link' });
  }
}
