// Reservations are not attendee records and never enter registration/revenue totals.
export async function salesEventReservations(db, tenantId, totals) {
  const active = totals.filter(row => Number(row.remaining) - Number(row.named) > 0);
  const rows = [];
  for (let offset = 0; offset < active.length; offset += 150) {
    const batch = active.slice(offset, offset + 150);
    const { data, error } = await db.from('sales_commercial_allocation')
      .select('id,event_snapshot,ticket_snapshot,sales_commercial_sale(sales_quote(quote_number),sales_quote_version(organisation_snapshot))')
      .eq('tenant_id', tenantId).in('id', batch.map(row => row.allocation_id));
    if (error) throw error;
    const byId = new Map((data || []).map(row => [row.id, row]));
    for (const total of batch) {
      const detail = byId.get(total.allocation_id);
      if (!detail) throw new Error('Reservation details are unavailable');
      rows.push({ allocationId: total.allocation_id, eventId: total.event_id,
        eventName: detail.ticket_snapshot?.event_title || detail.event_snapshot?.title || 'Event',
        ticketName: detail.ticket_snapshot?.ticket_name || detail.ticket_snapshot?.name || 'Ticket',
        proposalNumber: detail.sales_commercial_sale?.sales_quote?.quote_number || 'Unnumbered proposal',
        organizationName: detail.sales_commercial_sale?.sales_quote_version?.organisation_snapshot?.name || 'Not recorded',
        status: 'Reserved', places: Number(total.remaining) - Number(total.named) });
    }
  }
  return rows;
}
