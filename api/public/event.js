import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[Public Event] Missing Supabase credentials');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const eventId = req.query.id;
    const eventSlug = req.query.slug;

    if (!eventId && !eventSlug) {
      return res.status(400).json({ error: 'Event ID or slug not specified' });
    }

    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    let query = supabase
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
        speaker_ids,
        status,
        summary,
        event_type,
        is_online,
        available_seats,
        show_seat_count,
        timezone,
        donation_config,
        event_state,
        program_tag,
        registration_closes_at,
        slug,
        seo_title,
        seo_description
      `)
      .eq('tenant_id', tenant.id)
      .in('status', ['published', 'tbc']);

    if (eventSlug) {
      query = query.eq('slug', eventSlug.toLowerCase().trim());
    } else {
      query = query.eq('id', eventId);
    }

    const { data: event, error } = await query.single();

    if (error || !event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const allowGuestsToViewAllTickets = event.pricing_config?.allowGuestsToViewAllTickets || false;

    const publicTicketClasses = (event.pricing_config?.ticket_classes || [])
      .filter(tc => {
        if (allowGuestsToViewAllTickets) return true;
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
        is_group_ticket: tc.is_group_ticket || false,
        group_size: tc.group_size || null,
        group_cutoff_date: tc.group_cutoff_date || null,
        early_bird_enabled: tc.early_bird_enabled || false,
        early_bird_price: tc.early_bird_price != null ? tc.early_bird_price : null,
        early_bird_deadline: tc.early_bird_deadline || null,
        offer_type: tc.offer_type || 'none',
        bogo_logic_type: tc.bogo_logic_type || 'buy_x_get_y_free',
        bogo_buy_quantity: tc.bogo_buy_quantity || 0,
        bogo_get_free_quantity: tc.bogo_get_free_quantity || 0,
        bulk_discount_threshold: tc.bulk_discount_threshold || 0,
        bulk_discount_percentage: tc.bulk_discount_percentage || 0,
        available_count: tc.available_count,
        is_unlimited_tickets: tc.is_unlimited_tickets,
        role_match_only: tc.role_match_only || false,
        role_ids: tc.role_ids || [],
        is_default: tc.is_default || false
      }));

    const publicEvent = {
      id: event.id,
      title: event.title,
      description: event.description,
      start_date: event.start_date,
      end_date: event.end_date,
      location: event.location,
      image_url: event.image_url,
      image_focal_point: event.image_focal_point,
      speaker_ids: event.speaker_ids,
      status: event.status,
      summary: event.summary,
      event_type: event.event_type,
      is_online: event.is_online,
      available_seats: event.available_seats,
      show_seat_count: event.show_seat_count,
      timezone: event.timezone,
      pricing_config: event.pricing_config ? {
        ticket_classes: publicTicketClasses,
        allowGuestsToViewAllTickets: allowGuestsToViewAllTickets,
        ticket_price: event.pricing_config.ticket_price,
        offer_type: event.pricing_config.offer_type
      } : null,
      donation_config: event.donation_config || null,
      event_state: event.event_state,
      program_tag: event.program_tag,
      registration_closes_at: event.registration_closes_at,
      slug: event.slug || null,
      seo_title: event.seo_title || null,
      seo_description: event.seo_description || null
    };

    return res.status(200).json(publicEvent);
  } catch (error) {
    console.error('[Public Event] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
