// Only aggregate quantities leave the private inventory store. Session identity,
// guest capability digests, attendees and price snapshots never enter discovery.
export async function loadEventShoppingHolds(db, tenantId, kind, eventIds) {
  const ids = [...new Set(eventIds.filter(Boolean))];
  const result = new Map();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const { data, error } = await db.rpc('event_funnel_inventory_projection', {
      p_tenant: tenantId, p_kind: kind, p_events: ids.slice(offset, offset + 100),
    });
    // The staged feature cannot activate without this RPC. Compatibility applies
    // only to an absent migration, never a failed installed inventory reader.
    if (error && ['42883', 'PGRST202'].includes(error.code)) return new Map();
    if (error || !Array.isArray(data)) throw new Error('Reserved event availability is temporarily unavailable');
    for (const row of data) {
      if (!ids.includes(row.event_id) || !Number.isSafeInteger(Number(row.places)) || Number(row.places) < 0
        || typeof row.ticket_id !== 'string') throw new Error('Invalid reserved event availability');
      let event = result.get(row.event_id);
      if (!event) { event = { places: 0, tickets: new Map() }; result.set(row.event_id, event); }
      if (event.tickets.has(row.ticket_id)) throw new Error('Duplicate reserved event availability');
      event.tickets.set(row.ticket_id, Number(row.places));
      event.places += Number(row.places);
    }
  }
  return result;
}

// Public-only projection. Never use this to hydrate event editor fields: the
// underlying historical counter is not rewritten by temporary reservations.
export async function projectPublicShoppingAvailability(db, tenantId, kind, rows) {
  const holds = await loadEventShoppingHolds(db, tenantId, kind, rows.map(row => row.id));
  return rows.map(row => {
    const held = holds.get(row.id)?.places || 0;
    if (!held || (kind === 'simple' && row.capacity_mode === 'total')) return row;
    return {
      ...row,
      shopping_held: held,
      available_seats: row.available_seats == null ? row.available_seats : Math.max(0, Number(row.available_seats) - held),
    };
  });
}
