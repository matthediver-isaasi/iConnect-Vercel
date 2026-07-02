import { supabase } from '../_lib/database.js';
import { getZoomAccessToken, getTenantIdFromSession } from '../_lib/zoomClient.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const tenantId = await getTenantIdFromSession(req);
  if (!tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { eventId } = req.query;

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
      return res.json({ 
        isLinked: false, 
        message: 'Event is not linked to a Zoom meeting or webinar' 
      });
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
      return res.json({
        isLinked: true,
        inSync: false,
        error: 'Zoom record not found in database',
        zoomType: isWebinar ? 'webinar' : 'meeting'
      });
    }

    const zoomApiId = zoomRecord[zoomIdColumn];

    if (!zoomApiId) {
      return res.json({
        isLinked: true,
        inSync: false,
        error: 'No Zoom API ID stored for this record',
        zoomType: isWebinar ? 'webinar' : 'meeting'
      });
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
        return res.json({
          isLinked: true,
          inSync: false,
          error: 'Meeting/webinar not found in Zoom (may have been deleted)',
          zoomType: isWebinar ? 'webinar' : 'meeting'
        });
      }
      const errorText = await zoomResponse.text();
      console.error('[Zoom] API error:', errorText);
      return res.status(500).json({ error: 'Failed to fetch from Zoom API' });
    }

    const zoomData = await zoomResponse.json();

    const zoomStartTime = zoomData.start_time;
    const zoomDuration = zoomData.duration;
    const zoomTimezone = zoomData.timezone;

    // Parse Zoom start time as UTC timestamp (Zoom returns ISO 8601 format)
    const zoomStartMs = Date.parse(zoomStartTime);
    const zoomEndMs = zoomStartMs + (zoomDuration * 60 * 1000);
    
    // Normalize to ISO strings for comparison and display
    const zoomStartNormalized = new Date(zoomStartMs).toISOString();
    const zoomEndTime = new Date(zoomEndMs).toISOString();

    // Parse event times as UTC timestamps
    const eventStartMs = event.start_date ? Date.parse(event.start_date) : null;
    const eventEndMs = event.end_date ? Date.parse(event.end_date) : null;

    // Compare using timestamps to avoid string formatting issues
    // Allow 1 second tolerance for rounding differences
    const startMatches = eventStartMs !== null && Math.abs(eventStartMs - zoomStartMs) < 1000;
    const endMatches = eventEndMs !== null && Math.abs(eventEndMs - zoomEndMs) < 1000;
    const inSync = startMatches && endMatches;

    return res.json({
      isLinked: true,
      inSync,
      zoomType: isWebinar ? 'webinar' : 'meeting',
      zoomTopic: zoomData.topic,
      zoomTimezone,
      event: {
        start_date: event.start_date,
        end_date: event.end_date
      },
      zoom: {
        start_time: zoomStartNormalized,
        end_time: zoomEndTime,
        duration_minutes: zoomDuration
      },
      differences: inSync ? null : {
        start: startMatches ? null : {
          event: event.start_date || null,
          zoom: zoomStartNormalized
        },
        end: endMatches ? null : {
          event: event.end_date || null,
          zoom: zoomEndTime
        }
      }
    });

  } catch (error) {
    console.error('[Zoom] Check event sync error:', error);
    return res.status(500).json({ error: error.message || 'Failed to check sync status' });
  }
}
