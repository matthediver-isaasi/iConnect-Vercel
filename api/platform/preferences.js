import { getSupabaseClient } from '../_lib/database.js';
import { getSessionPlatformOwner } from '../_lib/platformSession.js';

export default async function handler(req, res) {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const owner = await getSessionPlatformOwner(req);
  if (!owner) {
    return res.status(403).json({ error: 'Platform owner access required' });
  }

  try {
    if (req.method === 'GET') {
      const { key } = req.query;
      
      if (key) {
        const { data, error } = await supabase
          .from('platform_preferences')
          .select('*')
          .eq('key', key)
          .single();
        
        if (error) {
          return res.status(404).json({ error: 'Preference not found' });
        }
        return res.status(200).json(data);
      }
      
      const { data, error } = await supabase
        .from('platform_preferences')
        .select('*')
        .order('key');
      
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      const { key, value, description } = req.body;
      
      if (!key) {
        return res.status(400).json({ error: 'Key is required' });
      }

      const { data, error } = await supabase
        .from('platform_preferences')
        .upsert({
          key,
          value: value || {},
          description: description || null,
          updated_at: new Date().toISOString()
        }, { onConflict: 'key' })
        .select()
        .single();

      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method === 'DELETE') {
      const { key } = req.query;
      
      if (!key) {
        return res.status(400).json({ error: 'Key is required' });
      }

      const { error } = await supabase
        .from('platform_preferences')
        .delete()
        .eq('key', key);

      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('[Platform Preferences] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
