import { supabase } from './database.js';

const tenantCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

export async function resolveTenantFromHost(hostname) {
  if (!hostname || !supabase) return null;

  const cacheKey = hostname.toLowerCase();
  const cached = tenantCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tenant;
  }

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
        .select('id, name, slug, domain, status, logo_url, header_logo_url, favicon_url, primary_color, secondary_color, tagline, header_config, footer_config, branding_config, platform_branding, settings')
        .eq('slug', slug)
        .eq('status', 'active')
        .single();

      if (!error && data) {
        tenant = data;
      }
    } else if (customDomain) {
      const { data, error } = await supabase
        .from('tenant')
        .select('id, name, slug, domain, status, logo_url, header_logo_url, favicon_url, primary_color, secondary_color, tagline, header_config, footer_config, branding_config, platform_branding, settings')
        .eq('domain', customDomain)
        .eq('status', 'active')
        .single();

      if (!error && data) {
        tenant = data;
      }
    }

    tenantCache.set(cacheKey, {
      tenant,
      expiresAt: Date.now() + CACHE_TTL
    });

    return tenant;

  } catch (err) {
    console.error('[TenantResolver] Error resolving tenant:', err);
    return null;
  }
}

export function getHostFromRequest(req) {
  return req.headers['x-forwarded-host'] || req.headers.host || '';
}

export async function resolveTenantFromRequest(req) {
  const TENANT_FIELDS = 'id, name, slug, domain, status, logo_url, header_logo_url, favicon_url, primary_color, secondary_color, tagline, header_config, footer_config, branding_config, platform_branding, settings';
  
  // Support explicit tenant identifier from query or body for embedded contexts
  const tenantParam = req.query?.tenant || req.body?.tenant || req.query?.slug;
  const domainParam = req.query?.domain;
  
  if (tenantParam) {
    // Try lookup by slug first
    const { data: bySlug } = await supabase
      .from('tenant')
      .select(TENANT_FIELDS)
      .eq('slug', tenantParam)
      .eq('status', 'active')
      .single();
    
    if (bySlug) {
      return bySlug;
    }
    
    // Fallback: try lookup by domain/subdomain
    const { data: byDomain } = await supabase
      .from('tenant')
      .select(TENANT_FIELDS)
      .eq('domain', tenantParam)
      .eq('status', 'active')
      .single();
    
    if (byDomain) {
      return byDomain;
    }
  }
  
  // Support explicit domain parameter
  if (domainParam) {
    const { data: byDomain } = await supabase
      .from('tenant')
      .select(TENANT_FIELDS)
      .eq('domain', domainParam)
      .eq('status', 'active')
      .single();
    
    if (byDomain) {
      return byDomain;
    }
  }
  
  // Fall back to host-based resolution
  const hostname = getHostFromRequest(req);
  return resolveTenantFromHost(hostname);
}

export function clearTenantCache(slugOrDomain) {
  if (slugOrDomain) {
    for (const [key] of tenantCache) {
      if (key.includes(slugOrDomain)) {
        tenantCache.delete(key);
      }
    }
  } else {
    tenantCache.clear();
  }
}
