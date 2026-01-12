import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getSessionMember } from '../_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=30');

  if (!supabase) {
    return res.status(200).json({ 
      logoUrl: null, 
      faviconUrl: null,
      logoHeight: 'medium',
      logoLink: '',
      homePageSlug: ''
    });
  }

  try {
    let tenant = null;
    
    tenant = await resolveTenantFromRequest(req);
    
    if (!tenant) {
      const sessionMember = await getSessionMember(req);
      if (sessionMember) {
        let tenantId = sessionMember.tenant_id;
        
        if (!tenantId && sessionMember.organization_id) {
          const { data: orgData } = await supabase
            .from('organization')
            .select('tenant_id')
            .eq('id', sessionMember.organization_id)
            .single();
          
          if (orgData?.tenant_id) {
            tenantId = orgData.tenant_id;
          }
        }
        
        if (tenantId) {
          const { data: tenantData } = await supabase
            .from('tenant')
            .select('id, name, slug, logo_url, header_logo_url, favicon_url, primary_color, settings')
            .eq('id', tenantId)
            .single();
          
          if (tenantData) {
            tenant = tenantData;
          }
        }
      }
    }

    if (tenant) {
      const settings = tenant.settings || {};
      return res.status(200).json({
        logoUrl: tenant.header_logo_url || tenant.logo_url || null,
        faviconUrl: tenant.favicon_url || null,
        logoHeight: settings.logo_height || 'medium',
        logoLink: settings.logo_link || '',
        homePageSlug: settings.home_page_slug || '',
        dateDisplayFormat: settings.date_display_format || 'DD/MM/YYYY',
        tenantName: tenant.name || null,
        source: 'tenant'
      });
    }

    const { data: systemSettings } = await supabase
      .from('system_settings')
      .select('setting_key, setting_value')
      .in('setting_key', [
        'portal_logo_url',
        'site_favicon_url',
        'portal_logo_height',
        'portal_logo_link',
        'public_home_page_slug',
        'date_display_format'
      ]);

    const settings = {};
    if (systemSettings) {
      for (const s of systemSettings) {
        settings[s.setting_key] = s.setting_value;
      }
    }

    return res.status(200).json({
      logoUrl: settings.portal_logo_url || null,
      faviconUrl: settings.site_favicon_url || null,
      logoHeight: settings.portal_logo_height || 'medium',
      logoLink: settings.portal_logo_link || '',
      homePageSlug: settings.public_home_page_slug || '',
      dateDisplayFormat: settings.date_display_format || 'DD/MM/YYYY',
      source: 'system_settings'
    });

  } catch (error) {
    console.error('[Portal Branding] Error:', error);
    return res.status(200).json({ 
      logoUrl: null, 
      faviconUrl: null,
      logoHeight: 'medium',
      logoLink: '',
      homePageSlug: ''
    });
  }
}
