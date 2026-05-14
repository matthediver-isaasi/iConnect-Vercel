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
        slug,
        description,
        summary,
        start_date,
        end_date,
        location,
        image_url,
        image_focal_point,
        pricing_config,
        status,
        available_seats,
        show_seat_count,
        event_type,
        is_online,
        timezone,
        program_tag,
        event_state,
        registration_closes_at,
        is_featured,
        cta_override_url,
        cta_override_mode
      `)
      .eq('tenant_id', tenant.id)
      .in('status', ['published', 'tbc'])
      .order('start_date', { ascending: true });

    const events = (rawEvents || []).map(event => {
      const allTicketClasses = event.pricing_config?.ticket_classes || [];
      const allPrices = allTicketClasses
        .map(tc => {
          if (tc.price === undefined || tc.price === null || tc.price === '') return NaN;
          return Number(tc.price);
        })
        .filter(p => Number.isFinite(p));
      let cheapestPrice = allPrices.length > 0 ? Math.min(...allPrices) : null;
      if (cheapestPrice === null) {
        const legacy = event.pricing_config?.ticket_price;
        if (legacy !== undefined && legacy !== null && legacy !== '') {
          const n = Number(legacy);
          if (Number.isFinite(n)) cheapestPrice = n;
        }
      }
      const publicTicketClasses = allTicketClasses
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
          is_public: tc.is_public,
          early_bird_enabled: tc.early_bird_enabled || false,
          early_bird_price: tc.early_bird_price != null ? tc.early_bird_price : null,
          early_bird_deadline: tc.early_bird_deadline || null
        }));

      return {
        id: event.id,
        title: event.title,
        slug: event.slug || null,
        description: event.description,
        summary: event.summary,
        start_date: event.start_date,
        end_date: event.end_date,
        location: event.location,
        image_url: event.image_url,
        image_focal_point: event.image_focal_point,
        status: event.status,
        available_seats: event.available_seats,
        event_type: event.event_type,
        is_online: event.is_online,
        timezone: event.timezone,
        show_seat_count: event.show_seat_count,
        program_tag: event.program_tag,
        event_state: event.event_state,
        registration_closes_at: event.registration_closes_at,
        is_featured: event.is_featured || false,
        cheapest_price: cheapestPrice,
        pricing_config: publicTicketClasses.length > 0 ? { ticket_classes: publicTicketClasses } : null,
        cta_override_url: event.cta_override_url || null,
        cta_override_mode: event.cta_override_mode || 'card'
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
