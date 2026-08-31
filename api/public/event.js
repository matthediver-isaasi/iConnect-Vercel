import { createClient } from '@supabase/supabase-js';
import { getEventCommercialCapacity, mergeTicketCommercialCapacity } from '../_lib/eventCommercialCapacity.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import {
  PUBLIC_SIMPLE_EVENT_DETAIL_STATUSES,
  suppressImmediateSchedule,
} from '../../shared/eventTiming.js';

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
        seo_description,
        og_image_url,
        is_complex,
        is_training,
        cta_override_url,
        cta_override_mode,
        cta_button_label,
        replace_booking_elements,
        booking_replacement_message,
        booking_replacement_cta_label,
        booking_replacement_title,
        attached_documents,
        documents_section_title,
        member_group_id,
        group_event_public
      `)
      .eq('tenant_id', tenant.id)
      .in('status', PUBLIC_SIMPLE_EVENT_DETAIL_STATUSES);
      // Task #3508: group events ARE returned by the single-event lookup so
      // anyone with a direct link can view them; booking is gated separately
      // (server-side membership check in the booking paths). List endpoints
      // still hide private group events.

    if (eventSlug) {
      query = query.eq('slug', eventSlug.toLowerCase().trim());
    } else {
      query = query.eq('id', eventId);
    }

    const { data: rawEvent, error } = await query.single();

    if (error || !rawEvent) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Task #3508: include the linked member group's name so the UI can render
    // a "join <group> to book" dialogue for non-members.
    let memberGroupName = null;
    if (rawEvent.member_group_id) {
      const { data: groupRow } = await supabase
        .from('member_group')
        .select('id, name')
        .eq('id', rawEvent.member_group_id)
        .maybeSingle();
      memberGroupName = groupRow?.name || null;
    }

    // Immediate events: suppress schedule fields defensively before building payload
    const event = suppressImmediateSchedule(rawEvent);

    const allowGuestsToViewAllTickets = event.pricing_config?.allowGuestsToViewAllTickets || false;

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

    const publicTicketClassesBase = allTicketClasses
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
        member_group_ids: Array.isArray(tc.member_group_ids) ? tc.member_group_ids : [],
        is_default: tc.is_default || false
      }));

    // Count-based availability (Task #1758): treat available_count as a fixed
    // maximum and derive availability from the actual number of confirmed
    // bookings per ticket class. We only count finite (non-unlimited) classes —
    // unlimited tickets are never sold out.
    const isUnlimitedTicket = (tc) => {
      const ac = tc.available_count;
      return tc.is_unlimited_tickets === true || ac === null || ac === undefined || ac === '';
    };

    const finiteTicketIds = publicTicketClassesBase
      .filter(tc => !isUnlimitedTicket(tc))
      .map(tc => String(tc.id))
      .filter(id => id && id !== 'undefined' && id !== 'null');

    const soldCounts = {};
    await Promise.all(finiteTicketIds.map(async (tcId) => {
      const { count, error: countError } = await supabase
        .from('booking')
        .select('id', { count: 'exact', head: true })
        .eq('event_id', event.id)
        .eq('ticket_class_id', tcId)
        .eq('status', 'confirmed');
      if (countError) {
        console.error('[Public Event] Failed to count confirmed bookings for ticket class', tcId, countError.message);
      }
      soldCounts[tcId] = count || 0;
    }));

    const commercialCapacity = await getEventCommercialCapacity(supabase, tenant.id, 'simple', event.id);
    const publicTicketClasses = publicTicketClassesBase.map(tc => {
      if (isUnlimitedTicket(tc)) {
        return {
          ...tc,
          sold_count: 0,
          ...mergeTicketCommercialCapacity(tc, 0, commercialCapacity.get(String(tc.id)), false),
          is_sold_out: false,
        };
      }
      const soldCount = soldCounts[String(tc.id)] || 0;
      return {
        ...tc,
        sold_count: soldCount,
        ...mergeTicketCommercialCapacity(tc, soldCount, commercialCapacity.get(String(tc.id)), false),
      };
    });

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
        collectThirdPartyConsent: event.pricing_config?.collectThirdPartyConsent === true,
        ticket_price: event.pricing_config.ticket_price,
        offer_type: event.pricing_config.offer_type
      } : null,
      donation_config: event.donation_config || null,
      event_state: event.event_state,
      program_tag: event.program_tag,
      registration_closes_at: event.registration_closes_at,
      slug: event.slug || null,
      seo_title: event.seo_title || null,
      seo_description: event.seo_description || null,
      og_image_url: event.og_image_url || null,
      is_complex: event.is_complex || false,
      is_training: event.is_training || false,
      cheapest_price: cheapestPrice,
      cta_override_url: event.cta_override_url || null,
      cta_override_mode: event.cta_override_mode || 'card',
      cta_button_label: event.cta_button_label || null,
      // TBC booking-element replacement (only meaningful when status === 'tbc')
      replace_booking_elements: event.replace_booking_elements === true,
      booking_replacement_message: event.booking_replacement_message || null,
      booking_replacement_cta_label: event.booking_replacement_cta_label || null,
      booking_replacement_title: event.booking_replacement_title || null,
      attached_documents: Array.isArray(event.attached_documents) ? event.attached_documents : [],
      documents_section_title: event.documents_section_title || null,
      member_group_id: event.member_group_id || null,
      group_event_public: event.group_event_public === true,
      member_group_name: memberGroupName
    };

    return res.status(200).json(publicEvent);
  } catch (error) {
    console.error('[Public Event] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
