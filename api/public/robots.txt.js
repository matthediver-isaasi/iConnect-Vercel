import { supabase } from '../_lib/database.js';

async function resolveTenant(hostname, supabaseClient) {
  if (!hostname) return null;
  
  // Remove port if present
  const cleanHostname = hostname.split(':')[0];
  
  // Handle tenant subdomains like tenant.iconn.app
  if (cleanHostname.endsWith('.iconn.app')) {
    const slug = cleanHostname.replace('.iconn.app', '');
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
    
    // First check for explicit tenant query param
    let tenant = null;
    if (req.query.tenant) {
      const { data } = await supabase
        .from('tenant')
        .select('id, slug, settings')
        .eq('slug', req.query.tenant)
        .eq('status', 'active')
        .single();
      tenant = data;
    } else {
      // Resolve tenant from host using same logic as tenant-branding
      tenant = await resolveTenant(host, supabase);
    }

    if (!tenant) {
      // No tenant identified - block indexing by default
      return res.status(200).send('User-agent: *\nDisallow: /');
    }

    const allowSearchIndexing = tenant.settings?.allow_search_indexing === true;

    if (allowSearchIndexing) {
      // Allow indexing with common admin path restrictions
      return res.status(200).send(`User-agent: *
Allow: /

# Disallow admin/private areas
Disallow: /admin/
Disallow: /api/
Disallow: /RoleManagement
Disallow: /AdminSetup
Disallow: /FormSubmissions
Disallow: /DataExport`);
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
