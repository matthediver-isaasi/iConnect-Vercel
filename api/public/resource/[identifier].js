import { createClient } from '@supabase/supabase-js';

const PUBLIC_RESOURCE_FIELDS = [
  'id', 'title', 'description', 'image_url', 'target_url', 
  'resource_type', 'is_public', 'published_date', 'created_date',
  'author_name', 'tags', 'category_id'
];

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
  const tenantIdentifier = tenantParam || subdomain;
  
  if (!tenantIdentifier || tenantIdentifier === 'www' || tenantIdentifier === 'iconn') {
    return res.status(400).json({ error: 'Invalid tenant context' });
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
      .select('id, subdomain, slug')
      .eq('slug', tenantIdentifier)
      .eq('status', 'active')
      .single();
    
    if (tenantResult.error || !tenantResult.data) {
      tenantResult = await supabase
        .from('tenant')
        .select('id, subdomain, slug')
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
      .select('*')
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

    const publicResource = {};
    for (const field of PUBLIC_RESOURCE_FIELDS) {
      if (resource[field] !== undefined) {
        publicResource[field] = resource[field];
      }
    }

    publicResource.is_locked = !resource.is_public;
    
    const tenantSlug = tenant.slug || tenant.subdomain;
    publicResource.login_redirect_url = `https://${tenantSlug}.iconn.app/login?returnTo=/resources&resourceId=${resource.id}`;

    if (!resource.is_public) {
      delete publicResource.target_url;
    }

    return res.json(publicResource);
  } catch (error) {
    console.error('Resource fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch resource' });
  }
}
