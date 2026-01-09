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
      const { data, error } = await supabase
        .from('platform_preferences')
        .select('value')
        .eq('key', 'default_role_templates')
        .single();
      
      if (error && error.code !== 'PGRST116') throw error;
      
      return res.status(200).json({
        roles: data?.value?.roles || []
      });
    }

    if (req.method === 'POST') {
      const { roles } = req.body;
      
      if (!Array.isArray(roles)) {
        return res.status(400).json({ error: 'Roles must be an array' });
      }

      const { data, error } = await supabase
        .from('platform_preferences')
        .upsert({
          key: 'default_role_templates',
          value: { roles },
          description: 'Default role configurations to provision for new tenants',
          updated_at: new Date().toISOString()
        }, { onConflict: 'key' })
        .select()
        .single();

      if (error) throw error;
      
      return res.status(200).json({
        success: true,
        roles: data.value.roles
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('[Role Templates] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
