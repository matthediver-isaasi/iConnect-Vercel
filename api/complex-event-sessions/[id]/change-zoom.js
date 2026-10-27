import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import {
  cancelZoomRegistrant,
  cancelZoomMeetingRegistrant,
} from '../../_lib/zoomClient.js';
import { sendConfirmationEmailsFromTemplate } from '../../_lib/eventConfirmationEmail.js';
import { zoomAuthority } from '../../_lib/eventZoomRegistration.js';
import { listZoomRegistrations, registerWithZoom } from '../../_lib/zoomRegistration.js';

// Loads a zoom_webinar / zoom_meeting row from the local table by its PK.
// Returns the cached row including the external Zoom resource ID + URLs +
// schedule fields. Returns null if missing or cross-tenant.
async function loadLocalZoomRecord(table, pkId, tenantId) {
  if (!pkId) return null;
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('id', pkId)
    .eq('tenant_id', tenantId)
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
  const { data: stRows, error: trackError } = await supabase
    .from('complex_event_session_track')
    .select('complex_event_track_id')
    .eq('complex_event_session_id', session.id)
    .eq('tenant_id', tenantId);
  if (trackError) throw new Error('Session track lookup failed');
  const trackIds = (stRows || []).map(r => r.complex_event_track_id).filter(Boolean);

  const { data: tcRows, error: ticketError } = await supabase
    .from('complex_event_ticket_class')
    .select('id, all_tracks, linked_track_ids')
    .eq('complex_event_id', session.complex_event_id)
    .eq('tenant_id', tenantId);
  if (ticketError) throw new Error('Session ticket lookup failed');

  const matchingTcIds = (tcRows || []).filter(tc => {
    if (tc.all_tracks) return true;
    const linked = Array.isArray(tc.linked_track_ids) ? tc.linked_track_ids : [];
    return linked.some(tid => trackIds.includes(tid));
  }).map(tc => tc.id);

  if (matchingTcIds.length === 0) return [];

  const bookings = [];
  for (let offset = 0; ; offset += 500) {
  const { data, error } = await supabase
    .from('complex_event_booking')
    .select('id, attendee_email, attendee_first_name, attendee_last_name, status, event_id, tenant_id, total_paid, ticket_class_id')
    .eq('event_id', session.complex_event_id)
    .eq('tenant_id', tenantId)
    .eq('status', 'confirmed')
    .in('ticket_class_id', matchingTcIds).order('id').range(offset, offset + 499);
  if (error || !data) throw new Error('Session booking lookup failed');
  bookings.push(...data);
  if (data.length < 500) break;
  if (bookings.length >= 50000) throw new Error('Too many session bookings');
  }
  return bookings;
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
    try {
    const { data: session } = await supabase
      .from('complex_event_session')
      .select('id, complex_event_id, tenant_id, zoom_meeting_id, zoom_webinar_id')
      .eq('id', id).eq('tenant_id', tenantId).single();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const bookings = await resolveSessionScopedBookings(session, tenantId);
    const current = { zoom_meeting_id: null, zoom_webinar_id: null };
    for (const kind of ['meeting', 'webinar']) {
      if (!session[`zoom_${kind}_id`]) continue;
      const { data, error } = await supabase.from(`zoom_${kind}`).select('id')
        .eq('tenant_id', tenantId).eq(`zoom_${kind}_id`, session[`zoom_${kind}_id`]).maybeSingle();
      if (error) throw new Error('Current Zoom target lookup failed');
      current[`zoom_${kind}_id`] = data?.id || null;
    }
    return res.status(200).json({ confirmedBookings: bookings.length, current });
    } catch (error) { return res.status(502).json({ error: error.message }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Inputs are LOCAL zoom_webinar / zoom_meeting PKs (UUIDs) coming from the
  // admin UI's Zoom selector, matching how single-event change-zoom works.
  const {
    zoom_webinar_id: webinarLocalPk = null,
    zoom_meeting_id: meetingLocalPk = null,
    cancelOld = true,
    registerNew = true,
    resendConfirmations = false,
    convert_to_in_person = false,
    afterBookingId = null,
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
    const sameTarget = priorExternalWebinarId === newExternalWebinarId && priorExternalMeetingId === newExternalMeetingId;
    const allBookings = await resolveSessionScopedBookings(session, tenantId);
    if (!sameTarget && allBookings.length > 25 && (registerNew || cancelOld || resendConfirmations)) {
      return res.status(409).json({ error: 'For more than 25 bookings, attach without attendee actions first, then select the current Zoom target to reconcile registrations. Existing registrations will not be cancelled.' });
    }
    if (afterBookingId && !sameTarget) return res.status(409).json({ error: 'Zoom target changed; restart reconciliation.' });
    const bookings = allBookings.filter(b => !afterBookingId || b.id > afterBookingId).slice(0, 25);
    let authority = null, registrants = null;
    if ((registerNew || resendConfirmations) && (newLocalWebinar || newLocalMeeting)) {
      authority = await zoomAuthority(tenantId, newLocalWebinar || newLocalMeeting, newLocalMeeting ? 'meetings' : 'webinars');
      if (registerNew && !authority.live.registration_required) return res.status(409).json({ error: 'Registration is disabled in Zoom. Enable it in Zoom first, or uncheck registration to attach only.' });
      if (authority.live.registration_required) registrants = await listZoomRegistrations(authority.token, authority.kind, authority.id);
    }

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
      ...(newLocal ? { online_provider: 'zoom' } : {}),
    };
    if (newExternalWebinarId) sessionUpdate.zoom_type = 'webinar';
    else if (newExternalMeetingId) sessionUpdate.zoom_type = 'meeting';
    else sessionUpdate.zoom_type = null;

    if (newLocal?.start_time && !sameTarget) {
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

    const summary = { cancelled: 0, registered: 0, existing: 0, skipped: 0, pending: 0, denied: 0, failed: 0, missingEmail: 0, emailed: 0, errors: [], bookingsConsidered: bookings.length };
    const recordResult = (r, bookingId) => {
      if (r?.skipped) summary.skipped++;
      else if (r?.outcome === 'pending' || r?.outcome === 'denied') summary[r.outcome]++;
      else if (r?.success && r.already_registered) summary.existing++;
      else if (r?.success) summary.registered++;
      else summary.failed++;
      if (!r?.success) summary.errors.push({ bookingId, phase: 'register', message: r?.error || r?.outcome || 'Register failed' });
      return r?.success ? r.join_url || null : null;
    };

    // Helpers expect objects shaped like the local zoom row (registerZoom*).
    const newWebinarForRegister = newLocalWebinar
      ? { zoom_webinar_id: newExternalWebinarId, registration_required: !!newLocalWebinar.registration_required }
      : null;
    const newMeetingForRegister = newLocalMeeting
      ? { zoom_meeting_id: newExternalMeetingId, registration_required: !!newLocalMeeting.registration_required }
      : null;

    for (const b of bookings) {
      if (!b.attendee_email?.trim()) { summary.missingEmail++; continue; }
      const attendee = {
        first_name: b.attendee_first_name || '',
        last_name: b.attendee_last_name || '',
        email: b.attendee_email,
      };

      if (cancelOld && !sameTarget) {
        try {
          if (priorExternalWebinarId) {
            if (!await cancelZoomRegistrant(tenantId, priorExternalWebinarId, b.attendee_email)) throw new Error('Zoom cancellation failed');
            summary.cancelled += 1;
          } else if (priorExternalMeetingId) {
            if (!await cancelZoomMeetingRegistrant(tenantId, priorExternalMeetingId, b.attendee_email)) throw new Error('Zoom cancellation failed');
            summary.cancelled += 1;
          }
        } catch (err) { summary.errors.push({ bookingId: b.id, phase: 'cancel', message: err.message }); }
      }

      let personalizedJoinUrl = null;
      if (registerNew) {
        try {
          if (newWebinarForRegister) {
            const r = await registerWithZoom(authority.token, authority.kind, authority.id, attendee, registrants);
            personalizedJoinUrl = recordResult(r, b.id);
          } else if (newMeetingForRegister) {
            const r = await registerWithZoom(authority.token, authority.kind, authority.id, attendee, registrants);
            personalizedJoinUrl = recordResult(r, b.id);
          }
        } catch (err) { summary.failed++; summary.errors.push({ bookingId: b.id, phase: 'register', message: err.message }); }
      }

      if (!registerNew && authority?.live.registration_required) {
        const existing = registrants.get(b.attendee_email.trim().toLowerCase());
        if (existing?.status === 'approved') personalizedJoinUrl = existing.join_url || null;
      }
      if (resendConfirmations) {
        if (authority?.live.registration_required && !personalizedJoinUrl) {
          summary.errors.push({ bookingId: b.id, phase: 'email', message: 'Email not sent: registration did not supply an approved join link' });
          continue;
        }
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
    const { error: historyError } = await supabase
      .from('complex_event_session')
      .update({ history_log: [...prevHistory, historyEntry] })
      .eq('id', id).eq('tenant_id', tenantId);

    if (historyError) summary.errors.push({ phase: 'history', message: 'Actions completed but history could not be saved' });
    const hasMore = sameTarget && allBookings.some(b => b.id > bookings.at(-1)?.id);
    return res.status(200).json({ success: summary.errors.length === 0, ...summary, nextCursor: hasMore ? bookings.at(-1).id : null });
  } catch (err) {
    console.error('[ChangeZoomSession] error:', err);
    return res.status(500).json({ error: err.message || 'Failed to change Zoom link' });
  }
}
