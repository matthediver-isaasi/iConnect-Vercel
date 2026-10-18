/**
 * Reporting-only evidence. Never copy these values into checkout balances,
 * payment intents, refunds or ordinary booking payment fields.
 */
export async function attachSalesTicketValues(db, tenantId, bookings) {
  for (const kind of ['simple', 'complex']) {
    const rows = bookings.filter(row => (row._report_booking_source === 'complex' ? 'complex' : 'simple') === kind);
    for (let offset = 0; offset < rows.length; offset += 200) {
      const batch = rows.slice(offset, offset + 200);
      const { data, error } = await db.from('sales_allocation_ticket_value')
        .select('booking_id,currency,net_minor,tax_minor,gross_minor,allocation_id')
        .eq('tenant_id', tenantId).eq('booking_kind', kind).in('booking_id', batch.map(row => row.id));
      if (error) throw new Error(`Failed to load proposal ticket attribution: ${error.message}`);
      const values = new Map((data || []).map(value => [value.booking_id, value]));
      for (const row of batch) row._proposal_ticket_value = values.get(row.id) || null;
    }
  }
  return bookings;
}
