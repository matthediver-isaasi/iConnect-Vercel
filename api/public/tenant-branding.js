import { supabase } from '../_lib/database.js';
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

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const tenantData = await resolveTenantFromRequest(req);

    if (!tenantData) {
      console.log('[Tenant Branding] Tenant not found');
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
