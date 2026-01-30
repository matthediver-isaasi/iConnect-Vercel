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
    // Support both 'slug' and 'tenant' query params for backward compatibility
    const { slug, tenant: tenantParam, domain } = req.query;
    const hostname = req.headers.host || req.headers['x-forwarded-host'];
    
    let tenantSlug = slug || tenantParam;
    
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

    const { data: tenantData, error } = await supabase
      .from('tenant')
      .select(`
        id,
        name,
        slug,
        logo_url,
        header_logo_url,
        favicon_url,
        primary_color,
        secondary_color,
        tagline,
        header_config,
        footer_config,
        branding_config,
        platform_branding,
        settings
      `)
      .eq('slug', tenantSlug)
      .eq('status', 'active')
      .single();

    if (error || !tenantData) {
      console.log('[Tenant Branding] Tenant not found:', tenantSlug, error);
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Button styles are stored in branding_config.button_styles
    const buttonStyles = tenantData.branding_config?.button_styles || {};
    
    // SEO settings from tenant settings
    const tenantSettings = tenantData.settings || {};
    const allowSearchIndexing = tenantSettings.allow_search_indexing === true;

    res.json({
      success: true,
      branding: {
        id: tenantData.id,
        name: tenantData.name,
        slug: tenantData.slug,
        logoUrl: tenantData.logo_url,
        headerLogoUrl: tenantData.header_logo_url,
        faviconUrl: tenantData.favicon_url,
        primaryColor: tenantData.primary_color || '#5C0085',
        secondaryColor: tenantData.secondary_color,
        tagline: tenantData.tagline,
        headerConfig: tenantData.header_config || {},
        footerConfig: tenantData.footer_config || {},
        brandingConfig: tenantData.branding_config || {},
        platformBranding: tenantData.platform_branding || { showPlatformBranding: true },
        buttonStyles: buttonStyles,
        allowSearchIndexing: allowSearchIndexing
      }
    });
  } catch (error) {
    console.error('[Tenant Branding] Error:', error);
    res.status(500).json({ error: 'Failed to fetch tenant branding' });
  }
}
