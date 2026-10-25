/**
 * Reporting-only evidence. Never copy these values into checkout balances,
 * payment intents, refunds or ordinary booking payment fields.
 */
export function resolvedTicketValue(value, snapshot) {
  if (value.gross_minor !== null) return value;
  if (!snapshot) return { ...value, status: 'pending' };
  const places = BigInt(snapshot.places), k = BigInt(value.place_index);
  const gross = BigInt(snapshot.grossMinor), net = BigInt(snapshot.netMinor);
  const before = gross * (k - 1n) / places, after = gross * k / places;
  const n = gross === 0n ? 0n : net * after / gross - net * before / gross;
  return { ...value, status: 'allocated', net_minor: String(n),
    tax_minor: String(after - before - n), gross_minor: String(after - before) };
}

export async function attachSalesTicketValues(db, tenantId, bookings) {
  for (const kind of ['simple', 'complex']) {
    const rows = bookings.filter(row => (row._report_booking_source === 'complex' ? 'complex' : 'simple') === kind);
    for (let offset = 0; offset < rows.length; offset += 200) {
      const batch = rows.slice(offset, offset + 200);
      const { data, error } = await db.from('sales_allocation_ticket_value')
        .select('booking_id,currency,net_minor,tax_minor,gross_minor,allocation_id,place_index')
        .eq('tenant_id', tenantId).eq('booking_kind', kind).in('booking_id', batch.map(row => row.id));
      if (error) throw new Error(`Failed to load proposal ticket attribution: ${error.message}`);
      const pendingIds = [...new Set((data || []).filter(v => v.gross_minor === null).map(v => v.allocation_id))];
      let resolutions = new Map();
      if (pendingIds.length) {
        const result = await db.from('sales_allocation_value_resolution').select('allocation_id,snapshot')
          .eq('tenant_id', tenantId).in('allocation_id', pendingIds);
        if (result.error) throw new Error(`Failed to load proposal value resolutions: ${result.error.message}`);
        resolutions = new Map((result.data || []).map(r => [r.allocation_id, r.snapshot]));
      }
      const values = new Map((data || []).map(value => [value.booking_id, resolvedTicketValue(value, resolutions.get(value.allocation_id))]));
      for (const row of batch) row._proposal_ticket_value = values.get(row.id) || null;
    }
  }
  return bookings;
}
