import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getSessionMember } from '../_lib/session.js';
import { isTicketVisibleToUser } from '../_lib/complexEventPricing.js';

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

    const { id, slug } = req.query;

    if (!id && !slug) {
      return res.status(400).json({ error: 'id or slug is required' });
    }

    let query = supabase
      .from('complex_event')
      .select('id, title, slug, description, summary, image_url, start_date, end_date, location, status, timezone, available_seats')
      .eq('tenant_id', tenant.id)
      .in('status', ['published', 'tbc']);

    if (id) {
      query = query.eq('id', id);
    } else {
      query = query.eq('slug', slug);
    }

    const { data: event, error } = await query.single();

    if (error || !event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const { data: ticketClasses } = await supabase
      .from('complex_event_ticket_class')
      .select('id, name, price, is_free, early_bird_enabled, early_bird_price, early_bird_deadline, visibility_mode, linked_track_ids, all_tracks, display_order, is_group_ticket, group_size, description')
      .eq('complex_event_id', event.id)
      .eq('tenant_id', tenant.id)
      .order('display_order', { ascending: true });

    const { data: tracks } = await supabase
      .from('complex_event_track')
      .select('id, name, description, colour, display_order')
      .eq('complex_event_id', event.id)
      .eq('tenant_id', tenant.id)
      .order('display_order', { ascending: true });

    let isMember = false;
    try {
      const member = await getSessionMember(req);
      if (member?.id) {
        const memberTenantId = member.organization?.tenant_id || member.tenant_id;
        if (memberTenantId && memberTenantId === tenant.id) {
          isMember = true;
        }
      }
    } catch (e) {}

    const publicTicketClasses = (ticketClasses || [])
      .filter(tc => isTicketVisibleToUser(tc, isMember))
      .map(tc => ({
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
        description: tc.description || null
      }));

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
      status: event.status,
      available_seats: event.available_seats,
      timezone: event.timezone,
      is_complex: true,
      tracks: tracks || [],
      pricing_config: publicTicketClasses.length > 0 ? { ticket_classes: publicTicketClasses } : null
    });
  } catch (error) {
    console.error('[Public Complex Event] Error:', error);
    res.status(500).json({ error: 'Failed to fetch complex event' });
  }
}
