import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { resolveMicrositeByPrefix, mergeMicrositeConfig } from '../_lib/microsites.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Host, X-Forwarded-Host');

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
    const ga4MeasurementId = tenantSettings.ga4_measurement_id || null;

    // Task #2426: microsite chrome. `?microsite=prefix` merges the
    // microsite's header/footer/logo over the tenant defaults so any field
    // the microsite leaves empty falls back to the tenant value.
    let microsite = null;
    const micrositePrefix = typeof req.query.microsite === 'string' ? req.query.microsite.trim() : '';
    if (micrositePrefix) {
      microsite = await resolveMicrositeByPrefix(supabase, tenantData.id, micrositePrefix);
      if (!microsite) {
        return res.status(404).json({ error: 'Microsite not found' });
      }
    }

    const headerConfig = microsite
      ? mergeMicrositeConfig(tenantData.header_config, microsite.header_config)
      : (tenantData.header_config || {});
    const footerConfig = microsite
      ? mergeMicrositeConfig(tenantData.footer_config, microsite.footer_config)
      : (tenantData.footer_config || {});

    res.json({
      success: true,
      branding: {
        id: tenantData.id,
        name: tenantData.name,
        slug: tenantData.slug,
        logoUrl: (microsite?.logo_url || tenantData.logo_url),
        headerLogoUrl: (microsite?.logo_url || tenantData.header_logo_url),
        faviconUrl: tenantData.favicon_url,
        primaryColor: tenantData.primary_color || '#5C0085',
        secondaryColor: tenantData.secondary_color,
        tagline: tenantData.tagline,
        headerConfig,
        footerConfig,
        microsite: microsite ? {
          id: microsite.id,
          name: microsite.name,
          pathPrefix: microsite.path_prefix,
          logoUrl: microsite.logo_url || null,
          homePageId: microsite.home_page_id || null,
        } : null,
        brandingConfig: tenantData.branding_config || {},
        platformBranding: tenantData.platform_branding || { showPlatformBranding: true },
        buttonStyles: buttonStyles,
        allowSearchIndexing: allowSearchIndexing,
        ga4MeasurementId: ga4MeasurementId
      }
    });
  } catch (error) {
    console.error('[Tenant Branding] Error:', error);
    res.status(500).json({ error: 'Failed to fetch tenant branding' });
  }
}
