import { createClient } from '@supabase/supabase-js';

function getTenantSlugFromHost(host) {
  if (!host) return null;
  const hostname = host.split(':')[0];
  const parts = hostname.split('.');
  if (parts.length >= 2) {
    return parts[0];
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const tenantSlug = req.query.tenant || getTenantSlugFromHost(host);

    if (!tenantSlug) {
      return res.status(400).json({ error: 'Tenant not specified' });
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

    const { data: rawEvents, error } = await supabase
      .from('event')
      .select(`
        id,
        title,
        description,
        start_date,
        end_date,
        timezone,
        location,
        location_type,
        image_url,
        pricing_config,
        is_archived,
        registration_open
      `)
      .eq('tenant_id', tenant.id)
      .eq('is_archived', false)
      .order('start_date', { ascending: true });

    const events = (rawEvents || []).map(event => {
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
          currency: tc.currency
        }));

      return {
        id: event.id,
        title: event.title,
        description: event.description,
        start_date: event.start_date,
        end_date: event.end_date,
        timezone: event.timezone,
        location: event.location,
        location_type: event.location_type,
        image_url: event.image_url,
        registration_open: event.registration_open,
        pricing_config: publicTicketClasses.length > 0 ? { ticket_classes: publicTicketClasses } : null
      };
    });

    if (error) {
      console.error('[Public Events] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch events' });
    }

    res.json(events || []);
  } catch (error) {
    console.error('[Public Events] Error:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
}
