import { supabase } from './database.js';

const tenantCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

export async function resolveTenantFromHost(hostname) {
  console.log('[TenantResolver] resolveTenantFromHost called with:', hostname);
  
  if (!hostname) {
    console.log('[TenantResolver] No hostname provided');
    return null;
  }
  
  if (!supabase) {
    console.error('[TenantResolver] Supabase client not initialized');
    return null;
  }

  const cacheKey = hostname.toLowerCase();
  const cached = tenantCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log('[TenantResolver] Cache hit for:', cacheKey);
    return cached.tenant;
  }

  try {
    const host = hostname.toLowerCase().split(':')[0];
    console.log('[TenantResolver] Parsed host:', host);
    
    const isLocalhost = host === 'localhost' || host === '127.0.0.1';
    const isReplitDev = host.includes('.replit.dev') || host.includes('.repl.co');
    
    if (isLocalhost || isReplitDev) {
      console.log('[TenantResolver] Skipping localhost/replit dev');
      return null;
    }

    let slug = null;
    let customDomain = null;

    if (host.endsWith('.iconn.app')) {
      const parts = host.replace('.iconn.app', '').split('.');
      if (parts.length === 1 && parts[0] !== 'www' && parts[0] !== 'iconn') {
        slug = parts[0];
      }
      console.log('[TenantResolver] Subdomain detected, slug:', slug);
    } else if (!host.includes('.iconn.app')) {
      // Normalize custom domain: strip www prefix if present
      customDomain = host.startsWith('www.') ? host.substring(4) : host;
      console.log('[TenantResolver] Custom domain detected:', customDomain, '(original:', host, ')');
    }

    if (!slug && !customDomain) {
      console.log('[TenantResolver] No slug or custom domain found');
      return null;
    }

    let tenant = null;

    if (slug) {
      console.log('[TenantResolver] Looking up by slug:', slug);
      const { data, error } = await supabase
        .from('tenant')
        .select('id, name, slug, domain, status, logo_url, header_logo_url, favicon_url, primary_color, secondary_color, tagline, header_config, footer_config, branding_config, platform_branding, settings')
        .eq('slug', slug)
        .eq('status', 'active')
        .single();

      if (error) {
        console.log('[TenantResolver] Slug lookup error:', error.message);
      }
      if (!error && data) {
        tenant = data;
        console.log('[TenantResolver] Found tenant by slug:', data.slug);
      }
    } else if (customDomain) {
      console.log('[TenantResolver] Looking up by domain:', customDomain);
      const { data, error } = await supabase
        .from('tenant')
        .select('id, name, slug, domain, status, logo_url, header_logo_url, favicon_url, primary_color, secondary_color, tagline, header_config, footer_config, branding_config, platform_branding, settings')
        .eq('domain', customDomain)
        .eq('status', 'active')
        .single();

      if (error) {
        console.log('[TenantResolver] Domain lookup error:', error.message, 'code:', error.code);
      }
      if (!error && data) {
        tenant = data;
        console.log('[TenantResolver] Found tenant by domain:', data.slug);
      } else {
        console.log('[TenantResolver] No tenant found for domain:', customDomain);
      }
    }

    // Only cache successful lookups to avoid caching failures
    if (tenant) {
      tenantCache.set(cacheKey, {
        tenant,
        expiresAt: Date.now() + CACHE_TTL
      });
    }

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
  
  console.log('[TenantResolver] resolveTenantFromRequest called');
  
  if (!supabase) {
    console.error('[TenantResolver] Supabase client not initialized in resolveTenantFromRequest');
    return null;
  }
  
  // Support explicit tenant identifier from query or body for embedded contexts
  const tenantParam = req.query?.tenant || req.body?.tenant || req.query?.slug;
  const domainParam = req.query?.domain;
  
  console.log('[TenantResolver] Params - tenant:', tenantParam, 'domain:', domainParam);
  
  if (tenantParam) {
    console.log('[TenantResolver] Trying tenant param lookup:', tenantParam);
    // Try lookup by slug first
    const { data: bySlug, error: slugError } = await supabase
      .from('tenant')
      .select(TENANT_FIELDS)
      .eq('slug', tenantParam)
      .eq('status', 'active')
      .single();
    
    if (bySlug) {
      console.log('[TenantResolver] Found by slug param:', bySlug.slug);
      return bySlug;
    }
    if (slugError) {
      console.log('[TenantResolver] Slug param lookup error:', slugError.message);
    }
    
    // Fallback: try lookup by domain/subdomain
    const { data: byDomain, error: domainError } = await supabase
      .from('tenant')
      .select(TENANT_FIELDS)
      .eq('domain', tenantParam)
      .eq('status', 'active')
      .single();
    
    if (byDomain) {
      console.log('[TenantResolver] Found by domain param:', byDomain.slug);
      return byDomain;
    }
    if (domainError) {
      console.log('[TenantResolver] Domain param lookup error:', domainError.message);
    }
  }
  
  // Support explicit domain parameter
  if (domainParam) {
    console.log('[TenantResolver] Trying domain param lookup:', domainParam);
    const { data: byDomain, error } = await supabase
      .from('tenant')
      .select(TENANT_FIELDS)
      .eq('domain', domainParam)
      .eq('status', 'active')
      .single();
    
    if (byDomain) {
      console.log('[TenantResolver] Found by domain param:', byDomain.slug);
      return byDomain;
    }
    if (error) {
      console.log('[TenantResolver] Domain param lookup error:', error.message);
    }
  }
  
  // Fall back to host-based resolution
  const hostname = getHostFromRequest(req);
  console.log('[TenantResolver] Falling back to host-based resolution, hostname:', hostname);
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
