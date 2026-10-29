export async function previewEventBookingTable(db, tenantId, eventId) {
  for (const [eventTable, bookingTable] of [['event', 'booking'], ['complex_event', 'complex_event_booking']]) {
    const { data, error } = await db.from(eventTable).select('id')
      .eq('tenant_id', tenantId).eq('id', eventId).maybeSingle();
    if (error) throw error;
    if (data) return bookingTable;
  }
  throw Object.assign(new Error('Event not found'), { status: 404 });
}

export async function loadPreviewBooking(db, tenantId, eventId, bookingId) {
  const table = await previewEventBookingTable(db, tenantId, eventId);
  const { data, error } = await db.from(table).select('*')
    .eq('tenant_id', tenantId).eq('event_id', eventId).eq('id', bookingId).eq('status', 'confirmed').maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Confirmed attendee not found for this event'), { status: 404 });
  return data;
}

export async function listPreviewAttendees(db, tenantId, eventId, search, offset) {
  const table = await previewEventBookingTable(db, tenantId, eventId);
  let query = db.from(table).select('id,attendee_first_name,attendee_last_name,attendee_email')
    .eq('tenant_id', tenantId).eq('event_id', eventId).eq('status', 'confirmed');
  // Exclude PostgREST expression syntax from the search literal.
  const term = String(search || '').replace(/[^\p{L}\p{N}@ .-]/gu, '').slice(0, 100).trim();
  if (term) query = query.or(['attendee_first_name', 'attendee_last_name', 'attendee_email']
    .map(field => `${field}.ilike.*${term.replace(/_/g, '\\_')}*`).join(','));
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const { data, error } = await query.order('id').range(start, start + 25);
  if (error) throw error;
  return { items: (data || []).slice(0, 25), hasMore: (data || []).length > 25 };
}
