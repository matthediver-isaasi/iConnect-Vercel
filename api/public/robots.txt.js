import { supabase } from '../_lib/database.js';
import { evaluateTenantOverride, getIconnHostSlug } from '../_lib/tenantHostGuard.js';

async function resolveTenant(hostname, supabaseClient) {
  if (!hostname) return null;
  
  // Remove port if present
  const cleanHostname = hostname.split(':')[0];
  
  // Handle tenant subdomains like tenant.iconn.app and tenant.dev.iconn.app
  if (cleanHostname.endsWith('.iconn.app')) {
    const slug = getIconnHostSlug(cleanHostname);
    if (!slug) return null;
    const { data: tenant } = await supabaseClient
      .from('tenant')
      .select('id, slug, settings')
      .eq('slug', slug)
      .eq('status', 'active')
      .single();
    return tenant;
  }
  
  // Handle custom domains - look up by domain field
  const { data: tenantByDomain } = await supabaseClient
    .from('tenant')
    .select('id, slug, settings')
    .eq('domain', cleanHostname)
    .eq('status', 'active')
    .single();
  
  if (tenantByDomain) {
    return tenantByDomain;
  }
  
  // Try without www prefix
  if (cleanHostname.startsWith('www.')) {
    const domainWithoutWww = cleanHostname.replace('www.', '');
    const { data: tenant } = await supabaseClient
      .from('tenant')
      .select('id, slug, settings')
      .eq('domain', domainWithoutWww)
      .eq('status', 'active')
      .single();
    return tenant;
  }
  
  return null;
}

/**
 * Endpoint-level tenant selection for robots.txt (exported for tests).
 * Task #3390: on wildcard {slug}.iconn.app / {slug}.{env}.iconn.app hosts
 * the host slug is authoritative — a mismatched ?tenant= override is
 * ignored and the tenant resolves from the host instead.
 * @param {string} host - raw Host / X-Forwarded-Host value
 * @param {string|undefined} tenantParam - ?tenant= query value
 * @param {object} supabaseClient
 */
export async function resolveRobotsTenant(host, tenantParam, supabaseClient) {
  const { hostSlug, allowOverride } = evaluateTenantOverride(host, tenantParam);
  if (tenantParam && (!hostSlug || allowOverride)) {
    const { data } = await supabaseClient
      .from('tenant')
      .select('id, slug, settings')
      .eq('slug', tenantParam)
      .eq('status', 'active')
      .single();
    return data || null;
  }
  // Resolve tenant from host using same logic as tenant-branding
  return resolveTenant(host, supabaseClient);
}

export default async function handler(req, res) {
  // Set content type to plain text for robots.txt
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Cache-Control', 'public, max-age=300'); // Cache for 5 minutes (shorter for faster setting changes)

  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  if (!supabase) {
    // Default to blocking if database not configured
    return res.status(200).send('User-agent: *\nDisallow: /');
  }

  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const cleanHost = host.split(':')[0];

    // Task #3390: host slug wins over a mismatched ?tenant= override on
    // wildcard iconn.app hosts (see resolveRobotsTenant).
    const tenant = await resolveRobotsTenant(host, req.query.tenant, supabase);

    if (!tenant) {
      // No tenant identified - block indexing by default
      return res.status(200).send('User-agent: *\nDisallow: /');
    }

    if (cleanHost.endsWith('.dev.iconn.app')) {
      return res.status(200).send('User-agent: *\nDisallow: /');
    }

    const allowSearchIndexing = tenant.settings?.allow_search_indexing === true;

    if (allowSearchIndexing) {
      const protocol = 'https';
      const sitemapHost = cleanHost || host.split(':')[0];
      const sitemapUrl = `${protocol}://${sitemapHost}/sitemap.xml`;

      return res.status(200).send(`User-agent: *
Allow: /

# Disallow admin/private areas
Disallow: /admin/
Disallow: /api/
Disallow: /RoleManagement
Disallow: /AdminSetup
Disallow: /FormSubmissions
Disallow: /DataExport

Sitemap: ${sitemapUrl}`);
    } else {
      // Block all indexing
      return res.status(200).send('User-agent: *\nDisallow: /');
    }
  } catch (error) {
    console.error('[Robots.txt] Error:', error);
    // On error, default to blocking
    return res.status(200).send('User-agent: *\nDisallow: /');
  }
}
