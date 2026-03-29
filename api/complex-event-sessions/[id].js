import { supabase } from '../_lib/database.js';
import { getSessionTenantUser } from '../_lib/session.js';
import { fromZonedTime } from 'date-fns-tz';

function convertLocalTimeToUTC(localTimeStr, timezone) {
  const localDate = new Date(localTimeStr);
  const utcDate = fromZonedTime(localDate, timezone);
  return utcDate.toISOString();
}

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

  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser?.tenant_id) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const tenantId = tenantUser.tenant_id;

  const { id } = req.query;

  const SESSION_FIELDS = 'id, complex_event_id, tenant_id, title, description, image_url, speaker_names, start_time, end_time, location, is_online, display_order, created_at, updated_at';

  if (req.method === 'GET') {
    try {
      const { data: session, error } = await supabase
        .from('complex_event_session')
        .select(SESSION_FIELDS)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return res.status(404).json({ error: 'Session not found' });
        }
        return res.status(500).json({ error: error.message });
      }

      const { data: junctions } = await supabase
        .from('complex_event_session_track')
        .select('complex_event_track_id')
        .eq('complex_event_session_id', id)
        .eq('tenant_id', tenantId);

      const track_ids = (junctions || []).map(j => j.complex_event_track_id);

      return res.json({ ...session, track_ids });
    } catch (error) {
      console.error('[Sessions] Get error:', error);
      return res.status(500).json({ error: error.message || 'Failed to get session' });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const body = req.body;

      const { data: existing, error: fetchError } = await supabase
        .from('complex_event_session')
        .select(SESSION_FIELDS)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();

      if (fetchError || !existing) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const ALLOWED_FIELDS = [
        'title', 'description', 'start_time', 'end_time',
        'display_order', 'location',
        'is_online', 'speaker_names', 'image_url', 'complex_event_id'
      ];
      const dbUpdates = { updated_at: new Date().toISOString() };
      for (const field of ALLOWED_FIELDS) {
        if (field in body) {
          dbUpdates[field] = body[field];
        }
      }

      const tz = body.timezone || 'Europe/London';
      if (dbUpdates.start_time) {
        dbUpdates.start_time = convertLocalTimeToUTC(dbUpdates.start_time, tz);
      }
      if (dbUpdates.end_time) {
        dbUpdates.end_time = convertLocalTimeToUTC(dbUpdates.end_time, tz);
      }

      const { data: session, error: updateError } = await supabase
        .from('complex_event_session')
        .update(dbUpdates)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .select(SESSION_FIELDS)
        .single();

      if (updateError) {
        console.error('[Sessions] Update error:', updateError);
        return res.status(500).json({ error: 'Failed to update session' });
      }

      if (body.track_ids && Array.isArray(body.track_ids)) {
        const newTrackIds = body.track_ids;

        if (newTrackIds.length > 0) {
          const sessionEventId = session.complex_event_id || existing.complex_event_id;
          const { data: validTracks } = await supabase
            .from('complex_event_track')
            .select('id')
            .in('id', newTrackIds)
            .eq('tenant_id', tenantId)
            .eq('complex_event_id', sessionEventId);

          const validTrackIds = (validTracks || []).map(t => t.id);
          const invalidIds = newTrackIds.filter(tid => !validTrackIds.includes(tid));
          if (invalidIds.length > 0) {
            return res.status(400).json({ error: `Invalid track IDs: ${invalidIds.join(', ')}` });
          }
        }

        const { data: existingJunctions } = await supabase
          .from('complex_event_session_track')
          .select('complex_event_track_id')
          .eq('complex_event_session_id', id)
          .eq('tenant_id', tenantId);

        const existingTrackIds = (existingJunctions || []).map(j => j.complex_event_track_id);

        const toAdd = newTrackIds.filter(tid => !existingTrackIds.includes(tid));
        const toRemove = existingTrackIds.filter(tid => !newTrackIds.includes(tid));

        if (toRemove.length > 0) {
          const { error: removeError } = await supabase
            .from('complex_event_session_track')
            .delete()
            .eq('complex_event_session_id', id)
            .eq('tenant_id', tenantId)
            .in('complex_event_track_id', toRemove);
          if (removeError) {
            console.error('[Sessions] Junction remove error:', removeError);
            return res.status(500).json({ error: 'Failed to update track assignments' });
          }
        }

        if (toAdd.length > 0) {
          const rows = toAdd.map(tid => ({
            complex_event_session_id: id,
            complex_event_track_id: tid,
            tenant_id: tenantId,
          }));
          const { error: insertError } = await supabase
            .from('complex_event_session_track')
            .insert(rows);
          if (insertError) {
            console.error('[Sessions] Junction insert error:', insertError);
            return res.status(500).json({ error: 'Failed to update track assignments' });
          }
        }
      }

      const { data: updatedJunctions } = await supabase
        .from('complex_event_session_track')
        .select('complex_event_track_id')
        .eq('complex_event_session_id', id)
        .eq('tenant_id', tenantId);

      const track_ids = (updatedJunctions || []).map(j => j.complex_event_track_id);

      return res.json({ ...session, track_ids });
    } catch (error) {
      console.error('[Sessions] Update error:', error);
      return res.status(500).json({ error: error.message || 'Failed to update session' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { data: session, error: fetchError } = await supabase
        .from('complex_event_session')
        .select('id, tenant_id')
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();

      if (fetchError || !session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const { error: deleteError } = await supabase
        .from('complex_event_session')
        .delete()
        .eq('id', id)
        .eq('tenant_id', tenantId);

      if (deleteError) {
        console.error('[Sessions] Delete error:', deleteError);
        return res.status(500).json({ error: 'Failed to delete session' });
      }

      return res.json({ success: true });
    } catch (error) {
      console.error('[Sessions] Delete error:', error);
      return res.status(500).json({ error: error.message || 'Failed to delete session' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
