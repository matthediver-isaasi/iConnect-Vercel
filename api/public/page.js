import { createClient } from '@supabase/supabase-js';

function getTenantSlugFromHost(host) {
  if (!host) return null;
  
  const parts = host.split('.');
  if (parts.length >= 2) {
    const subdomain = parts[0];
    if (subdomain && subdomain !== 'www' && subdomain !== 'iconn' && subdomain !== 'localhost') {
      return subdomain;
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.DEV_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[Public Page] Missing Supabase credentials');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const tenantSlug = req.query.tenant || getTenantSlugFromHost(host);
    const pageSlug = req.query.slug;

    if (!tenantSlug) {
      return res.status(400).json({ error: 'Tenant not specified' });
    }

    if (!pageSlug) {
      return res.status(400).json({ error: 'Page slug required' });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from('tenant')
      .select('id, name')
      .eq('slug', tenantSlug)
      .eq('status', 'active')
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: page, error: pageError } = await supabase
      .from('iedit_page')
      .select(`
        id,
        slug,
        title,
        meta_title,
        meta_description,
        status,
        require_authentication,
        layout_type
      `)
      .eq('tenant_id', tenant.id)
      .eq('slug', pageSlug)
      .eq('status', 'published')
      .single();

    if (pageError || !page) {
      return res.status(404).json({ error: 'Page not found' });
    }

    if (page.require_authentication) {
      return res.status(403).json({ error: 'Page requires authentication' });
    }

    const { data: elements, error: elementsError } = await supabase
      .from('iedit_page_element')
      .select(`
        id,
        element_type,
        content,
        display_order,
        is_active
      `)
      .eq('page_id', page.id)
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    if (elementsError) {
      console.error('[Public Page] Elements query error:', elementsError);
      return res.status(500).json({ error: 'Failed to fetch page elements' });
    }

    return res.status(200).json({
      page,
      elements: elements || []
    });
  } catch (error) {
    console.error('[Public Page] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
