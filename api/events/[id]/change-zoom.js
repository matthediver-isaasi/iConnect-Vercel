import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import {
  cancelZoomRegistrant,
  cancelZoomMeetingRegistrant,
  registerZoomWebinarAttendee,
  registerZoomMeetingAttendee,
} from '../../_lib/zoomClient.js';
import { sendConfirmationEmailsFromTemplate } from '../../_lib/eventConfirmationEmail.js';

async function loadZoomRecord(table, pkId, tenantId) {
  if (!pkId) return null;
  const idCol = table === 'zoom_webinar' ? 'zoom_webinar_id' : 'zoom_meeting_id';
  const { data } = await supabase
    .from(table)
    .select(`id, ${idCol}, registration_required, tenant_id, topic, start_time, duration_minutes, timezone`)
    .eq('id', pkId).maybeSingle();
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
    const { count } = await supabase
      .from('booking')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', id).eq('tenant_id', tenantId).eq('status', 'confirmed');
    return res.status(200).json({ confirmedBookings: count || 0 });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    zoom_webinar_id = null,
    zoom_meeting_id = null,
    cancelOld = true,
    registerNew = true,
    resendConfirmations = true,
    convert_to_in_person = false,
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

    // Re-sync date/time/timezone from the selected Zoom record (clear if cleared).
    const updatePatch = {
      zoom_webinar_id: zoom_webinar_id || null,
      zoom_meeting_id: zoom_meeting_id || null,
      last_synced: new Date().toISOString(),
    };
    const newZoom = newWebinar || newMeeting;
    if (newZoom?.start_time) {
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

    const { data: bookings } = await supabase
      .from('booking')
      .select('id, attendee_email, attendee_first_name, attendee_last_name, status, event_id, tenant_id, total_cost, discount_amount, free_tickets')
      .eq('event_id', id).eq('tenant_id', tenantId).eq('status', 'confirmed');

    const summary = { cancelled: 0, registered: 0, emailed: 0, errors: [] };

    for (const b of (bookings || [])) {
      if (!b.attendee_email) continue;
      const attendee = {
        first_name: b.attendee_first_name || '',
        last_name: b.attendee_last_name || '',
        email: b.attendee_email,
      };

      if (cancelOld) {
        try {
          if (priorWebinar?.zoom_webinar_id) {
            await cancelZoomRegistrant(tenantId, priorWebinar.zoom_webinar_id, b.attendee_email);
            summary.cancelled += 1;
          } else if (priorMeeting?.zoom_meeting_id) {
            await cancelZoomMeetingRegistrant(tenantId, priorMeeting.zoom_meeting_id, b.attendee_email);
            summary.cancelled += 1;
          }
        } catch (err) {
          summary.errors.push({ bookingId: b.id, phase: 'cancel', message: err.message });
        }
      }

      let personalizedJoinUrl = null;
      if (registerNew) {
        try {
          if (newWebinar?.zoom_webinar_id) {
            const r = await registerZoomWebinarAttendee(tenantId,
              { zoom_webinar_id: newWebinar.zoom_webinar_id, registration_required: !!newWebinar.registration_required }, attendee);
            if (r?.success) { summary.registered += 1; personalizedJoinUrl = r.join_url || null; }
            else if (r && !r.success) summary.errors.push({ bookingId: b.id, phase: 'register', message: r.error || 'Register failed' });
          } else if (newMeeting?.zoom_meeting_id) {
            const r = await registerZoomMeetingAttendee(tenantId,
              { zoom_meeting_id: newMeeting.zoom_meeting_id, registration_required: !!newMeeting.registration_required }, attendee);
            if (r?.success) { summary.registered += 1; personalizedJoinUrl = r.join_url || null; }
            else if (r && !r.success) summary.errors.push({ bookingId: b.id, phase: 'register', message: r.error || 'Register failed' });
          }
        } catch (err) {
          summary.errors.push({ bookingId: b.id, phase: 'register', message: err.message });
        }
      }

      if (resendConfirmations) {
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
    await supabase
      .from('event')
      .update({ history_log: [...prevHistory, historyEntry] })
      .eq('id', id).eq('tenant_id', tenantId);

    console.log(`[ChangeZoom] event=${id} tenant=${tenantId} summary=${JSON.stringify(summary)}`);
    return res.status(200).json({ success: true, ...summary });
  } catch (err) {
    console.error('[ChangeZoom] error:', err);
    return res.status(500).json({ error: err.message || 'Failed to change Zoom link' });
  }
}
