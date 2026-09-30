import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.isAuthenticated || !tenantCtx.tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const { briefId } = req.query;

    if (!briefId) {
      return res.status(400).json({ error: 'briefId is required' });
    }

    const { data: brief, error: briefError } = await supabase
      .from('article_brief')
      .select('id')
      .eq('id', briefId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (briefError || !brief) {
      return res.status(404).json({ error: 'Article brief not found' });
    }

    const { data: activities, error: activityError } = await supabase
      .from('article_brief_activity')
      .select('*, performed_by_member:member!article_brief_activity_performed_by_fkey(id, first_name, last_name, email, profile_image:profile_image_url)')
      .eq('article_brief_id', briefId)
      .eq('tenant_id', tenantCtx.tenantId)
      .order('created_at', { ascending: true });

    if (activityError) {
      console.error('[BriefActivity] Error fetching activities:', activityError);
      const { data: fallbackActivities, error: fallbackError } = await supabase
        .from('article_brief_activity')
        .select('*')
        .eq('article_brief_id', briefId)
        .eq('tenant_id', tenantCtx.tenantId)
        .order('created_at', { ascending: true });

      if (fallbackError) {
        return res.status(500).json({ error: 'Failed to fetch activities: ' + fallbackError.message });
      }

      return res.json(fallbackActivities || []);
    }

    return res.json(activities || []);

  } catch (error) {
    console.error('[BriefActivity] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch activity log: ' + (error.message || 'Unknown error') });
  }
}
