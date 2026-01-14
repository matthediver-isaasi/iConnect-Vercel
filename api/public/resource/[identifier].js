import { createClient } from '@supabase/supabase-js';

const PUBLIC_RESOURCE_COLUMNS = 'id, title, description, image_url, target_url, resource_type, is_public, published_date, created_date, author_name, tags, category_id, tenant_id';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { identifier, tenant: tenantParam } = req.query;

  if (!identifier) {
    return res.status(400).json({ error: 'Resource identifier is required' });
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const subdomain = host.split('.')[0];
  
  const isRootDomain = !subdomain || subdomain === 'www' || subdomain === 'iconn';
  const tenantIdentifier = tenantParam || (!isRootDomain ? subdomain : null);
  
  if (!tenantIdentifier) {
    return res.status(400).json({ error: 'Tenant parameter is required for root domain requests' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    let tenantResult = await supabase
      .from('tenant')
      .select('id, subdomain, slug, custom_domain')
      .eq('slug', tenantIdentifier)
      .eq('status', 'active')
      .single();
    
    if (tenantResult.error || !tenantResult.data) {
      tenantResult = await supabase
        .from('tenant')
        .select('id, subdomain, slug, custom_domain')
        .eq('subdomain', tenantIdentifier)
        .single();
    }

    const { data: tenant, error: tenantError } = tenantResult;

    if (tenantError || !tenant) {
      console.error('[Public Resource API] Tenant lookup failed:', { 
        tenantIdentifier, 
        error: tenantError?.message || 'No tenant found'
      });
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    
    let resourceQuery = supabase
      .from('resource')
      .select(PUBLIC_RESOURCE_COLUMNS)
      .eq('tenant_id', tenant.id)
      .eq('is_active', true);
    
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
      published_date: resource.published_date,
      created_date: resource.created_date,
      author_name: resource.author_name,
      tags: resource.tags,
      category_id: resource.category_id,
      is_locked: !resource.is_public
    };

    const tenantDomain = tenant.custom_domain || `${tenant.slug || tenant.subdomain}.iconn.app`;
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
