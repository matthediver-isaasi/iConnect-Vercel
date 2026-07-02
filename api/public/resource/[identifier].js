import { supabase } from '../../_lib/database.js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';

const PUBLIC_RESOURCE_COLUMNS = 'id, title, description, image_url, target_url, resource_type, is_public, open_in_new_tab, release_date, author_name, tags, subcategories, tenant_id';

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

  const { identifier } = req.query;

  if (!identifier) {
    return res.status(400).json({ error: 'Resource identifier is required' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      console.error('[Public Resource API] Tenant not found');
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    
    let resourceQuery = supabase
      .from('resource')
      .select(PUBLIC_RESOURCE_COLUMNS)
      .eq('tenant_id', tenant.id)
      .eq('status', 'active');
    
    if (isUUID) {
      resourceQuery = resourceQuery.eq('id', identifier);
    } else {
      resourceQuery = resourceQuery.eq('slug', identifier);
    }

    const { data: resource, error } = await resourceQuery.single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Resource not found or inactive' });
      }
      console.error('Error fetching resource:', error);
      return res.status(500).json({ error: error.message });
    }

    if (!resource) {
      return res.status(404).json({ error: 'Resource not found' });
    }

    const publicResource = {
      id: resource.id,
      title: resource.title,
      description: resource.description,
      image_url: resource.image_url,
      resource_type: resource.resource_type,
      is_public: resource.is_public,
      open_in_new_tab: resource.open_in_new_tab,
      release_date: resource.release_date,
      author_name: resource.author_name,
      tags: resource.tags,
      subcategories: resource.subcategories,
      is_locked: !resource.is_public
    };

    const tenantDomain = tenant.domain || `${tenant.slug}.iconn.app`;
    publicResource.login_redirect_url = `https://${tenantDomain}/login?returnTo=/resources&resourceId=${resource.id}`;

    if (resource.is_public && resource.target_url) {
      publicResource.target_url = resource.target_url;
    }

    return res.json(publicResource);
  } catch (error) {
    console.error('Resource fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch resource' });
  }
}
