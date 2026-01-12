import { supabase } from '../_lib/database.js';

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

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { slug, domain } = req.query;
    const hostname = req.headers.host || req.headers['x-forwarded-host'];
    
    let tenantSlug = slug;
    
    if (!tenantSlug && hostname) {
      if (hostname.endsWith('.iconn.app')) {
        tenantSlug = hostname.replace('.iconn.app', '');
      } else if (domain) {
        const { data: tenantByDomain } = await supabase
          .from('tenant')
          .select('slug')
          .eq('domain', domain)
          .eq('status', 'active')
          .single();
        tenantSlug = tenantByDomain?.slug;
      }
    }

    if (!tenantSlug) {
      return res.status(400).json({ error: 'Tenant slug required' });
    }

    const { data: tenant, error } = await supabase
      .from('tenant')
      .select(`
        id,
        name,
        slug,
        logo_url,
        favicon_url,
        primary_color,
        secondary_color,
        tagline,
        header_config,
        footer_config,
        branding_config
      `)
      .eq('slug', tenantSlug)
      .eq('status', 'active')
      .single();

    if (error || !tenant) {
      console.log('[Tenant Branding] Tenant not found:', tenantSlug, error);
      return res.status(404).json({ error: 'Tenant not found' });
    }

    res.json({
      success: true,
      branding: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        logoUrl: tenant.logo_url,
        faviconUrl: tenant.favicon_url,
        primaryColor: tenant.primary_color || '#5C0085',
        secondaryColor: tenant.secondary_color,
        tagline: tenant.tagline,
        headerConfig: tenant.header_config || {},
        footerConfig: tenant.footer_config || {},
        brandingConfig: tenant.branding_config || {}
      }
    });
  } catch (error) {
    console.error('[Tenant Branding] Error:', error);
    res.status(500).json({ error: 'Failed to fetch tenant branding' });
  }
}
