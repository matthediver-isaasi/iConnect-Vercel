import { supabase } from '../_lib/database.js';
import { getTenantIdFromSession } from '../_lib/zoomClient.js';

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

  try {
    const { start_time, duration_minutes, host_id, exclude_webinar_id } = req.body;
    
    if (!start_time || !duration_minutes) {
      return res.status(400).json({ error: 'start_time and duration_minutes are required' });
    }
    
    const startDate = new Date(start_time);
    const endDate = new Date(startDate.getTime() + duration_minutes * 60 * 1000);
    
    let query = supabase
      .from('zoom_webinar')
      .select('*')
      .eq('tenant_id', tenantId)
      .neq('status', 'cancelled');
    
    if (exclude_webinar_id) {
      query = query.neq('id', exclude_webinar_id);
    }
    
    if (host_id) {
      query = query.eq('zoom_host_id', host_id);
    }
    
    const { data: webinars, error } = await query;
    
    if (error) {
      console.error('[Zoom] Conflict check DB error:', error);
      return res.status(500).json({ error: 'Failed to check conflicts' });
    }
    
    const conflicts = (webinars || []).filter((w) => {
      const wStart = new Date(w.start_time);
      const wEnd = new Date(wStart.getTime() + w.duration_minutes * 60 * 1000);
      return startDate < wEnd && endDate > wStart;
    });
    
    return res.json({
      hasConflicts: conflicts.length > 0,
      conflicts: conflicts.map((c) => ({
        id: c.id,
        topic: c.topic,
        start_time: c.start_time,
        duration_minutes: c.duration_minutes,
        zoom_webinar_id: c.zoom_webinar_id
      }))
    });
  } catch (error) {
    console.error('[Zoom] Conflict check error:', error);
    return res.status(500).json({ error: error.message || 'Failed to check conflicts' });
  }
}
