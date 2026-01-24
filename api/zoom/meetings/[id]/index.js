import { supabase } from '../../../_lib/database.js';
import { getZoomAccessToken, getTenantIdFromSession } from '../../../_lib/zoomClient.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const tenantId = await getTenantIdFromSession(req);
  if (!tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { id } = req.query;

  if (req.method === 'GET') {
    try {
      const { data: meeting, error: meetingError } = await supabase
        .from('zoom_meeting')
        .select('*')
        .eq('id', id)
        .single();
      
      if (meetingError) {
        if (meetingError.code === 'PGRST116') {
          return res.status(404).json({ error: 'Meeting not found' });
        }
        return res.status(500).json({ error: meetingError.message });
      }
      
      return res.json(meeting);
    } catch (error) {
      console.error('[Zoom] Get meeting error:', error);
      return res.status(500).json({ error: error.message || 'Failed to get meeting' });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const updates = req.body;
      
      const { data: existing, error: fetchError } = await supabase
        .from('zoom_meeting')
        .select('zoom_meeting_id')
        .eq('id', id)
        .single();
      
      if (fetchError) {
        return res.status(404).json({ error: 'Meeting not found' });
      }
      
      if (updates.topic || updates.start_time || updates.duration_minutes || updates.agenda || updates.timezone) {
        const token = await getZoomAccessToken(req);
        
        const zoomUpdates = {};
        if (updates.topic) zoomUpdates.topic = updates.topic;
        if (updates.start_time) zoomUpdates.start_time = updates.start_time;
        if (updates.duration_minutes) zoomUpdates.duration = updates.duration_minutes;
        if (updates.agenda) zoomUpdates.agenda = updates.agenda;
        if (updates.timezone) zoomUpdates.timezone = updates.timezone;
        
        const zoomResponse = await fetch(
          `https://api.zoom.us/v2/meetings/${existing.zoom_meeting_id}`,
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
          console.error('[Zoom] Update meeting error:', errorText);
          return res.status(zoomResponse.status).json({ error: 'Failed to update Zoom meeting' });
        }
      }
      
      const { data: meeting, error: updateError } = await supabase
        .from('zoom_meeting')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      
      if (updateError) {
        console.error('[Zoom] DB update error:', updateError);
        return res.status(500).json({ error: 'Failed to update meeting' });
      }
      
      return res.json(meeting);
    } catch (error) {
      console.error('[Zoom] Update meeting error:', error);
      return res.status(500).json({ error: error.message || 'Failed to update meeting' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { deleteFromZoom = 'true' } = req.query;
      
      const { data: meeting, error: fetchError } = await supabase
        .from('zoom_meeting')
        .select('zoom_meeting_id')
        .eq('id', id)
        .single();
      
      if (fetchError) {
        return res.status(404).json({ error: 'Meeting not found' });
      }
      
      if (deleteFromZoom === 'true' && meeting.zoom_meeting_id) {
        const token = await getZoomAccessToken(req);
        
        const zoomResponse = await fetch(
          `https://api.zoom.us/v2/meetings/${meeting.zoom_meeting_id}`,
          {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${token}`
            }
          }
        );
        
        if (!zoomResponse.ok && zoomResponse.status !== 204 && zoomResponse.status !== 404) {
          const errorText = await zoomResponse.text();
          console.error('[Zoom] Delete meeting error:', errorText);
          return res.status(zoomResponse.status).json({ error: 'Failed to delete from Zoom' });
        }
      }
      
      const { error: updateError } = await supabase
        .from('zoom_meeting')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', id);
      
      if (updateError) {
        console.error('[Zoom] DB update error:', updateError);
        return res.status(500).json({ error: 'Failed to cancel meeting' });
      }
      
      return res.json({ success: true });
    } catch (error) {
      console.error('[Zoom] Delete meeting error:', error);
      return res.status(500).json({ error: error.message || 'Failed to delete meeting' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
