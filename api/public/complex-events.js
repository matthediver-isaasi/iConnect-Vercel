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
        is_complex,
        speaker_ids
      `)
      .eq('tenant_id', tenant.id)
      .eq('is_complex', true)
      .in('status', ['published', 'tbc'])
      .order('start_date', { ascending: true });

    if (error) {
      console.error('[Public Complex Events] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch complex events' });
    }

    const events = (rawEvents || []).map(event => {
      const publicTicketClasses = (event.pricing_config?.ticket_classes || [])
        .filter(tc => {
          const vis = tc.visibility_mode || (tc.is_public ? 'members_and_public' : 'members_only');
          return vis === 'members_and_public' || vis === 'public_only';
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
          early_bird_deadline: tc.early_bird_deadline || null,
          track_access: tc.track_access || []
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
        is_complex: true,
        speaker_ids: event.speaker_ids || [],
        pricing_config: publicTicketClasses.length > 0 ? { ticket_classes: publicTicketClasses } : null
      };
    });

    res.json(events);
  } catch (error) {
    console.error('[Public Complex Events] Error:', error);
    res.status(500).json({ error: 'Failed to fetch complex events' });
  }
}
