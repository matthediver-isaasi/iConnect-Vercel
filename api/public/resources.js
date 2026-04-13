import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

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

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: resources, error } = await supabase
      .from('resource')
      .select(`
        id,
        title,
        description,
        image_url,
        target_url,
        resource_type,
        release_date,
        author_name,
        subcategories,
        tags,
        is_public,
        open_in_new_tab,
        allowed_role_ids,
        linked_events
      `)
      .eq('tenant_id', tenant.id)
      .eq('status', 'active')
      .order('release_date', { ascending: false });

    if (error) {
      console.error('[Public Resources] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch resources' });
    }

    const tenant_domain = tenant.domain || `${tenant.slug}.iconn.app`;
    const publicResources = (resources || []).filter(r => {
      if (r.linked_events && Array.isArray(r.linked_events) && r.linked_events.length > 0) {
        return false;
      }
      return true;
    }).map(r => ({
      ...r,
      target_url: r.is_public ? r.target_url : null,
      is_locked: !r.is_public,
      login_redirect_url: !r.is_public
        ? `https://${tenant_domain}/login?returnTo=/resources&resourceId=${r.id}`
        : null
    }));

    res.json(publicResources);
  } catch (error) {
    console.error('[Public Resources] Error:', error);
    res.status(500).json({ error: 'Failed to fetch resources' });
  }
}
