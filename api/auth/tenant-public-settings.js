import { supabase } from '../_lib/database.js';
import { getHostFromRequest } from '../_lib/tenantResolver.js';

// Directly query tenant without cache to ensure fresh settings
async function getTenantFresh(hostname) {
  if (!hostname || !supabase) return null;

  try {
    const host = hostname.toLowerCase().split(':')[0];
    
    const isLocalhost = host === 'localhost' || host === '127.0.0.1';
    const isReplitDev = host.includes('.replit.dev') || host.includes('.repl.co');
    
    if (isLocalhost || isReplitDev) {
      return null;
    }

    let slug = null;
    let customDomain = null;

    if (host.endsWith('.iconn.app')) {
      const parts = host.replace('.iconn.app', '').split('.');
      if (parts.length === 1 && parts[0] !== 'www' && parts[0] !== 'iconn') {
        slug = parts[0];
      }
    } else if (!host.includes('.iconn.app')) {
      customDomain = host;
    }

    if (!slug && !customDomain) {
      return null;
    }

    let tenant = null;

    if (slug) {
      const { data, error } = await supabase
        .from('tenant')
        .select('id, name, slug, domain, status, settings')
        .eq('slug', slug)
        .eq('status', 'active')
        .single();

      if (!error && data) {
        tenant = data;
      }
    } else if (customDomain) {
      const { data, error } = await supabase
        .from('tenant')
        .select('id, name, slug, domain, status, settings')
        .eq('domain', customDomain)
        .eq('status', 'active')
        .single();

      if (!error && data) {
        tenant = data;
      }
    }

    return tenant;
  } catch (err) {
    console.error('[Tenant Public Settings] Error resolving tenant:', err);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const hostname = getHostFromRequest(req);
    console.log('[Tenant Public Settings] Request from hostname:', hostname);
    
    // Query tenant directly without cache to ensure fresh settings
    const tenant = await getTenantFresh(hostname);
    console.log('[Tenant Public Settings] Resolved tenant:', tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug } : null);
    
    if (!tenant) {
      console.log('[Tenant Public Settings] No tenant found, returning default enabled=true');
      return res.json({
        success: true,
        settings: {
          member_google_login_enabled: true
        }
      });
    }

    const settings = tenant.settings || {};
    const isEnabled = settings.member_google_login_enabled !== false;
    console.log('[Tenant Public Settings] Tenant settings:', { member_google_login_enabled: settings.member_google_login_enabled, isEnabled });
    
    return res.json({
      success: true,
      tenantId: tenant.id,
      tenantName: tenant.name,
      settings: {
        member_google_login_enabled: isEnabled
      }
    });
  } catch (error) {
    console.error('[Tenant Public Settings] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch tenant settings' });
  }
}
