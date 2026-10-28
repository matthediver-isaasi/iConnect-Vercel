import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import {
  cancelZoomRegistrant,
  cancelZoomMeetingRegistrant,
} from '../../_lib/zoomClient.js';
import { confirmedZoomBookings, zoomAuthority, zoomEvidence } from '../../_lib/eventZoomRegistration.js';
import { listZoomRegistrations, registerWithZoom } from '../../_lib/zoomRegistration.js';
import { sendConfirmationEmailsFromTemplate } from '../../_lib/eventConfirmationEmail.js';

async function loadZoomRecord(table, pkId, tenantId) {
  if (!pkId) return null;
  const idCol = table === 'zoom_webinar' ? 'zoom_webinar_id' : 'zoom_meeting_id';
  const { data, error } = await supabase
    .from(table)
    .select(`id, ${idCol}, registration_required, tenant_id, topic, start_time, duration_minutes, timezone`)
    .eq('id', pkId).eq('tenant_id', tenantId).maybeSingle();
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

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Event id is required' });

  const ctx = await getTenantContext(req);
  if (!ctx?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
  if (!await hasAdminAccess(ctx)) return res.status(403).json({ error: 'Admin access required' });
  if (!ctx.tenantId) return res.status(403).json({ error: 'No tenant context' });
  const tenantId = ctx.tenantId;

  // GET → impact preview: return count of confirmed bookings that would be
  // affected by a Zoom change.  Admin UI calls this before opening the
  // confirmation step so the user sees the blast radius.
  if (req.method === 'GET') {
    try {
      const { data: event, error } = await supabase.from('event').select('id,zoom_meeting_id,zoom_webinar_id').eq('id', id).eq('tenant_id', tenantId).single();
      if (error || !event) return res.status(404).json({ error: 'Event not found' });
      let bookings = null, bookingError = null;
      try { bookings = await confirmedZoomBookings(id, tenantId); }
      catch (error) { bookingError = error.message; }
      const meetingId = req.query.zoom_meeting_id || (!req.query.zoom_webinar_id && event.zoom_meeting_id);
      const webinarId = req.query.zoom_webinar_id || (!req.query.zoom_meeting_id && event.zoom_webinar_id);
      const record = await loadZoomRecord(meetingId ? 'zoom_meeting' : 'zoom_webinar', meetingId || webinarId, tenantId);
      if ((meetingId || webinarId) && !record) return res.status(404).json({ error: 'Zoom target not found' });
      return res.status(200).json({
        confirmedBookings: bookings?.length ?? null,
        bookingError,
        current: { zoom_meeting_id: event.zoom_meeting_id, zoom_webinar_id: event.zoom_webinar_id },
        ...(record ? await zoomEvidence(tenantId, record, meetingId ? 'meetings' : 'webinars', bookings) : {}),
      });
    } catch (error) { return res.status(502).json({ error: error.message }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    zoom_webinar_id = null,
    zoom_meeting_id = null,
    cancelOld = true,
    registerNew = true,
    resendConfirmations = false,
    convert_to_in_person = false,
    enableRegistration = false,
    afterBookingId = null,
  } = req.body || {};

  if (zoom_webinar_id && zoom_meeting_id) {
    return res.status(400).json({ error: 'Provide only one of zoom_webinar_id or zoom_meeting_id' });
  }

  try {
    const { data: event, error: evErr } = await supabase
      .from('event')
      .select('id, tenant_id, zoom_webinar_id, zoom_meeting_id, history_log, start_date, end_date, timezone')
      .eq('id', id).eq('tenant_id', tenantId).single();
    if (evErr || !event) return res.status(404).json({ error: 'Event not found' });

    const priorWebinarPk = event.zoom_webinar_id || null;
    const priorMeetingPk = event.zoom_meeting_id || null;
    const priorWebinar = priorWebinarPk ? await loadZoomRecord('zoom_webinar', priorWebinarPk, tenantId) : null;
    const priorMeeting = priorMeetingPk ? await loadZoomRecord('zoom_meeting', priorMeetingPk, tenantId) : null;

    const newWebinar = zoom_webinar_id ? await loadZoomRecord('zoom_webinar', zoom_webinar_id, tenantId) : null;
    const newMeeting = zoom_meeting_id ? await loadZoomRecord('zoom_meeting', zoom_meeting_id, tenantId) : null;

    if (zoom_webinar_id && !newWebinar) return res.status(400).json({ error: 'Selected Zoom webinar not found for this tenant' });
    if (zoom_meeting_id && !newMeeting) return res.status(400).json({ error: 'Selected Zoom meeting not found for this tenant' });

    const sameTarget = priorWebinarPk === zoom_webinar_id && priorMeetingPk === zoom_meeting_id;
    const allBookings = await confirmedZoomBookings(id, tenantId);
    if (!sameTarget && allBookings.length > 25 && (registerNew || cancelOld || resendConfirmations)) {
      return res.status(409).json({ error: 'For more than 25 bookings, attach without attendee actions first, then use Reconcile registrations. Existing registrations will not be cancelled.' });
    }
    if (afterBookingId && !sameTarget) return res.status(409).json({ error: 'Zoom target changed; restart reconciliation.' });
    const bookings = allBookings.filter(b => !afterBookingId || b.id > afterBookingId).slice(0, 25);
    let authority = null, registrants = null;
    if (newWebinar || newMeeting) {
      authority = await zoomAuthority(tenantId, newWebinar || newMeeting, newMeeting ? 'meetings' : 'webinars', enableRegistration === true && registerNew === true);
      if (registerNew && !authority.live.registration_required) {
        return res.status(409).json({ code: 'REGISTRATION_DISABLED', error: 'Registration is disabled in Zoom. Confirm enabling registration or attach without registering attendees.' });
      }
      if (registerNew || (resendConfirmations && authority.live.registration_required)) {
        registrants = await listZoomRegistrations(authority.token, authority.kind, authority.id);
      }
      const { error } = await supabase.from(newMeeting ? 'zoom_meeting' : 'zoom_webinar')
        .update({ registration_required: authority.live.registration_required }).eq('id', (newMeeting || newWebinar).id).eq('tenant_id', tenantId);
      if (error) throw new Error('Zoom verified, but local registration setting could not be saved');
    }

    // Re-sync date/time/timezone from the selected Zoom record (clear if cleared).
    const updatePatch = {
      zoom_webinar_id: zoom_webinar_id || null,
      zoom_meeting_id: zoom_meeting_id || null,
      last_synced: new Date().toISOString(),
    };
    const newZoom = newWebinar || newMeeting;
    if (newZoom) {
      updatePatch.is_online = true;
      updatePatch.online_provider = 'zoom';
    }
    if (newZoom?.start_time && !sameTarget) {
      updatePatch.start_date = newZoom.start_time;
      // Local zoom_meeting/zoom_webinar tables store length in `duration_minutes`.
      // Fall back to `duration` defensively for any legacy rows.
      const minutes = Number(newZoom.duration_minutes ?? newZoom.duration ?? 0);
      if (minutes > 0) {
        const end = new Date(new Date(newZoom.start_time).getTime() + minutes * 60000);
        updatePatch.end_date = end.toISOString();
      }
      if (newZoom.timezone) updatePatch.timezone = newZoom.timezone;
    }

    // Explicit online→in-person conversion when clearing Zoom
    const isClearing = !zoom_webinar_id && !zoom_meeting_id;
    if (isClearing && convert_to_in_person) {
      updatePatch.is_online = false;
    }

    const { error: updErr } = await supabase
      .from('event').update(updatePatch).eq('id', id).eq('tenant_id', tenantId);
    if (updErr) {
      console.error('[ChangeZoom] update event error:', updErr);
      return res.status(500).json({ error: updErr.message });
    }

    const summary = { cancelled: 0, registered: 0, existing: 0, pending: 0, denied: 0, skipped: 0, missingEmail: 0, failed: 0, emailed: 0, errors: [] };

    for (const b of (bookings || [])) {
      if (!b.attendee_email?.trim()) { summary.missingEmail++; continue; }
      const attendee = {
        first_name: b.attendee_first_name || '',
        last_name: b.attendee_last_name || '',
        email: b.attendee_email,
      };

      if (cancelOld && !sameTarget) {
        try {
          if (priorWebinar?.zoom_webinar_id) {
            if (!await cancelZoomRegistrant(tenantId, priorWebinar.zoom_webinar_id, b.attendee_email)) throw new Error('Zoom cancellation failed');
            summary.cancelled += 1;
          } else if (priorMeeting?.zoom_meeting_id) {
            if (!await cancelZoomMeetingRegistrant(tenantId, priorMeeting.zoom_meeting_id, b.attendee_email)) throw new Error('Zoom cancellation failed');
            summary.cancelled += 1;
          }
        } catch (err) {
          summary.errors.push({ bookingId: b.id, phase: 'cancel', message: err.message });
        }
      }

      let personalizedJoinUrl = null;
      if (registerNew) {
        try {
          if (authority) {
            const r = await registerWithZoom(authority.token, authority.kind, authority.id, attendee, registrants);
            const key = r.outcome === 'new' ? 'registered' : r.outcome === 'missing_email' ? 'missingEmail' : r.outcome;
            summary[key in summary ? key : 'failed']++;
            personalizedJoinUrl = r.join_url || null;
            if (r.error) summary.errors.push({ bookingId: b.id, phase: 'register', message: r.error });
          } else {
            summary.skipped++;
          }
        } catch (err) {
          summary.failed++;
          summary.errors.push({ bookingId: b.id, phase: 'register', message: err.message });
        }
      } else if (authority?.live.registration_required) {
        const existing = registrants?.get(b.attendee_email.trim().toLowerCase());
        if (existing?.status === 'approved') personalizedJoinUrl = existing.join_url || null;
      }

      if (resendConfirmations) {
        if (authority?.live.registration_required && !personalizedJoinUrl) {
          summary.errors.push({ bookingId: b.id, phase: 'email', message: 'Email not sent: no approved personalised join link' });
          continue;
        }
        try {
          const results = await sendConfirmationEmailsFromTemplate(id, b, attendee, personalizedJoinUrl, null, tenantId);
          if (results && results.some(r => r.success)) summary.emailed += 1;
        } catch (err) {
          summary.errors.push({ bookingId: b.id, phase: 'email', message: err.message });
        }
      }
    }

    // Append history_log AFTER processing so we can record real outcome counts.
    const prevHistory = Array.isArray(event.history_log) ? event.history_log : [];
    const historyEntry = {
      action: 'change_zoom',
      at: new Date().toISOString(),
      by: ctx.tenantUserId || ctx.memberId || null,
      prior: { zoom_webinar_id: priorWebinarPk, zoom_meeting_id: priorMeetingPk },
      next: { zoom_webinar_id: zoom_webinar_id || null, zoom_meeting_id: zoom_meeting_id || null },
      cleared: isClearing,
      converted_to_in_person: !!(isClearing && convert_to_in_person),
      side_effects: { cancelOld: !!cancelOld, registerNew: !!registerNew, resendConfirmations: !!resendConfirmations },
      outcome: { cancelled: summary.cancelled, registered: summary.registered, emailed: summary.emailed, errors: summary.errors.length },
    };
    const { error: historyError } = await supabase
      .from('event')
      .update({ history_log: [...prevHistory, historyEntry] })
      .eq('id', id).eq('tenant_id', tenantId);

    if (historyError) summary.errors.push({ phase: 'history', message: 'Actions completed but history could not be saved' });
    const hasMore = sameTarget && allBookings.some(b => b.id > bookings.at(-1)?.id);
    return res.status(200).json({ success: summary.errors.length === 0, ...summary, eventPatch: updatePatch, nextCursor: hasMore ? bookings.at(-1).id : null });
  } catch (err) {
    console.error('[ChangeZoom] error:', err);
    return res.status(500).json({ error: err.message || 'Failed to change Zoom link' });
  }
}
