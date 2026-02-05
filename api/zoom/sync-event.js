import { supabase } from '../_lib/database.js';
import { getZoomAccessToken, getTenantIdFromSession } from '../_lib/zoomClient.js';

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
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const tenantId = await getTenantIdFromSession(req);
  if (!tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { eventId } = req.body;

  if (!eventId) {
    return res.status(400).json({ error: 'eventId is required' });
  }

  try {
    const { data: event, error: eventError } = await supabase
      .from('event')
      .select('id, title, start_date, end_date, zoom_meeting_id, zoom_webinar_id')
      .eq('id', eventId)
      .eq('tenant_id', tenantId)
      .single();

    if (eventError || !event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    if (!event.zoom_meeting_id && !event.zoom_webinar_id) {
      return res.status(400).json({ error: 'Event is not linked to a Zoom meeting or webinar' });
    }

    const isWebinar = !!event.zoom_webinar_id;
    const zoomRecordId = isWebinar ? event.zoom_webinar_id : event.zoom_meeting_id;
    const tableName = isWebinar ? 'zoom_webinar' : 'zoom_meeting';
    const zoomIdColumn = isWebinar ? 'zoom_webinar_id' : 'zoom_meeting_id';

    const { data: zoomRecord, error: zoomRecordError } = await supabase
      .from(tableName)
      .select(`id, ${zoomIdColumn}, topic, start_time, duration_minutes, timezone`)
      .eq('id', zoomRecordId)
      .eq('tenant_id', tenantId)
      .single();

    if (zoomRecordError || !zoomRecord) {
      return res.status(404).json({ error: 'Zoom record not found in database' });
    }

    const zoomApiId = zoomRecord[zoomIdColumn];

    if (!zoomApiId) {
      return res.status(400).json({ error: 'No Zoom API ID stored for this record' });
    }

    const token = await getZoomAccessToken(req);
    const endpoint = isWebinar 
      ? `https://api.zoom.us/v2/webinars/${zoomApiId}`
      : `https://api.zoom.us/v2/meetings/${zoomApiId}`;

    const zoomResponse = await fetch(endpoint, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!zoomResponse.ok) {
      if (zoomResponse.status === 404) {
        return res.status(404).json({ error: 'Meeting/webinar not found in Zoom (may have been deleted)' });
      }
      const errorText = await zoomResponse.text();
      console.error('[Zoom] API error:', errorText);
      return res.status(500).json({ error: 'Failed to fetch from Zoom API' });
    }

    const zoomData = await zoomResponse.json();

    const zoomStartTime = zoomData.start_time;
    const zoomDuration = zoomData.duration;
    const zoomTimezone = zoomData.timezone;

    const zoomStartNormalized = new Date(zoomStartTime).toISOString();
    const zoomEndTime = new Date(new Date(zoomStartTime).getTime() + (zoomDuration * 60 * 1000)).toISOString();

    const { error: zoomUpdateError } = await supabase
      .from(tableName)
      .update({
        start_time: zoomStartNormalized,
        duration_minutes: zoomDuration,
        timezone: zoomTimezone,
        updated_at: new Date().toISOString()
      })
      .eq('id', zoomRecordId)
      .eq('tenant_id', tenantId);

    if (zoomUpdateError) {
      console.error('[Zoom] Failed to update zoom record:', zoomUpdateError);
      return res.status(500).json({ error: 'Failed to update Zoom record' });
    }

    const { error: eventUpdateError } = await supabase
      .from('event')
      .update({
        start_date: zoomStartNormalized,
        end_date: zoomEndTime,
        timezone: zoomTimezone,
        updated_at: new Date().toISOString()
      })
      .eq('id', eventId)
      .eq('tenant_id', tenantId);

    if (eventUpdateError) {
      console.error('[Zoom] Failed to update event:', eventUpdateError);
      return res.status(500).json({ error: 'Failed to update event' });
    }

    console.log(`[Zoom] Synced event "${event.title}" with Zoom ${isWebinar ? 'webinar' : 'meeting'}`);
    console.log(`  start_date: ${event.start_date} -> ${zoomStartNormalized}`);
    console.log(`  end_date: ${event.end_date} -> ${zoomEndTime}`);

    return res.json({
      success: true,
      message: `Event synced with Zoom ${isWebinar ? 'webinar' : 'meeting'}`,
      updated: {
        start_date: zoomStartNormalized,
        end_date: zoomEndTime,
        duration_minutes: zoomDuration,
        timezone: zoomTimezone
      }
    });

  } catch (error) {
    console.error('[Zoom] Sync event error:', error);
    return res.status(500).json({ error: error.message || 'Failed to sync event' });
  }
}
