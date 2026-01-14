import { supabase } from '../../../_lib/database.js';

// Extract tenant slug from subdomain (e.g., gsf.iconn.app -> 'gsf')
function getTenantSlugFromHost(host) {
  if (!host) return null;
  const hostname = host.split(':')[0];
  const parts = hostname.split('.');
  if (parts.length >= 2) {
    const potentialSlug = parts[0];
    if (!['www', 'api', 'localhost', '127'].includes(potentialSlug)) {
      return potentialSlug;
    }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { slug } = req.query;
  if (!slug) {
    return res.status(400).json({ error: 'Booking slug required' });
  }

  try {
    // Extract tenant from subdomain (this is what the booking page uses)
    const host = req.headers.host || req.headers['x-forwarded-host'];
    const subdomainSlug = getTenantSlugFromHost(host);
    
    // Find tenant by subdomain
    let subdomainTenant = null;
    if (subdomainSlug) {
      const { data: t } = await supabase
        .from('tenant')
        .select('id, name, slug')
        .eq('slug', subdomainSlug)
        .single();
      subdomainTenant = t;
    }

    // Step 1: Find identity
    const { data: identity, error: identityError } = await supabase
      .from('tenant_identity')
      .select('id, first_name, last_name, email, booking_slug')
      .eq('booking_slug', slug)
      .single();

    if (identityError || !identity) {
      return res.json({ 
        step: 'identity',
        error: 'Identity not found',
        identityError,
        slug,
        host,
        subdomainSlug,
        subdomainTenant
      });
    }

    // Step 2: Find ALL profiles and enrich with tenant info
    const { data: allProfiles, error: profilesError } = await supabase
      .from('agent_availability_profile')
      .select('*')
      .eq('identity_id', identity.id);
    
    // Add tenant name to each profile
    const profilesWithTenant = [];
    for (const p of (allProfiles || [])) {
      const { data: t } = await supabase.from('tenant').select('name, slug').eq('id', p.tenant_id).single();
      profilesWithTenant.push({ 
        ...p, 
        tenantName: t?.name, 
        tenantSlug: t?.slug 
      });
    }

    // Step 3: Find profile for the subdomain tenant specifically
    let subdomainProfile = null;
    let subdomainProfileError = null;
    
    if (subdomainTenant) {
      const { data: p, error: e } = await supabase
        .from('agent_availability_profile')
        .select('*')
        .eq('identity_id', identity.id)
        .eq('tenant_id', subdomainTenant.id)
        .eq('is_active', true)
        .single();
      subdomainProfile = p;
      subdomainProfileError = e;
    }

    return res.json({
      success: true,
      host,
      subdomainSlug,
      subdomainTenant,
      identity: {
        id: identity.id,
        name: `${identity.first_name || ''} ${identity.last_name || ''}`.trim(),
        email: identity.email,
        booking_slug: identity.booking_slug
      },
      allProfiles: profilesWithTenant,
      subdomainProfile,
      subdomainProfileError,
      diagnosis: !subdomainTenant 
        ? 'Could not determine tenant from subdomain'
        : !subdomainProfile
          ? `No availability profile found for tenant "${subdomainTenant.name}". You need to log into ${subdomainSlug}.iconn.app and save your availability settings there.`
          : 'Profile found - booking should work!'
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
