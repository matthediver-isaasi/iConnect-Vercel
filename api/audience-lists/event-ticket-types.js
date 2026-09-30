import { getTenantContext } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';

export const NO_TICKET_TYPE_SENTINEL = '__no_ticket_type__';

/**
 * Paginates through a booking table and collects the distinct ticket-type
 * names present on confirmed bookings for the given event.
 *
 * Deduplication is by case-insensitive NAME (not by ticket_class_id), so
 * that every distinct name a ticket class has ever carried appears as its
 * own selectable option — even when several historical names share one id.
 *
 * Returns:
 *   byName – Map<lowercaseName, {id, name}>
 *             id = ticket_class_id when present, otherwise the name itself
 *   hasNoTicketType – true if any confirmed booking has neither id nor name
 */
async function collectBookingTicketTypes(table, eventId, tenantId) {
  const byName = new Map();
  let hasNoTicketType = false;

  let offset = 0;
  const pageSize = 1000;
  let hasMore = true;
  while (hasMore) {
    const { data, error } = await supabase
      .from(table)
      .select('ticket_class_id, ticket_class_name')
      .eq('event_id', eventId)
      .eq('tenant_id', tenantId)
      .eq('status', 'confirmed')
      .range(offset, offset + pageSize - 1);

    if (error || !data || data.length === 0) {
      hasMore = false;
      break;
    }

    for (const row of data) {
      if (!row.ticket_class_id && !row.ticket_class_name) {
        hasNoTicketType = true;
      } else {
        const name = row.ticket_class_name || row.ticket_class_id;
        const key = name.toLowerCase();
        if (!byName.has(key)) {
          byName.set(key, {
            id: row.ticket_class_id || name,
            name,
          });
        }
      }
    }

    offset += data.length;
    hasMore = data.length === pageSize;
  }

  return { byName, hasNoTicketType };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }

  const { tenantId } = tenantContext;
  const { eventId } = req.query;

  if (!eventId) {
    return res.status(400).json({ error: 'eventId is required' });
  }

  try {
    // Fetch actual booking data from BOTH tables regardless of event type —
    // historical data can live in either table.
    const [regResult, complexResult] = await Promise.all([
      collectBookingTicketTypes('booking', eventId, tenantId),
      collectBookingTicketTypes('complex_event_booking', eventId, tenantId),
    ]);

    const hasNoTicketType = regResult.hasNoTicketType || complexResult.hasNoTicketType;

    // Try simple event first: ticket types live in pricing_config.ticket_classes JSONB
    const { data: simpleEvent } = await supabase
      .from('event')
      .select('id, pricing_config')
      .eq('id', eventId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (simpleEvent) {
      // Simple events: deduplicate by case-insensitive name.
      // Configured tiers are the primary source; booking names fill in the gaps
      // (including historical names that no longer match any configured tier).
      const byName = new Map();

      for (const tc of simpleEvent.pricing_config?.ticket_classes || []) {
        if (tc.name) {
          byName.set(tc.name.toLowerCase(), { id: tc.id || tc.name, name: tc.name });
        }
      }

      // Union all booking names from both tables
      for (const src of [regResult, complexResult]) {
        for (const [key, tc] of src.byName) {
          if (!byName.has(key)) byName.set(key, tc);
        }
      }

      const ticketTypes = [...byName.values()];
      if (hasNoTicketType) {
        ticketTypes.push({ id: NO_TICKET_TYPE_SENTINEL, name: 'No ticket type' });
      }
      return res.json({ ticketTypes });
    }

    // Complex event: ticket types are rows in complex_event_ticket_class.
    // Deduplicate by case-insensitive name. Configured tiers are the primary
    // source; historical booking names not covered by any configured tier name
    // are added with their real ticket_class_id preserved, so existing
    // id-based recipient matching in campaignService continues to work.
    const { data: complexTicketClasses, error: complexErr } = await supabase
      .from('complex_event_ticket_class')
      .select('id, name')
      .eq('complex_event_id', eventId)
      .eq('tenant_id', tenantId)
      .order('display_order', { ascending: true });

    if (complexErr) {
      console.error('[EventTicketTypes] complex_event_ticket_class query error:', complexErr);
      return res.status(500).json({ error: complexErr.message });
    }

    const complexByName = new Map();
    for (const tc of complexTicketClasses || []) {
      if (tc.name) complexByName.set(tc.name.toLowerCase(), { id: tc.id, name: tc.name });
    }

    // Union booking names from both tables; add any name not already covered
    // by a configured tier, keeping the real ticket_class_id from the booking.
    for (const src of [regResult, complexResult]) {
      for (const [key, tc] of src.byName) {
        if (!complexByName.has(key)) complexByName.set(key, { id: tc.id, name: tc.name });
      }
    }

    const ticketTypes = [...complexByName.values()];
    if (hasNoTicketType) {
      ticketTypes.push({ id: NO_TICKET_TYPE_SENTINEL, name: 'No ticket type' });
    }
    return res.json({ ticketTypes });
  } catch (err) {
    console.error('[EventTicketTypes] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
