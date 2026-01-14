import { supabase } from '../../_lib/database.js';

// Extract tenant slug from subdomain (e.g., gsf.iconn.app -> 'gsf')
function getTenantSlugFromHost(host) {
  if (!host) return null;
  // Remove port if present
  const hostname = host.split(':')[0];
  // Check for subdomain pattern: {tenant}.iconn.app or {tenant}.{domain}
  const parts = hostname.split('.');
  if (parts.length >= 2) {
    // First part is the tenant slug (e.g., 'gsf' from 'gsf.iconn.app')
    const potentialSlug = parts[0];
    // Exclude common non-tenant prefixes
    if (!['www', 'api', 'localhost', '127'].includes(potentialSlug)) {
      return potentialSlug;
    }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { slug } = req.query;
  if (!slug) {
    return res.status(400).json({ error: 'Booking slug required' });
  }

  try {
    // Extract tenant from subdomain
    const host = req.headers.host || req.headers['x-forwarded-host'];
    const tenantSlug = getTenantSlugFromHost(host);
    
    console.log('[Booking] Host:', host, 'Tenant slug:', tenantSlug);

    // Find tenant by subdomain
    let tenantId = null;
    let tenant = null;
    
    if (tenantSlug) {
      const { data: tenantData } = await supabase
        .from('tenant')
        .select('id, name, slug, logo_url, primary_color')
        .eq('slug', tenantSlug)
        .single();
      
      if (tenantData) {
        tenantId = tenantData.id;
        tenant = tenantData;
      }
    }

    if (!tenantId) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Find identity by booking slug
    const { data: identity, error: identityError } = await supabase
      .from('tenant_identity')
      .select('id, first_name, last_name, email, avatar_url, booking_slug')
      .eq('booking_slug', slug)
      .single();

    if (identityError || !identity) {
      return res.status(404).json({ error: 'Booking page not found' });
    }

    // Find availability profile for this identity AND this specific tenant
    const { data: profile, error: profileError } = await supabase
      .from('agent_availability_profile')
      .select('*')
      .eq('identity_id', identity.id)
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'Booking page not active for this organization' });
    }

    if (req.method === 'GET') {
      return res.json({
        agent: {
          name: `${identity.first_name || ''} ${identity.last_name || ''}`.trim() || identity.email,
          avatar: identity.avatar_url
        },
        profile: {
          timezone: profile.timezone,
          slotMinutes: profile.default_slot_minutes,
          bufferMinutes: profile.buffer_minutes,
          workingHours: profile.working_hours,
          title: profile.booking_title,
          description: profile.booking_description
        },
        tenant: tenant ? {
          name: tenant.name,
          logo: tenant.logo_url,
          color: tenant.primary_color
        } : null
      });
    }

    if (req.method === 'POST') {
      const {
        attendee_name,
        attendee_email,
        attendee_phone,
        attendee_timezone,
        attendee_notes,
        starts_at,
        duration_minutes
      } = req.body;

      if (!attendee_name || !attendee_email || !starts_at) {
        return res.status(400).json({ error: 'Name, email, and time slot are required' });
      }

      const startTime = new Date(starts_at);
      const duration = duration_minutes || profile.default_slot_minutes;
      const endTime = new Date(startTime.getTime() + duration * 60 * 1000);

      const { data: conflicts } = await supabase
        .from('agent_booking')
        .select('id')
        .eq('identity_id', identity.id)
        .eq('tenant_id', tenantId)
        .neq('status', 'cancelled')
        .or(`and(starts_at.lt.${endTime.toISOString()},ends_at.gt.${startTime.toISOString()})`);

      if (conflicts && conflicts.length > 0) {
        return res.status(409).json({ error: 'This time slot is no longer available' });
      }

      const { data: memberMatch } = await supabase
        .from('member')
        .select('id')
        .eq('tenant_id', tenantId)
        .ilike('email', attendee_email)
        .limit(1);

      const { data: booking, error: bookingError } = await supabase
        .from('agent_booking')
        .insert({
          tenant_id: tenantId,
          identity_id: identity.id,
          attendee_name,
          attendee_email: attendee_email.toLowerCase(),
          attendee_phone,
          attendee_timezone: attendee_timezone || profile.timezone,
          attendee_notes,
          title: `Meeting with ${attendee_name}`,
          starts_at: startTime.toISOString(),
          ends_at: endTime.toISOString(),
          duration_minutes: duration,
          status: 'confirmed',
          member_id: memberMatch?.[0]?.id || null
        })
        .select()
        .single();

      if (bookingError) {
        console.error('[Public Booking] Create error:', bookingError);
        return res.status(500).json({ error: 'Failed to create booking' });
      }

      return res.status(201).json({
        success: true,
        booking: {
          id: booking.id,
          starts_at: booking.starts_at,
          ends_at: booking.ends_at,
          status: booking.status
        },
        agent: {
          name: `${identity.first_name || ''} ${identity.last_name || ''}`.trim(),
          email: identity.email
        }
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Public Booking] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
