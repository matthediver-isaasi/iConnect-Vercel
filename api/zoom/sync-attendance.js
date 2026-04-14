import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { syncAttendanceForEvent, syncAttendanceForMeeting } from '../_lib/zoomAttendanceService.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext?.tenantId || !tenantContext.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const isAdmin = await hasAdminAccess(tenantContext);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const tenantId = tenantContext.tenantId;

  const { eventId, sessionId } = req.body;

  if (!eventId) {
    return res.status(400).json({ error: 'eventId is required' });
  }

  try {
    if (sessionId) {
      const { data: session, error: sessionError } = await supabase
        .from('complex_event_session')
        .select('id, title, zoom_meeting_id, zoom_webinar_id, complex_event_id')
        .eq('id', sessionId)
        .eq('tenant_id', tenantId)
        .single();

      if (sessionError || !session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const isWebinar = !!session.zoom_webinar_id;
      const zoomRecordId = isWebinar ? session.zoom_webinar_id : session.zoom_meeting_id;
      const zoomType = isWebinar ? 'webinar' : 'meeting';

      if (!zoomRecordId) {
        return res.status(400).json({ error: 'Session is not linked to a Zoom meeting or webinar' });
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
        return res.status(404).json({ error: 'Zoom record not found in database' });
      }

      const zoomApiId = zoomRecord[zoomIdColumn];

      if (!zoomApiId) {
        return res.status(400).json({ error: 'Zoom record exists but has no Zoom API ID' });
      }

      const derivedEventId = session.complex_event_id;

      const result = await syncAttendanceForMeeting({
        tenantId,
        eventId: derivedEventId,
        complexEventSessionId: session.id,
        zoomMeetingId: zoomApiId,
        zoomType,
        isComplexEvent: true,
      });

      return res.json({
        success: result.success,
        message: result.success
          ? `Synced ${result.participantCount} participants (${result.matchedCount} matched to bookings)`
          : result.error,
        ...result,
      });
    }

    const result = await syncAttendanceForEvent(tenantId, eventId);

    return res.json({
      success: result.success,
      message: result.success
        ? `Synced ${result.participantCount} participants (${result.matchedCount} matched to bookings)`
        : result.error || 'Sync failed',
      ...result,
    });
  } catch (error) {
    console.error('[ZoomAttendance] Sync error:', error);
    return res.status(500).json({ error: error.message || 'Failed to sync attendance' });
  }
}
