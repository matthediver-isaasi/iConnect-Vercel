import { supabase } from './database.js';
import { getZoomAccessTokenForTenant } from './zoomClient.js';
import { readZoomRegistration, enableZoomRegistration, listZoomRegistrations } from './zoomRegistration.js';

export async function confirmedZoomBookings(eventId, tenantId) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from('booking')
      .select('id, attendee_email, attendee_first_name, attendee_last_name, status, event_id, tenant_id, total_cost, booking_reference, ticket_price, ticket_class_name, ticket_class_id, member_id')
      .eq('event_id', eventId).eq('tenant_id', tenantId).eq('status', 'confirmed')
      .order('id').range(offset, offset + 499);
    if (error || !Array.isArray(data)) {
      // Never log raw database messages/details: they may contain row values.
      const code = /^[A-Z0-9]{5,12}$/.test(error?.code || '') ? error.code : 'UNKNOWN';
      console.error('[ZoomBookingLookup]', { code, table: 'booking', operation: 'confirmed-event-page', offset });
      const failure = new Error('Confirmed booking lookup failed; no attendee actions were performed.');
      failure.code = code;
      throw failure;
    }
    rows.push(...data);
    if (data.length < 500) return rows;
    if (rows.length >= 50000) throw new Error('Too many bookings for interactive reconciliation');
  }
}

export async function zoomAuthority(tenantId, record, kind, enable = false) {
  const id = record[kind === 'meetings' ? 'zoom_meeting_id' : 'zoom_webinar_id'];
  const token = await getZoomAccessTokenForTenant(tenantId);
  const live = enable ? await enableZoomRegistration(token, kind, id) : await readZoomRegistration(token, kind, id);
  return { token, id, kind, live };
}

export async function zoomEvidence(tenantId, record, kind, bookings) {
  const cached = { topic: record.topic, numericId: String(record[kind === 'meetings' ? 'zoom_meeting_id' : 'zoom_webinar_id']), start_time: record.start_time, timezone: record.timezone, registration_required: record.registration_required };
  try {
    const authority = await zoomAuthority(tenantId, record, kind);
    if (authority.live.registration_required === false) {
      return { cached, live: authority.live, counts: null, registrationError: null };
    }
    let counts = null, registrationError = null;
    try {
      if (!Array.isArray(bookings)) return { cached, live: authority.live, counts: null };
      const records = await listZoomRegistrations(authority.token, kind, authority.id);
      counts = { approved: 0, pending: 0, denied: 0, missing: 0, missingEmail: 0 };
      for (const b of bookings) {
        const email = b.attendee_email?.trim().toLowerCase();
        if (!email) counts.missingEmail++;
        else counts[records.get(email)?.status || 'missing']++;
      }
    } catch (error) { registrationError = error.message; }
    return { cached, live: authority.live, counts, registrationError };
  } catch (error) { return { cached, live: null, counts: null, error: error.message }; }
}
