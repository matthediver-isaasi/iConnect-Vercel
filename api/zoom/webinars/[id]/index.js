import { supabase } from '../../../_lib/database.js';
import { getZoomAccessToken, getTenantIdFromSession } from '../../../_lib/zoomClient.js';
import { fromZonedTime } from 'date-fns-tz';
import { isValidWebinarDuration, WEBINAR_DURATION_ERROR } from '../../../../shared/zoomWebinarDuration.js';

function convertLocalTimeToUTC(localTimeStr, timezone) {
  const localDate = new Date(localTimeStr);
  const utcDate = fromZonedTime(localDate, timezone);
  return utcDate.toISOString();
}

export default async function handler(req, res, deps = {}) {
  const db = deps.db || supabase;
  const tenantFor = deps.tenantFor || getTenantIdFromSession;
  const tokenFor = deps.tokenFor || getZoomAccessToken;
  const fetchZoom = deps.fetchZoom || fetch;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!db) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const tenantId = await tenantFor(req);
  if (!tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { id } = req.query;

  if (req.method === 'GET') {
    try {
      const { data: webinar, error: webinarError } = await db
        .from('zoom_webinar')
        .select('*')
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();
      
      if (webinarError) {
        if (webinarError.code === 'PGRST116') {
          return res.status(404).json({ error: 'Webinar not found' });
        }
        return res.status(500).json({ error: webinarError.message });
      }
      
      // Panelists are safe to fetch by webinar_id since we've already verified
      // the webinar belongs to this tenant in the query above
      const { data: panelists } = await db
        .from('zoom_webinar_panelist')
        .select('*')
        .eq('webinar_id', webinar.id)
        .order('created_at', { ascending: true });
      
      return res.json({ ...webinar, panelists: panelists || [] });
    } catch (error) {
      console.error('[Zoom] Get webinar error:', error);
      return res.status(500).json({ error: error.message || 'Failed to get webinar' });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const updates = req.body;
      if (Object.hasOwn(updates, 'duration_minutes') && !isValidWebinarDuration(updates.duration_minutes)) {
        return res.status(400).json({ error: WEBINAR_DURATION_ERROR });
      }
      
      const { data: existing, error: fetchError } = await db
        .from('zoom_webinar')
        .select('zoom_webinar_id, timezone')
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();
      
      if (fetchError) {
        return res.status(404).json({ error: 'Webinar not found' });
      }
      
      if (updates.topic || updates.start_time || updates.duration_minutes || updates.agenda || updates.timezone) {
        const token = await tokenFor(req);
        
        const zoomUpdates = {};
        if (updates.topic) zoomUpdates.topic = updates.topic;
        if (updates.start_time) zoomUpdates.start_time = updates.start_time;
        if (updates.duration_minutes) zoomUpdates.duration = updates.duration_minutes;
        if (updates.agenda) zoomUpdates.agenda = updates.agenda;
        if (updates.timezone) zoomUpdates.timezone = updates.timezone;
        
        const zoomResponse = await fetchZoom(
          `https://api.zoom.us/v2/webinars/${existing.zoom_webinar_id}`,
          {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(zoomUpdates)
          }
        );
        
        if (!zoomResponse.ok && zoomResponse.status !== 204) {
          const errorText = await zoomResponse.text();
          console.error('[Zoom] Update webinar error:', errorText);
          return res.status(zoomResponse.status).json({ error: 'Failed to update Zoom webinar' });
        }
      }
      
      const dbUpdates = { ...updates, updated_at: new Date().toISOString() };
      
      if (updates.start_time) {
        const timezone = updates.timezone || existing.timezone || 'Europe/London';
        dbUpdates.start_time = convertLocalTimeToUTC(updates.start_time, timezone);
        console.log('[Zoom] Converted start_time:', updates.start_time, 'in', timezone, '-> UTC:', dbUpdates.start_time);
      }
      
      const { data: webinar, error: updateError } = await db
        .from('zoom_webinar')
        .update(dbUpdates)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .select()
        .single();
      
      if (updateError) {
        console.error('[Zoom] DB update error:', updateError);
        return res.status(500).json({ error: 'Failed to update webinar' });
      }
      
      return res.json(webinar);
    } catch (error) {
      console.error('[Zoom] Update webinar error:', error);
      return res.status(500).json({ error: error.message || 'Failed to update webinar' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { deleteFromZoom = 'true' } = req.query;
      
      const { data: webinar, error: fetchError } = await db
        .from('zoom_webinar')
        .select('zoom_webinar_id')
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();
      
      if (fetchError) {
        return res.status(404).json({ error: 'Webinar not found' });
      }
      
      if (deleteFromZoom === 'true' && webinar.zoom_webinar_id) {
        const token = await tokenFor(req);
        
        const zoomResponse = await fetchZoom(
          `https://api.zoom.us/v2/webinars/${webinar.zoom_webinar_id}`,
          {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${token}`
            }
          }
        );
        
        if (!zoomResponse.ok && zoomResponse.status !== 204 && zoomResponse.status !== 404) {
          const errorText = await zoomResponse.text();
          console.error('[Zoom] Delete webinar error:', errorText);
          return res.status(zoomResponse.status).json({ error: 'Failed to delete from Zoom' });
        }
      }
      
      const { error: updateError } = await db
        .from('zoom_webinar')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('tenant_id', tenantId);
      
      if (updateError) {
        console.error('[Zoom] DB update error:', updateError);
        return res.status(500).json({ error: 'Failed to cancel webinar' });
      }
      
      return res.json({ success: true });
    } catch (error) {
      console.error('[Zoom] Delete webinar error:', error);
      return res.status(500).json({ error: error.message || 'Failed to delete webinar' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
