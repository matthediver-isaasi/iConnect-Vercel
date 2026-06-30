import { getTenantContext } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';

export const NO_TICKET_TYPE_SENTINEL = '__no_ticket_type__';

/**
 * Paginates through a booking table and collects the distinct ticket types
 * present on confirmed bookings for the given event.
 *
 * Returns:
 *   byId   – Map<ticket_class_id, {id, name}>  (rows that have an id)
 *   byName – Map<lowercaseName, {id, name}>     (rows with name only)
 *   hasNoTicketType – true if any row has BOTH id and name empty/null
 */
async function collectBookingTicketTypes(table, eventId, tenantId) {
  const byId = new Map();
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
      } else if (row.ticket_class_id) {
        if (!byId.has(row.ticket_class_id)) {
          byId.set(row.ticket_class_id, {
            id: row.ticket_class_id,
            name: row.ticket_class_name || row.ticket_class_id,
          });
        }
      } else {
        const key = row.ticket_class_name.toLowerCase();
        if (!byName.has(key)) {
          byName.set(key, { id: row.ticket_class_name, name: row.ticket_class_name });
        }
      }
    }

    offset += data.length;
    hasMore = data.length === pageSize;
  }

  return { byId, byName, hasNoTicketType };
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
      // Configured tiers are the primary source; booking names fill in the gaps.
      const byName = new Map();

      for (const tc of simpleEvent.pricing_config?.ticket_classes || []) {
        if (tc.name) {
          byName.set(tc.name.toLowerCase(), { id: tc.id || tc.name, name: tc.name });
        }
      }

      // Union booking entries from both tables (by name)
      for (const src of [regResult, complexResult]) {
        for (const [key, tc] of src.byName) {
          if (!byName.has(key)) byName.set(key, tc);
        }
        // id-keyed rows from booking tables: check by name to avoid duplication
        for (const [, tc] of src.byId) {
          const key = tc.name.toLowerCase();
          if (!byName.has(key)) byName.set(key, { id: tc.id, name: tc.name });
        }
      }

      const ticketTypes = [...byName.values()];
      if (hasNoTicketType) {
        ticketTypes.push({ id: NO_TICKET_TYPE_SENTINEL, name: 'No ticket type' });
      }
      return res.json({ ticketTypes });
    }

    // Complex event: ticket types are rows in complex_event_ticket_class.
    // Deduplicate primarily by id; fall back to case-insensitive name for
    // legacy rows that have a name but no id.
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

    const byId = new Map();
    for (const tc of complexTicketClasses || []) {
      if (tc.name) byId.set(tc.id, { id: tc.id, name: tc.name });
    }

    // Union id-keyed booking entries from both tables
    for (const src of [regResult, complexResult]) {
      for (const [id, tc] of src.byId) {
        if (!byId.has(id)) byId.set(id, tc);
      }
      // Name-only booking rows: check whether the name is already covered
      for (const [, tc] of src.byName) {
        const alreadyCovered = [...byId.values()].some(
          existing => existing.name.toLowerCase() === tc.name.toLowerCase()
        );
        if (!alreadyCovered) {
          const syntheticId = `name:${tc.name}`;
          byId.set(syntheticId, { id: syntheticId, name: tc.name });
        }
      }
    }

    const ticketTypes = [...byId.values()];
    if (hasNoTicketType) {
      ticketTypes.push({ id: NO_TICKET_TYPE_SENTINEL, name: 'No ticket type' });
    }
    return res.json({ ticketTypes });
  } catch (err) {
    console.error('[EventTicketTypes] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
