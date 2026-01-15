import { createClient } from '@supabase/supabase-js';

function getTenantSlugFromHost(host) {
  if (!host) return null;
  
  const parts = host.split('.');
  if (parts.length >= 2) {
    const subdomain = parts[0];
    if (subdomain && subdomain !== 'www' && subdomain !== 'iconn' && subdomain !== 'localhost') {
      return subdomain;
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.DEV_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[Public Event] Missing Supabase credentials');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const tenantSlug = req.query.tenant || getTenantSlugFromHost(host);
    const eventId = req.query.id;

    if (!tenantSlug) {
      return res.status(400).json({ error: 'Tenant not specified' });
    }

    if (!eventId) {
      return res.status(400).json({ error: 'Event ID not specified' });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from('tenant')
      .select('id, name')
      .eq('slug', tenantSlug)
      .eq('status', 'active')
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: event, error } = await supabase
      .from('event')
      .select(`
        id,
        title,
        slug,
        description,
        start_date,
        end_date,
        timezone,
        location,
        location_type,
        image_url,
        pricing_config,
        speaker_ids,
        is_archived,
        registration_open
      `)
      .eq('id', eventId)
      .eq('tenant_id', tenant.id)
      .eq('is_archived', false)
      .single();

    if (error || !event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const publicTicketClasses = (event.pricing_config?.ticket_classes || [])
      .filter(tc => {
        if (tc.visibility_mode) {
          return tc.visibility_mode === 'members_and_public' || tc.visibility_mode === 'public_only';
        }
        return tc.is_public === true;
      })
      .map(tc => ({
        id: tc.id,
        name: tc.name,
        description: tc.description,
        price: tc.price,
        currency: tc.currency,
        visibility_mode: tc.visibility_mode,
        is_public: tc.is_public
      }));

    const publicEvent = {
      id: event.id,
      title: event.title,
      slug: event.slug,
      description: event.description,
      start_date: event.start_date,
      end_date: event.end_date,
      timezone: event.timezone,
      location: event.location,
      location_type: event.location_type,
      image_url: event.image_url,
      speaker_ids: event.speaker_ids,
      registration_open: event.registration_open,
      pricing_config: publicTicketClasses.length > 0 ? { ticket_classes: publicTicketClasses } : null
    };

    return res.status(200).json(publicEvent);
  } catch (error) {
    console.error('[Public Event] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
