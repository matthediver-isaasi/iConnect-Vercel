import { readZoomRegistration, listZoomRegistrations, registerWithZoom } from './zoomRegistration.js';

// Called only after confirmed bookings have committed. Provider reads precede
// creation, so replay adopts an existing registration instead of duplicating it.
export async function registerBookingZoomMeeting(db, event, bookings, getToken, provider = {
  read: readZoomRegistration, list: listZoomRegistrations, register: registerWithZoom,
}) {
  if (!event.zoom_meeting_id) return [];
  const eligible = bookings.filter(row => row.status === 'confirmed'
    && row.event_id === event.id && row.tenant_id === event.tenant_id);
  if (!eligible.length) return [];
  try {
    const { data: meeting, error } = await db.from('zoom_meeting').select('*')
      .eq('tenant_id', event.tenant_id).eq('id', event.zoom_meeting_id).single();
    if (error || !meeting?.zoom_meeting_id) throw new Error('Linked Zoom meeting is unavailable');
    const token = await getToken(event.tenant_id);
    const live = await provider.read(token, 'meetings', meeting.zoom_meeting_id);
    if (!live.registration_required) return [];
    const records = await provider.list(token, 'meetings', meeting.zoom_meeting_id);
    const results = [];
    for (const booking of eligible) {
      try {
        const email = booking.attendee_email?.trim().toLowerCase();
        const result = await provider.register(token, 'meetings', meeting.zoom_meeting_id, {
          email, first_name: booking.attendee_first_name || 'Guest',
          last_name: booking.attendee_last_name || 'Attendee',
        }, records);
        const registrantId = result.registrant_id || records.get(email)?.registrant_id || records.get(email)?.id;
        if (result.success && registrantId) {
          const saved = await db.from('booking').update({ zoom_registrant_id: registrantId })
            .eq('tenant_id', event.tenant_id).eq('event_id', event.id)
            .eq('id', booking.id).eq('status', 'confirmed');
          if (saved.error) throw new Error('Could not save Zoom registration');
        }
        results.push({ email: booking.attendee_email, ...result });
      } catch {
        results.push({ email: booking.attendee_email, success: false, error: 'Zoom registration needs reconciliation' });
      }
    }
    return results;
  } catch {
    return eligible.map(booking => ({ email: booking.attendee_email, success: false,
      error: 'Zoom registration needs reconciliation' }));
  }
}
