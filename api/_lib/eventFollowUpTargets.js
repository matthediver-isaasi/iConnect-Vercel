import { createHash } from 'node:crypto';
import { formatInTimeZone } from 'date-fns-tz';
import { agendaInstant } from '../../shared/trainingAgendaBounds.js';

export function validateFollowUpConfig(email) {
  if (email.email_type !== 'follow_up') return;
  if (!['event', 'day', 'session'].includes(email.follow_up_scope)) throw new Error('Choose After event, After day or After session.');
  if (typeof email.follow_up_delay !== 'number' || !Number.isFinite(email.follow_up_delay) || email.follow_up_delay < 0
    || !['minutes', 'hours', 'days'].includes(email.follow_up_unit)) throw new Error('Enter a nonnegative follow-up delay and a valid unit.');
}

function instant(value) {
  if (typeof value !== 'string' || !/[T ]\d{2}:\d{2}/.test(value) || !Number.isFinite(new Date(value).getTime())) throw new Error('Add an explicit valid end date and time.');
  return new Date(value);
}

export function followUpBookingEligible(booking, event) {
  return booking?.event_id === event.id && booking.status === 'confirmed' && !!booking.attendee_email
    && !['cancelled', 'cancelling', 'deleted', 'draft'].includes(event.status);
}

// Caller supplies the COMPLETE programme, not just the recipient's sessions.
export function followUpTargets({ event, email, entries = [], accessibleIds = [], now = new Date() }) {
  validateFollowUpConfig(email);
  const timezone = event.timezone || (event.is_complex ? 'UTC' : 'Europe/London');
  const targets = [], skipped = [], programme = [];
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); }
  catch { return { targets, eligible: [], skipped: [{ reason: 'Choose a valid event timezone.' }], timezone }; }
  const scope = email.follow_up_scope;
  for (const entry of entries) {
    if (['cancelled', 'deleted'].includes(entry.status)) continue;
    try {
      const start = event.is_complex ? instant(entry.start_time)
        : new Date(agendaInstant(entry.start_date, entry.start_time, null, timezone));
      const end = event.is_complex ? instant(entry.end_time)
        : new Date(agendaInstant(entry.end_date || entry.start_date, entry.end_time, null, timezone));
      if (end < start) throw new Error('End must not precede start; enter the overnight end date explicitly.');
      const day = formatInTimeZone(start, timezone, 'yyyy-MM-dd');
      programme.push({ entry, start, end, day });
    } catch (error) { skipped.push({ session_id: entry.id, reason: `${entry.title || entry.description || 'Programme entry'}: ${error.message}` }); }
  }
  const add = (key, end, label, entriesForTarget) => {
    const multiplier = { minutes: 60000, hours: 3600000, days: 86400000 }[email.follow_up_unit];
    const send = new Date(end.getTime() + email.follow_up_delay * multiplier);
    if (!Number.isFinite(send.getTime())) { skipped.push({ reason: 'Follow-up delay is too large.' }); return; }
    targets.push({ key, end, label, entries: entriesForTarget, scheduledTime: send, scope });
  };
  if (scope === 'event') {
    // Incomplete programme ends must never let the overall send run early.
    if (!skipped.length) {
      try {
        const declared = instant(event.end_date);
        const end = new Date(Math.max(declared.getTime(), ...programme.map(p => p.end.getTime())));
        add('event', end, event.title || 'Overall event', programme.map(p => p.entry));
      } catch (error) { skipped.push({ reason: error.message }); }
    }
  } else if (scope === 'session') {
    for (const p of programme) if (accessibleIds.includes(p.entry.id)) {
      add(`session:${p.entry.id}`, p.end, p.entry.title || p.entry.description || 'Session', [p.entry]);
    }
  } else {
    // A continuous range is ONE session. It supplies no independently timed
    // daily ends. Do not manufacture daily times or partially queue that plan.
    const ranges = programme.filter(p => !event.is_complex && p.entry.end_date
      && p.entry.end_date !== p.entry.start_date
      && !(new Date(`${p.entry.end_date}T00:00Z`) - new Date(`${p.entry.start_date}T00:00Z`) === 86400000
        && p.entry.end_time < p.entry.start_time));
    if (ranges.length) skipped.push({ reason: 'After day requires separately timed daily entries. Split continuous date-range entries into daily programme entries.' });
    if (!skipped.length) {
      for (const day of [...new Set(programme.map(p => p.day))]) {
        const daily = programme.filter(p => p.day === day);
        if (daily.some(p => accessibleIds.includes(p.entry.id))) {
          add(`day:${day}`, new Date(Math.max(...daily.map(p => p.end.getTime()))), day, daily.map(p => p.entry));
        }
      }
    }
  }
  targets.sort((a, b) => a.scheduledTime - b.scheduledTime || a.key.localeCompare(b.key));
  return { targets, eligible: targets.filter(t => t.scheduledTime > now), skipped, timezone };
}

export function followUpSnapshot(event, email, target, booking) {
  return createHash('sha256').update(JSON.stringify([
    event.id, event.timezone, email.follow_up_scope, email.follow_up_delay, email.follow_up_unit,
    target.key, target.end.toISOString(), target.scheduledTime.toISOString(),
    booking.attendee_email, booking.ticket_class_id,
    target.entries.map(e => [e.id, e.start_date, e.end_date, e.start_time, e.end_time, e.title, e.description, e.location]),
  ])).digest('hex');
}
