import { supabase } from '../../../_lib/database.js';

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
        slug 
      });
    }

    // Step 2: Find ALL memberships (not just active) to understand the situation
    const { data: memberships, error: membershipError } = await supabase
      .from('tenant_membership')
      .select('tenant_id, status')
      .eq('identity_id', identity.id);
    
    // Also get tenant names for each membership
    const membershipDetails = [];
    for (const m of (memberships || [])) {
      const { data: t } = await supabase.from('tenant').select('name, slug').eq('id', m.tenant_id).single();
      membershipDetails.push({ ...m, tenantName: t?.name, tenantSlug: t?.slug });
    }

    if (!memberships || memberships.length === 0) {
      return res.json({ 
        step: 'membership',
        error: 'No memberships found',
        identity,
        membershipError
      });
    }

    const activeMembership = memberships.find(m => m.status === 'active');
    if (!activeMembership) {
      return res.json({
        step: 'active_membership',
        error: 'No active membership',
        allMemberships: memberships,
        identity
      });
    }

    const tenantId = activeMembership.tenant_id;
    
    // Also check the tenant table to verify tenant exists
    const { data: tenant, error: tenantError } = await supabase
      .from('tenant')
      .select('id, name, slug')
      .eq('id', tenantId)
      .single();

    // Step 3: Find availability profile
    const { data: allProfiles, error: profilesError } = await supabase
      .from('agent_availability_profile')
      .select('*')
      .eq('identity_id', identity.id);

    const { data: activeProfile, error: activeProfileError } = await supabase
      .from('agent_availability_profile')
      .select('*')
      .eq('identity_id', identity.id)
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .single();

    return res.json({
      success: true,
      identity: {
        id: identity.id,
        name: `${identity.first_name || ''} ${identity.last_name || ''}`.trim(),
        email: identity.email,
        booking_slug: identity.booking_slug
      },
      activeMembership,
      tenantId,
      tenant: tenant || null,
      tenantError,
      allMemberships: membershipDetails,
      allProfiles: allProfiles || [],
      activeProfile: activeProfile || null,
      activeProfileError,
      profilesError
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
