import { fetchTrainingAgendaLines } from './trainingAgenda.js';
import { followUpTargets, followUpSnapshot, followUpBookingEligible } from './eventFollowUpTargets.js';

export async function followUpPages(client, table, filter) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await filter(client.from(table).select('*')).order('id').range(offset, offset + 499);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < 500) return rows;
  }
}

export async function loadFollowUpProgramme(client, event) {
  if (!event.is_complex) {
    const entries = await fetchTrainingAgendaLines(event.id, client);
    return { entries, tickets: [], tracks: [], junctions: [] };
  }
  const entries = await followUpPages(client, 'complex_event_session', q => q.eq('complex_event_id', event.id));
  const tickets = await followUpPages(client, 'complex_event_ticket_class', q => q.eq('complex_event_id', event.id));
  const tracks = await followUpPages(client, 'complex_event_track', q => q.eq('complex_event_id', event.id));
  const junctions = [];
  for (let i = 0; i < entries.length; i += 100) {
    junctions.push(...await followUpPages(client, 'complex_event_session_track',
      q => q.in('complex_event_session_id', entries.slice(i, i + 100).map(e => e.id))));
  }
  return { entries, tickets, tracks, junctions };
}

export function accessibleFollowUpEntries(event, booking, programme) {
  if (!event.is_complex) return programme.entries.map(e => e.id);
  const ticket = programme.tickets.find(t => t.id === booking.ticket_class_id);
  if (!ticket) return [];
  if (ticket.all_tracks === true) return programme.entries.map(e => e.id);
  const links = ticket.linked_track_ids;
  if (ticket.all_tracks !== false || !Array.isArray(links) || !links.length
    || links.some(id => !programme.tracks.some(t => t.id === id))) return [];
  return programme.entries.filter(e => {
    const ids = [...new Set([e.complex_event_track_id,
      ...programme.junctions.filter(j => j.complex_event_session_id === e.id).map(j => j.complex_event_track_id)].filter(Boolean))];
    return ids.length === 0 || ids.some(id => links.includes(id));
  }).map(e => e.id);
}

export async function loadFollowUpEvent(client, eventId) {
  for (const table of ['event', 'complex_event']) {
    const { data, error } = await client.from(table).select('*').eq('id', eventId).maybeSingle();
    if (error) throw error;
    if (data) return { ...data, is_complex: table === 'complex_event' };
  }
  throw new Error('Event not found');
}

export function calculateBookingFollowUps(event, email, programme, booking, now) {
  return followUpTargets({ event, email, entries: programme.entries,
    accessibleIds: accessibleFollowUpEntries(event, booking, programme), now });
}

export async function scheduleEventFollowUps(client, eventId, { bookingId = null, now = new Date() } = {}) {
  const result = { requeued: 0, bookingsScheduled: 0, bookingsConsidered: 0, preserved: 0, cancelled: 0, skipped: [], schedulingFailures: [] };
  try {
    const emails = await followUpPages(client, 'event_email', q => q.eq('event_id', eventId).eq('email_type', 'follow_up'));
    if (!emails.length) return result;
    const event = await loadFollowUpEvent(client, eventId);
    const programme = await loadFollowUpProgramme(client, event);
    const bookingTables = event.is_complex ? ['booking', 'complex_event_booking'] : ['booking'];
    const scheduled = new Set();
    for (const table of bookingTables) {
      const bookings = await followUpPages(client, table, q => {
        q = q.eq('event_id', eventId);
        return bookingId ? q.eq('id', bookingId) : q;
      });
      result.bookingsConsidered += bookings.length;
      for (const booking of bookings) for (const email of emails) {
        const calculation = calculateBookingFollowUps(event, email, programme, booking, now);
        const targets = email.is_enabled && followUpBookingEligible(booking, event) ? calculation.eligible : [];
        result.skipped.push(...calculation.skipped.map(s => ({ ...s, event_email_id: email.id })));
        if (!targets.length) result.skipped.push({ event_email_id: email.id, reason: 'No eligible future follow-up targets; check end times, ticket entitlement and delay.' });
        const rows = await followUpPages(client, 'scheduled_email',
          q => q.eq('event_email_id', email.id).eq('booking_id', booking.id));
        for (const row of rows) {
          if (row.status !== 'pending' || targets.some(t => t.key === row.follow_up_target_key)) continue;
          const { data, error } = await client.from('scheduled_email').update({ status: 'cancelled' })
            .eq('id', row.id).eq('status', 'pending').select('id');
          if (error) throw error;
          result.cancelled += data?.length || 0;
        }
        for (const target of targets) {
          const existing = rows.find(r => r.follow_up_target_key === target.key);
          if (existing && !['pending', 'cancelled'].includes(existing.status)) { result.preserved++; continue; }
          const payload = { scheduled_send_time: target.scheduledTime.toISOString(), status: 'pending', error_message: null,
            attendee_email: booking.attendee_email, follow_up_target_snapshot: followUpSnapshot(event, email, target, booking),
            follow_up_booking_table: table };
          const query = existing
            ? client.from('scheduled_email').update(payload).eq('id', existing.id).eq('status', existing.status)
            : client.from('scheduled_email').insert({ ...payload, event_email_id: email.id, booking_id: booking.id,
              follow_up_target_key: target.key });
          const { data, error } = await query.select('id');
          if (error && error.code !== '23505') throw error;
          if (!data?.length) { result.preserved++; continue; }
          result.requeued++;
          scheduled.add(booking.id);
        }
      }
    }
    result.bookingsScheduled = scheduled.size;
  } catch (error) { result.error = error.message; }
  return result;
}

export async function validateFollowUpDelivery(client, row, email, now = new Date()) {
  if (!email.is_enabled || email.email_type !== 'follow_up') return { reason: 'Follow-up disabled or removed' };
  if (!['booking', 'complex_event_booking'].includes(row.follow_up_booking_table)) return { reason: 'Missing follow-up booking identity' };
  const event = await loadFollowUpEvent(client, email.event_id);
  const { data: booking, error } = await client.from(row.follow_up_booking_table).select('*').eq('id', row.booking_id)
    .eq('event_id', email.event_id).maybeSingle();
  if (error) throw error;
  if (!followUpBookingEligible(booking, event)) return { reason: 'Booking or event no longer eligible' };
  const programme = await loadFollowUpProgramme(client, event);
  const calculation = calculateBookingFollowUps(event, email, programme, booking, now);
  const target = calculation.targets.find(t => t.key === row.follow_up_target_key);
  if (!target || target.end > now || target.scheduledTime > now
    || target.scheduledTime.toISOString() !== row.scheduled_send_time && target.scheduledTime.getTime() !== new Date(row.scheduled_send_time).getTime()
    || followUpSnapshot(event, email, target, booking) !== row.follow_up_target_snapshot) {
    return { reason: 'Follow-up target, entitlement, recipient or timing changed; explicitly schedule again.' };
  }
  return { event, booking, programme, target, timezone: calculation.timezone };
}
