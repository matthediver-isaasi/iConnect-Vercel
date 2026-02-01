import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

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
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
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
        location,
        image_url,
        image_focal_point,
        pricing_config,
        status,
        available_seats
      `)
      .eq('tenant_id', tenant.id)
      .eq('status', 'published')
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
          currency: tc.currency,
          visibility_mode: tc.visibility_mode,
          is_public: tc.is_public
        }));

      return {
        id: event.id,
        title: event.title,
        description: event.description,
        start_date: event.start_date,
        end_date: event.end_date,
        location: event.location,
        image_url: event.image_url,
        image_focal_point: event.image_focal_point,
        status: event.status,
        available_seats: event.available_seats,
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
