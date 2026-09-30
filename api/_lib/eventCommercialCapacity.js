export async function getEventCommercialCapacity(db, tenantId, eventKind, eventId) {
  if (!db || !tenantId || !eventId || !['simple', 'complex'].includes(eventKind)) return new Map();
  const { data, error } = await db
    .from('sales_commercial_allocation_totals')
    .select('ticket_type_id,allocated,named,reserved,released,cancelled,remaining')
    .eq('tenant_id', tenantId)
    .eq('event_reference_kind', eventKind)
    .eq('event_id', eventId);
  if (error) {
    // Keep event reads compatible while the migration rolls through environments.
    if (error.code === '42P01' || error.code === 'PGRST205') return new Map();
    throw error;
  }
  const byTicket = new Map();
  for (const row of data || []) {
    const key = String(row.ticket_type_id);
    const current = byTicket.get(key) || {
      allocated: 0, named: 0, reserved: 0, released: 0, cancelled: 0, remaining: 0, unused: 0,
    };
    for (const field of ['allocated', 'named', 'reserved', 'released', 'cancelled', 'remaining']) {
      current[field] += Number(row[field]) || 0;
    }
    current.unused = Math.max(0, current.remaining - current.named - current.reserved);
    byTicket.set(key, current);
  }
  return byTicket;
}

export function mergeTicketCommercialCapacity(ticket, confirmedCount, commercial = null, exposeBreakdown = true) {
  const max = ticket.is_unlimited_tickets === true
    || ticket.available_count === null
    || ticket.available_count === undefined
    || ticket.available_count === ''
    ? null
    : Number(ticket.available_count);
  const totals = commercial || {
    allocated: 0, named: 0, reserved: 0, released: 0, cancelled: 0, remaining: 0, unused: 0,
  };
  const used = confirmedCount + totals.unused;
  const trueAvailable = max === null || !Number.isFinite(max) ? null : Math.max(0, max - used);
  return {
    ...(exposeBreakdown ? {
      commercial_allocated: totals.allocated,
      commercial_named: totals.named,
      commercial_reserved: totals.reserved,
      commercial_unused: totals.unused,
      commercial_released: totals.released,
      commercial_cancelled: totals.cancelled,
    } : {}),
    true_available: trueAvailable,
    is_sold_out: trueAvailable !== null && trueAvailable <= 0,
  };
}
