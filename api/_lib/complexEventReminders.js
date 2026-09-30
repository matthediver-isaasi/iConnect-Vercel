// Shared scheduler for complex (multi-day) event reminder emails.
//
// Relative reminders are scheduled ONE PER CALENDAR DAY (in the event's
// timezone, falling back to UTC when none is stored), anchored to the
// earliest session of that day the attendee's ticket class can access.
// The scheduled_email dedupe key stays (event_email_id, booking_id,
// session_id): we use the day's anchor session id as the session_id, and
// because the anchor (earliest accessible session per day) is deterministic,
// re-running scheduling can never create a second row for the same day.
// Absolute (specific date/time) reminders remain once per booking with
// session_id NULL.

export function getHoursFromTimingType(timingType, customHours) {
  switch (timingType) {
    case '7_days_before': return 7 * 24;
    case '3_days_before': return 3 * 24;
    case '1_day_before': return 24;
    case '12_hours_before': return 12;
    case '6_hours_before': return 6;
    case '1_hour_before': return 1;
    case '30_minutes_before': return 0.5;
    case 'custom': return customHours || 24;
    default: return 24;
  }
}

export function isAbsoluteReminder(email) {
  return (
    email &&
    email.timing_type === 'custom' &&
    email.custom_unit === 'specific_datetime' &&
    !!email.custom_send_at
  );
}

export function calculateScheduledTimeMs(referenceMs, email) {
  const { timing_type, custom_hours_before, custom_unit, custom_send_at } = email;

  if (timing_type === 'custom' && custom_unit === 'specific_datetime') {
    if (custom_send_at) {
      return new Date(custom_send_at).getTime();
    }
    return null;
  }

  let hoursBeforeEvent;
  if (timing_type === 'custom') {
    const value = custom_hours_before || 24;
    switch (custom_unit) {
      case 'days': hoursBeforeEvent = value * 24; break;
      case 'minutes': hoursBeforeEvent = value / 60; break;
      case 'hours':
      default: hoursBeforeEvent = value; break;
    }
  } else {
    hoursBeforeEvent = getHoursFromTimingType(timing_type, custom_hours_before);
  }

  return referenceMs - (hoursBeforeEvent * 60 * 60 * 1000);
}

function normalizeStartTime(startTimeStr) {
  let s = startTimeStr;
  if (!s.endsWith('Z') && !s.includes('+') && !s.includes('-', 10)) {
    s = s + 'Z';
  }
  const ms = new Date(s).getTime();
  return isNaN(ms) ? null : ms;
}

// Calendar-day key (YYYY-MM-DD) for a timestamp in the given IANA timezone.
export function dayKeyInTimezone(ms, timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(ms));
  } catch {
    // Bad/unknown timezone string — fall back to UTC.
    return new Date(ms).toISOString().slice(0, 10);
  }
}

// Group accessible sessions by calendar day and return one anchor session
// (the earliest that day) per day, sorted chronologically.
export function pickDayAnchorSessions(sessions, timezone) {
  const byDay = new Map();
  for (const session of sessions) {
    if (!session.start_time) continue;
    const startMs = normalizeStartTime(session.start_time);
    if (startMs == null) continue;
    const key = dayKeyInTimezone(startMs, timezone);
    const current = byDay.get(key);
    if (!current || startMs < current.startMs) {
      byDay.set(key, { session, startMs, dayKey: key });
    }
  }
  return [...byDay.values()].sort((a, b) => a.startMs - b.startMs);
}

/**
 * Schedule reminder emails for a complex-event booking.
 * One row per relative-reminder config per calendar day (anchored to the
 * earliest accessible session that day); absolute reminders once per booking.
 */
export async function scheduleComplexEventReminders({
  supabase,
  bookingId,
  eventId,
  attendeeEmail,
  ticketClassId,
  reminderEmails,
  logPrefix = '[scheduleComplexEventReminders]'
}) {
  try {
    if (!Array.isArray(reminderEmails) || reminderEmails.length === 0) return;

    const { data: complexEvent } = await supabase
      .from('complex_event')
      .select('id, timezone')
      .eq('id', eventId)
      .maybeSingle();
    const timezone = complexEvent?.timezone || 'UTC';

    const { data: sessions, error: sessionsError } = await supabase
      .from('complex_event_session')
      .select('id, title, start_time')
      .eq('complex_event_id', eventId)
      .order('start_time', { ascending: true });

    if (sessionsError || !sessions || sessions.length === 0) {
      console.log(`${logPrefix} No sessions found for complex event ${eventId}`);
      return;
    }

    const sessionIds = sessions.map(s => s.id);
    const { data: junctions } = await supabase
      .from('complex_event_session_track')
      .select('complex_event_session_id, complex_event_track_id')
      .in('complex_event_session_id', sessionIds);

    const sessionTrackMap = {};
    for (const j of (junctions || [])) {
      if (!sessionTrackMap[j.complex_event_session_id]) {
        sessionTrackMap[j.complex_event_session_id] = [];
      }
      sessionTrackMap[j.complex_event_session_id].push(j.complex_event_track_id);
    }

    let accessibleSessions = sessions;

    if (ticketClassId) {
      const { data: ticketClass } = await supabase
        .from('complex_event_ticket_class')
        .select('id, linked_track_ids, all_tracks')
        .eq('id', ticketClassId)
        .eq('complex_event_id', eventId)
        .maybeSingle();

      if (ticketClass && !ticketClass.all_tracks && ticketClass.linked_track_ids?.length > 0) {
        accessibleSessions = sessions.filter(s => {
          const trackIds = sessionTrackMap[s.id] || [];
          return trackIds.length === 0 ||
            trackIds.some(tid => ticketClass.linked_track_ids.includes(tid));
        });
      }
    }

    const dayAnchors = pickDayAnchorSessions(accessibleSessions, timezone);

    console.log(`${logPrefix} ${accessibleSessions.length} accessible sessions across ${dayAnchors.length} day(s) for booking ${bookingId} (tz ${timezone})`);

    const nowMs = Date.now();

    for (const email of reminderEmails) {
      if (isAbsoluteReminder(email)) {
        const scheduledTimeMs = calculateScheduledTimeMs(0, email);
        if (scheduledTimeMs == null || scheduledTimeMs <= nowMs) {
          console.log(`${logPrefix} Skipping absolute reminder - already passed or invalid`);
          continue;
        }
        const scheduledTimeISO = new Date(scheduledTimeMs).toISOString();

        const { data: existing } = await supabase
          .from('scheduled_email')
          .select('id')
          .eq('event_email_id', email.id)
          .eq('booking_id', bookingId)
          .is('session_id', null)
          .maybeSingle();

        if (existing) {
          console.log(`${logPrefix} Absolute reminder already scheduled for booking ${bookingId}`);
          continue;
        }

        const { error: insertError } = await supabase
          .from('scheduled_email')
          .insert({
            event_email_id: email.id,
            booking_id: bookingId,
            attendee_email: attendeeEmail,
            scheduled_send_time: scheduledTimeISO,
            session_id: null,
            status: 'pending'
          });

        if (insertError) {
          console.error(`${logPrefix} Failed to insert absolute reminder:`, insertError.message);
        } else {
          console.log(`${logPrefix} Scheduled absolute reminder for booking ${bookingId} at ${scheduledTimeISO}`);
        }
        continue;
      }

      // Relative reminder: one per calendar day, anchored to the earliest
      // accessible session that day.
      for (const anchor of dayAnchors) {
        const { session, startMs, dayKey } = anchor;

        const scheduledTimeMs = calculateScheduledTimeMs(startMs, email);
        if (!scheduledTimeMs) continue;

        if (scheduledTimeMs <= nowMs) {
          console.log(`${logPrefix} Skipping day ${dayKey} reminder - already passed`);
          continue;
        }

        const scheduledTimeISO = new Date(scheduledTimeMs).toISOString();

        const { data: existing } = await supabase
          .from('scheduled_email')
          .select('id')
          .eq('event_email_id', email.id)
          .eq('booking_id', bookingId)
          .eq('session_id', session.id)
          .maybeSingle();

        if (existing) {
          console.log(`${logPrefix} Reminder already scheduled for booking ${bookingId}, day ${dayKey}`);
          continue;
        }

        const { error: insertError } = await supabase
          .from('scheduled_email')
          .insert({
            event_email_id: email.id,
            booking_id: bookingId,
            attendee_email: attendeeEmail,
            scheduled_send_time: scheduledTimeISO,
            session_id: session.id,
            status: 'pending'
          });

        if (insertError) {
          console.error(`${logPrefix} Failed to insert reminder for day ${dayKey} (anchor "${session.title}"):`, insertError.message);
          continue;
        }

        console.log(`${logPrefix} Scheduled reminder for day ${dayKey} (anchor "${session.title}") at ${scheduledTimeISO}`);
      }
    }

    console.log(`${logPrefix} Done scheduling for booking ${bookingId}`);
  } catch (err) {
    console.error(`${logPrefix} Error:`, err.message);
  }
}
