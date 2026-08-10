import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';


export default async function handler(req, res) {
  console.log('[Public Complex Event] v3 handler invoked');
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

    const { id, slug } = req.query;

    if (!id && !slug) {
      return res.status(400).json({ error: 'id or slug is required' });
    }

    let query = supabase
      .from('complex_event')
      .select('id, title, slug, description, summary, image_url, image_focal_point, start_date, end_date, location, status, timezone, available_seats, event_state, event_type, filter_tags, program_tag, member_group_id, registration_closes_at, is_unlimited_registration, show_seat_count, show_ticket_availability, pricing_config, cta_override_url, cta_override_mode, cta_button_label, replace_booking_elements, booking_replacement_message, booking_replacement_cta_label, booking_replacement_title, attached_documents, documents_section_title, custom_duration_explainer')
      .eq('tenant_id', tenant.id)
      .in('status', ['published', 'tbc', 'draft']);

    if (id) {
      query = query.eq('id', id);
    } else {
      query = query.eq('slug', slug);
    }

    const { data: event, error } = await query.single();

    if (error || !event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Task #3508: include the linked member group's name so the UI can render
    // a "join <group> to book" dialogue for non-members.
    let memberGroupName = null;
    if (event.member_group_id) {
      const { data: groupRow } = await supabase
        .from('member_group')
        .select('id, name')
        .eq('id', event.member_group_id)
        .maybeSingle();
      memberGroupName = groupRow?.name || null;
    }

    const { data: ticketClasses, error: tcError } = await supabase
      .from('complex_event_ticket_class')
      .select('id, name, price, is_free, early_bird_enabled, early_bird_price, early_bird_deadline, visibility_mode, linked_track_ids, all_tracks, display_order, is_group_ticket, group_size, role_ids, role_match_only, member_group_ids, available_count, is_unlimited_tickets')
      .eq('complex_event_id', event.id)
      .eq('tenant_id', tenant.id)
      .order('display_order', { ascending: true });

    if (tcError) {
      console.error('[Public Complex Event] ticket class query error:', tcError.message);
    }

    // Count-based ticket availability (Task #1760): available_count is a fixed
    // maximum; live availability is derived from the number of confirmed
    // complex_event_booking rows per finite ticket class.
    const soldCounts = {};
    const finiteTicketClassIds = (ticketClasses || [])
      .filter(tc => !tc.is_unlimited_tickets && tc.available_count !== null && tc.available_count !== undefined)
      .map(tc => String(tc.id));
    if (finiteTicketClassIds.length > 0) {
      await Promise.all(finiteTicketClassIds.map(async (tcId) => {
        const { count, error: countError } = await supabase
          .from('complex_event_booking')
          .select('id', { count: 'exact', head: true })
          .eq('event_id', event.id)
          .eq('ticket_class_id', tcId)
          .eq('status', 'confirmed');
        if (countError) {
          console.error('[Public Complex Event] sold-count query error for', tcId, countError.message);
          return;
        }
        soldCounts[tcId] = count || 0;
      }));
    }

    const { data: tracks } = await supabase
      .from('complex_event_track')
      .select('id, name, description, colour, display_order')
      .eq('complex_event_id', event.id)
      .eq('tenant_id', tenant.id)
      .order('display_order', { ascending: true });

    const publicTicketClasses = (ticketClasses || [])
      .map(tc => {
        const isUnlimited = tc.is_unlimited_tickets === true ||
          tc.available_count === null || tc.available_count === undefined;
        const max = isUnlimited ? null : (Number(tc.available_count) || 0);
        const soldCount = soldCounts[String(tc.id)] || 0;
        const remaining = isUnlimited ? null : Math.max(0, max - soldCount);
        return {
          id: tc.id,
          name: tc.name,
          price: Number(tc.price) || 0,
          currency: 'gbp',
          is_free: tc.is_free,
          visibility_mode: tc.visibility_mode,
          early_bird_enabled: tc.early_bird_enabled || false,
          early_bird_price: tc.early_bird_price != null ? Number(tc.early_bird_price) : null,
          early_bird_deadline: tc.early_bird_deadline || null,
          linked_track_ids: tc.linked_track_ids || [],
          all_tracks: tc.all_tracks,
          display_order: tc.display_order,
          is_group_ticket: tc.is_group_ticket || false,
          group_size: tc.group_size || null,
          role_ids: tc.role_ids || [],
          role_match_only: tc.role_match_only || false,
          member_group_ids: Array.isArray(tc.member_group_ids) ? tc.member_group_ids : [],
          // Count-based availability (Task #1760)
          available_count: max,
          is_unlimited_tickets: isUnlimited,
          sold_count: soldCount,
          remaining,
          is_sold_out: !isUnlimited && remaining <= 0
        };
      });

    res.json({
      id: event.id,
      title: event.title,
      slug: event.slug || null,
      description: event.description,
      summary: event.summary,
      start_date: event.start_date,
      end_date: event.end_date,
      location: event.location,
      image_url: event.image_url,
      image_focal_point: event.image_focal_point || null,
      status: event.status,
      available_seats: event.available_seats,
      timezone: event.timezone,
      event_type: event.event_type || null,
      filter_tags: event.filter_tags || [],
      program_tag: event.program_tag || null,
      member_group_id: event.member_group_id || null,
      member_group_name: memberGroupName,
      registration_closes_at: event.registration_closes_at || null,
      is_unlimited_registration: event.is_unlimited_registration !== false,
      show_seat_count: event.show_seat_count !== false,
      show_ticket_availability: event.show_ticket_availability === true,
      collect_third_party_consent: event.pricing_config?.collectThirdPartyConsent === true,
      is_complex: true,
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
      custom_duration_explainer: event.custom_duration_explainer || null,
      tracks: tracks || [],
      pricing_config: {
        ...(publicTicketClasses.length > 0 ? { ticket_classes: publicTicketClasses } : {}),
        collectThirdPartyConsent: event.pricing_config?.collectThirdPartyConsent === true
      }
    });
  } catch (error) {
    console.error('[Public Complex Event] Error:', error);
    res.status(500).json({ error: 'Failed to fetch complex event' });
  }
}
