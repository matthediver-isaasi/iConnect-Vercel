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

  const ADMIN_FIELDS = 'id, complex_event_track_id, tenant_id, title, description, image_url, speaker_names, start_time, end_time, location, is_online, display_order, timezone, delivery_mode, created_at, updated_at';

  if (req.method === 'GET') {
    try {
      const { data: session, error } = await supabase
        .from('complex_event_session')
        .select(ADMIN_FIELDS)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return res.status(404).json({ error: 'Session not found' });
        }
        return res.status(500).json({ error: error.message });
      }

      return res.json(session);
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
        .select(ADMIN_FIELDS)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();

      if (fetchError || !existing) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const ALLOWED_FIELDS = [
        'title', 'description', 'start_time', 'end_time',
        'timezone', 'delivery_mode', 'display_order', 'location',
        'is_online', 'speaker_names', 'image_url', 'complex_event_track_id'
      ];
      const dbUpdates = { updated_at: new Date().toISOString() };
      for (const field of ALLOWED_FIELDS) {
        if (field in body) {
          dbUpdates[field] = body[field];
        }
      }

      const tz = dbUpdates.timezone || existing.timezone || 'Europe/London';
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
        .select(ADMIN_FIELDS)
        .single();

      if (updateError) {
        console.error('[Sessions] Update error:', updateError);
        return res.status(500).json({ error: 'Failed to update session' });
      }

      return res.json(session);
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
