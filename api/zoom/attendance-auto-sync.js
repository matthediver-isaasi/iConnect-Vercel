import { supabase } from '../_lib/database.js';
import { syncAttendanceForMeeting } from '../_lib/zoomAttendanceService.js';

const AUTO_SYNC_SECRET = process.env.ZOOM_AUTO_SYNC_SECRET;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  if (!AUTO_SYNC_SECRET) {
    return res.status(403).json({ error: 'Auto-sync is not configured. Set ZOOM_AUTO_SYNC_SECRET environment variable.' });
  }

  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (bearerToken !== AUTO_SYNC_SECRET) {
    return res.status(401).json({ error: 'Invalid or missing auto-sync secret.' });
  }

  try {
    const now = new Date();
    const delayMs = 30 * 60 * 1000;
    const cutoffTime = new Date(now.getTime() - delayMs).toISOString();
    const maxAge = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const results = [];

    const { data: regularEvents } = await supabase
      .from('event')
      .select('id, title, tenant_id, zoom_meeting_id, zoom_webinar_id, end_date, is_complex')
      .not('zoom_meeting_id', 'is', null)
      .lt('end_date', cutoffTime)
      .gt('end_date', maxAge)
      .eq('is_complex', false);

    const { data: regularEventsWebinar } = await supabase
      .from('event')
      .select('id, title, tenant_id, zoom_meeting_id, zoom_webinar_id, end_date, is_complex')
      .not('zoom_webinar_id', 'is', null)
      .lt('end_date', cutoffTime)
      .gt('end_date', maxAge)
      .eq('is_complex', false);

    const allRegularEvents = [];
    const seenEventIds = new Set();
    for (const ev of [...(regularEvents || []), ...(regularEventsWebinar || [])]) {
      if (!seenEventIds.has(ev.id)) {
        seenEventIds.add(ev.id);
        allRegularEvents.push(ev);
      }
    }

    for (const event of allRegularEvents) {
      const zoomId = event.zoom_webinar_id || event.zoom_meeting_id;

      const { data: existingSync } = await supabase
        .from('zoom_attendance')
        .select('synced_at')
        .eq('zoom_meeting_id', zoomId)
        .eq('tenant_id', event.tenant_id)
        .order('synced_at', { ascending: false })
        .limit(1);

      if (existingSync && existingSync.length > 0) {
        const lastSync = new Date(existingSync[0].synced_at);
        const meetingEnd = new Date(event.end_date);
        if (lastSync > meetingEnd) {
          continue;
        }
      }

      try {
        const result = await syncAttendanceForMeeting({
          tenantId: event.tenant_id,
          eventId: event.id,
          complexEventSessionId: null,
          zoomMeetingId: zoomId,
          zoomType: event.zoom_webinar_id ? 'webinar' : 'meeting',
          isComplexEvent: false,
        });
        results.push({ eventId: event.id, title: event.title, ...result });
      } catch (err) {
        console.error(`[ZoomAttendanceAutoSync] Error syncing event "${event.title}":`, err.message);
        results.push({ eventId: event.id, title: event.title, success: false, error: err.message });
      }
    }

    const { data: sessions } = await supabase
      .from('complex_event_session')
      .select('id, title, tenant_id, complex_event_id, zoom_meeting_id, zoom_webinar_id, end_time')
      .lt('end_time', cutoffTime)
      .gt('end_time', maxAge);

    const zoomSessions = (sessions || []).filter(s => s.zoom_meeting_id || s.zoom_webinar_id);

    for (const session of zoomSessions) {
      const zoomId = session.zoom_webinar_id || session.zoom_meeting_id;

      const { data: existingSync } = await supabase
        .from('zoom_attendance')
        .select('synced_at')
        .eq('zoom_meeting_id', zoomId)
        .eq('tenant_id', session.tenant_id)
        .order('synced_at', { ascending: false })
        .limit(1);

      if (existingSync && existingSync.length > 0) {
        const lastSync = new Date(existingSync[0].synced_at);
        const sessionEnd = new Date(session.end_time);
        if (lastSync > sessionEnd) {
          continue;
        }
      }

      try {
        const result = await syncAttendanceForMeeting({
          tenantId: session.tenant_id,
          eventId: session.complex_event_id,
          complexEventSessionId: session.id,
          zoomMeetingId: zoomId,
          zoomType: session.zoom_webinar_id ? 'webinar' : 'meeting',
          isComplexEvent: true,
        });
        results.push({ sessionId: session.id, title: session.title, ...result });
      } catch (err) {
        console.error(`[ZoomAttendanceAutoSync] Error syncing session "${session.title}":`, err.message);
        results.push({ sessionId: session.id, title: session.title, success: false, error: err.message });
      }
    }

    const synced = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log(`[ZoomAttendanceAutoSync] Completed: ${synced} synced, ${failed} failed, ${results.length} total`);

    return res.json({
      success: true,
      message: `Auto-sync completed: ${synced} synced, ${failed} failed`,
      totalProcessed: results.length,
      synced,
      failed,
      results,
    });
  } catch (error) {
    console.error('[ZoomAttendanceAutoSync] Error:', error);
    return res.status(500).json({ error: error.message || 'Auto-sync failed' });
  }
}
