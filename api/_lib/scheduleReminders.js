import { supabase } from './database.js';
import { pickDayAnchorSessions } from './complexEventReminders.js';

export function isAbsoluteReminder(email) {
  return (
    email &&
    email.timing_type === 'custom' &&
    email.custom_unit === 'specific_datetime' &&
    !!email.custom_send_at
  );
}

export function calculateScheduledTime(eventStart, email) {
  const { timing_type, custom_hours_before, custom_unit, custom_send_at } = email;

  if (timing_type === 'custom' && custom_unit === 'specific_datetime') {
    if (custom_send_at) {
      return new Date(custom_send_at);
    }
    return null;
  }

  if (!eventStart) return null;
  const hoursBeforeEvent = getHoursFromTimingType(timing_type, custom_hours_before, custom_unit);
  return new Date(eventStart.getTime() - hoursBeforeEvent * 60 * 60 * 1000);
}

export function getHoursFromTimingType(timingType, customValue, customUnit) {
  switch (timingType) {
    case '7_days_before': return 7 * 24;
    case '3_days_before': return 3 * 24;
    case '1_day_before': return 24;
    case '12_hours_before': return 12;
    case '6_hours_before': return 6;
    case '1_hour_before': return 1;
    case '30_minutes_before': return 0.5;
    case 'custom': {
      const value = customValue || 24;
      switch (customUnit) {
        case 'days': return value * 24;
        case 'minutes': return value / 60;
        case 'hours':
        default: return value;
      }
    }
    default: return 24;
  }
}

function emptyResult() {
  return {
    requeued: 0,
    bookingsScheduled: 0,
    bookingsConsidered: 0,
    schedulingFailures: [],
    skipped: [],
  };
}

function recordWriteFailure(failureBag, email, error, bookingId) {
  console.error('[scheduleReminders] scheduled_email write failed', {
    timing_type: email.timing_type,
    event_email_id: email.id,
    booking_id: bookingId,
    code: error?.code,
    message: error?.message,
  });
  if (!failureBag.has(email.id)) {
    failureBag.set(email.id, {
      event_email_id: email.id,
      email_type: email.email_type,
      reason: error?.message || 'Unknown error',
      code: error?.code || null,
      failed_booking_count: 0,
    });
  }
  failureBag.get(email.id).failed_booking_count += 1;
}

export async function scheduleReminderEmails(eventId) {
  const result = emptyResult();
  const bookingSet = new Set();
  const failureBag = new Map();

  try {
    const { data: event, error: eventError } = await supabase
      .from('event')
      .select('id, start_date, title')
      .eq('id', eventId)
      .maybeSingle();

    if (eventError) {
      console.error('[scheduleReminderEmails] event lookup error', eventError);
      result.error = eventError.message;
      return result;
    }
    if (!event) {
      console.log('[scheduleReminderEmails] No event found');
      result.error = 'Event not found';
      return result;
    }

    const { data: reminderEmails, error: emailsError } = await supabase
      .from('event_email')
      .select('*')
      .eq('event_id', eventId)
      .eq('email_type', 'reminder')
      .eq('is_enabled', true);

    if (emailsError) {
      console.error('[scheduleReminderEmails] reminder emails fetch error', emailsError);
      result.error = emailsError.message;
      return result;
    }
    if (!reminderEmails || reminderEmails.length === 0) {
      console.log('[scheduleReminderEmails] No reminder emails configured');
      return result;
    }

    const { data: bookings, error: bookingsError } = await supabase
      .from('booking')
      .select('id, attendee_email')
      .eq('event_id', eventId)
      .neq('status', 'cancelled');

    if (bookingsError) {
      console.error('[scheduleReminderEmails] bookings fetch error', bookingsError);
      result.error = bookingsError.message;
      return result;
    }
    result.bookingsConsidered = bookings?.length || 0;

    if (!bookings || bookings.length === 0) {
      console.log('[scheduleReminderEmails] No active bookings found');
      for (const email of reminderEmails) {
        result.skipped.push({
          event_email_id: email.id,
          email_type: email.email_type,
          reason: 'no_active_bookings',
        });
      }
      return result;
    }

    const eventStart = event.start_date ? new Date(event.start_date) : null;

    for (const email of reminderEmails) {
      const isAbsolute = isAbsoluteReminder(email);
      if (!isAbsolute && !eventStart) {
        console.log('[scheduleReminderEmails] Skipping relative reminder; event has no start_date');
        result.skipped.push({
          event_email_id: email.id,
          email_type: email.email_type,
          reason: 'event_missing_start_date',
        });
        continue;
      }
      const scheduledTime = calculateScheduledTime(eventStart, email);

      if (!scheduledTime || scheduledTime <= new Date()) {
        result.skipped.push({
          event_email_id: email.id,
          email_type: email.email_type,
          reason: 'past_send_time',
        });
        continue;
      }

      for (const booking of bookings) {
        const { data: existing, error: existingError } = await supabase
          .from('scheduled_email')
          .select('id')
          .eq('event_email_id', email.id)
          .eq('booking_id', booking.id)
          .maybeSingle();

        if (existingError) {
          recordWriteFailure(failureBag, email, existingError, booking.id);
          continue;
        }

        if (existing) {
          const { error: updateError } = await supabase
            .from('scheduled_email')
            .update({
              scheduled_send_time: scheduledTime.toISOString(),
              status: 'pending',
            })
            .eq('id', existing.id);
          if (updateError) {
            recordWriteFailure(failureBag, email, updateError, booking.id);
            continue;
          }
        } else {
          const { error: insertError } = await supabase
            .from('scheduled_email')
            .insert({
              event_email_id: email.id,
              booking_id: booking.id,
              attendee_email: booking.attendee_email,
              scheduled_send_time: scheduledTime.toISOString(),
              status: 'pending',
            });
          if (insertError) {
            recordWriteFailure(failureBag, email, insertError, booking.id);
            continue;
          }
        }

        result.requeued += 1;
        bookingSet.add(booking.id);
      }
    }

    result.bookingsScheduled = bookingSet.size;
    result.schedulingFailures = Array.from(failureBag.values());
    console.log(`[scheduleReminderEmails] Scheduled ${result.requeued} reminder(s) for event ${eventId} across ${result.bookingsScheduled} booking(s); ${result.schedulingFailures.length} failure group(s); ${result.skipped.length} skipped`);
    return result;
  } catch (err) {
    console.error('[scheduleReminderEmails] Error:', err);
    result.bookingsScheduled = bookingSet.size;
    result.schedulingFailures = Array.from(failureBag.values());
    result.error = err.message;
    return result;
  }
}

export async function scheduleComplexEventReminderEmails(eventId, client = supabase) {
  const result = emptyResult();
  const bookingSet = new Set();
  const failureBag = new Map();

  try {
    const { data: complexEvent } = await client
      .from('complex_event')
      .select('id, timezone')
      .eq('id', eventId)
      .maybeSingle();
    const eventTimezone = complexEvent?.timezone || 'UTC';

    const { data: sessions, error: sessionsError } = await client
      .from('complex_event_session')
      .select('id, title, start_time')
      .eq('complex_event_id', eventId)
      .order('start_time', { ascending: true });

    if (sessionsError) {
      console.error('[scheduleComplexEventReminderEmails] sessions fetch error', sessionsError);
      result.error = sessionsError.message;
      return result;
    }

    const sessionList = sessions || [];
    const sessionIds = sessionList.map(s => s.id);

    let junctions = [];
    if (sessionIds.length > 0) {
      const { data: junctionsData, error: junctionsError } = await client
        .from('complex_event_session_track')
        .select('complex_event_session_id, complex_event_track_id')
        .in('complex_event_session_id', sessionIds);
      if (junctionsError) {
        console.error('[scheduleComplexEventReminderEmails] junctions fetch error', junctionsError);
      }
      junctions = junctionsData || [];
    }

    const sessionTrackMap = {};
    for (const j of junctions) {
      if (!sessionTrackMap[j.complex_event_session_id]) {
        sessionTrackMap[j.complex_event_session_id] = [];
      }
      sessionTrackMap[j.complex_event_session_id].push(j.complex_event_track_id);
    }

    const { data: reminderEmails, error: emailsError } = await client
      .from('event_email')
      .select('*')
      .eq('event_id', eventId)
      .eq('email_type', 'reminder')
      .eq('is_enabled', true);

    if (emailsError) {
      console.error('[scheduleComplexEventReminderEmails] reminder emails fetch error', emailsError);
      result.error = emailsError.message;
      return result;
    }
    if (!reminderEmails || reminderEmails.length === 0) {
      console.log('[scheduleComplexEventReminderEmails] No reminder emails configured');
      return result;
    }

    const { data: bookings, error: bookingsError } = await client
      .from('booking')
      .select('id, attendee_email, ticket_class_id')
      .eq('event_id', eventId)
      .neq('status', 'cancelled');

    if (bookingsError) {
      console.error('[scheduleComplexEventReminderEmails] bookings fetch error', bookingsError);
      result.error = bookingsError.message;
      return result;
    }
    result.bookingsConsidered = bookings?.length || 0;

    if (!bookings || bookings.length === 0) {
      console.log('[scheduleComplexEventReminderEmails] No active bookings found');
      for (const email of reminderEmails) {
        result.skipped.push({
          event_email_id: email.id,
          email_type: email.email_type,
          reason: 'no_active_bookings',
        });
      }
      return result;
    }

    const { data: ticketClasses } = await client
      .from('complex_event_ticket_class')
      .select('id, linked_track_ids, all_tracks')
      .eq('complex_event_id', eventId);

    const ticketClassMap = {};
    for (const tc of (ticketClasses || [])) {
      ticketClassMap[tc.id] = tc;
    }

    for (const email of reminderEmails) {
      if (isAbsoluteReminder(email)) {
        const scheduledTime = calculateScheduledTime(null, email);
        if (!scheduledTime || scheduledTime <= new Date()) {
          result.skipped.push({
            event_email_id: email.id,
            email_type: email.email_type,
            reason: 'past_send_time',
          });
          continue;
        }

        for (const booking of bookings) {
          const { data: existing, error: existingError } = await client
            .from('scheduled_email')
            .select('id')
            .eq('event_email_id', email.id)
            .eq('booking_id', booking.id)
            .is('session_id', null)
            .maybeSingle();

          if (existingError) {
            recordWriteFailure(failureBag, email, existingError, booking.id);
            continue;
          }

          if (existing) {
            const { error: updateError } = await client
              .from('scheduled_email')
              .update({
                scheduled_send_time: scheduledTime.toISOString(),
                status: 'pending',
              })
              .eq('id', existing.id);
            if (updateError) {
              recordWriteFailure(failureBag, email, updateError, booking.id);
              continue;
            }
          } else {
            const { error: insertError } = await client
              .from('scheduled_email')
              .insert({
                event_email_id: email.id,
                booking_id: booking.id,
                attendee_email: booking.attendee_email,
                scheduled_send_time: scheduledTime.toISOString(),
                session_id: null,
                status: 'pending',
              });
            if (insertError) {
              recordWriteFailure(failureBag, email, insertError, booking.id);
              continue;
            }
          }

          result.requeued += 1;
          bookingSet.add(booking.id);
        }
        continue;
      }

      // Relative reminder: one per calendar day (event timezone) per booking,
      // anchored to the earliest session that day the booking's ticket class
      // can access. session_id stores the day's anchor session for dedupe.
      let scheduledForThisEmail = 0;
      for (const booking of bookings) {
        const tc = booking.ticket_class_id ? ticketClassMap[booking.ticket_class_id] : null;
        let accessibleSessions = sessionList;
        if (tc && !tc.all_tracks && tc.linked_track_ids?.length > 0) {
          accessibleSessions = sessionList.filter(s => {
            const trackIds = sessionTrackMap[s.id] || [];
            return trackIds.length === 0 ||
              trackIds.some(tid => tc.linked_track_ids.includes(tid));
          });
        }

        const dayAnchors = pickDayAnchorSessions(accessibleSessions, eventTimezone);

        // Reconcile legacy per-session rows: cancel any pending session-bound
        // rows that are not one of the desired day anchors (e.g. rows created
        // by the former per-session scheduler for later same-day sessions, or
        // for sessions the ticket class can no longer access).
        const anchorIds = new Set(dayAnchors.map(a => a.session.id));
        const { data: existingRows, error: existingRowsError } = await client
          .from('scheduled_email')
          .select('id, session_id')
          .eq('event_email_id', email.id)
          .eq('booking_id', booking.id)
          .eq('status', 'pending');
        if (existingRowsError) {
          recordWriteFailure(failureBag, email, existingRowsError, booking.id);
        } else {
          const obsoleteIds = (existingRows || [])
            .filter(r => r.session_id != null && !anchorIds.has(r.session_id))
            .map(r => r.id);
          if (obsoleteIds.length > 0) {
            const { error: cancelError } = await client
              .from('scheduled_email')
              .update({ status: 'cancelled' })
              .in('id', obsoleteIds);
            if (cancelError) {
              recordWriteFailure(failureBag, email, cancelError, booking.id);
            } else {
              console.log(`[scheduleComplexEventReminderEmails] Cancelled ${obsoleteIds.length} obsolete per-session reminder row(s) for booking ${booking.id}`);
            }
          }
        }

        for (const anchor of dayAnchors) {
          const { session, startMs } = anchor;
          const scheduledTime = calculateScheduledTime(new Date(startMs), email);

          if (!scheduledTime || scheduledTime <= new Date()) {
            continue;
          }

          const { data: existing, error: existingError } = await client
            .from('scheduled_email')
            .select('id')
            .eq('event_email_id', email.id)
            .eq('booking_id', booking.id)
            .eq('session_id', session.id)
            .maybeSingle();

          if (existingError) {
            recordWriteFailure(failureBag, email, existingError, booking.id);
            continue;
          }

          if (existing) {
            const { error: updateError } = await client
              .from('scheduled_email')
              .update({
                scheduled_send_time: scheduledTime.toISOString(),
                status: 'pending',
              })
              .eq('id', existing.id);
            if (updateError) {
              recordWriteFailure(failureBag, email, updateError, booking.id);
              continue;
            }
          } else {
            const { error: insertError } = await client
              .from('scheduled_email')
              .insert({
                event_email_id: email.id,
                booking_id: booking.id,
                attendee_email: booking.attendee_email,
                scheduled_send_time: scheduledTime.toISOString(),
                session_id: session.id,
                status: 'pending',
              });
            if (insertError) {
              recordWriteFailure(failureBag, email, insertError, booking.id);
              continue;
            }
          }

          result.requeued += 1;
          bookingSet.add(booking.id);
          scheduledForThisEmail += 1;
        }
      }

      if (scheduledForThisEmail === 0 && !failureBag.has(email.id)) {
        result.skipped.push({
          event_email_id: email.id,
          email_type: email.email_type,
          reason: 'past_send_time',
        });
      }
    }

    result.bookingsScheduled = bookingSet.size;
    result.schedulingFailures = Array.from(failureBag.values());
    console.log(`[scheduleComplexEventReminderEmails] Scheduled ${result.requeued} reminder(s) for complex event ${eventId} across ${result.bookingsScheduled} booking(s); ${result.schedulingFailures.length} failure group(s); ${result.skipped.length} skipped`);
    return result;
  } catch (err) {
    console.error('[scheduleComplexEventReminderEmails] Error:', err);
    result.bookingsScheduled = bookingSet.size;
    result.schedulingFailures = Array.from(failureBag.values());
    result.error = err.message;
    return result;
  }
}

export async function scheduleRemindersForEvent(eventId) {
  const { data: emails } = await supabase
    .from('event_email')
    .select('is_complex_event')
    .eq('event_id', eventId)
    .limit(1);

  let isComplex = !!(emails && emails[0] && emails[0].is_complex_event);

  if (!isComplex) {
    const { data: complexEvent } = await supabase
      .from('complex_event')
      .select('id')
      .eq('id', eventId)
      .maybeSingle();
    if (complexEvent) isComplex = true;
  }

  if (isComplex) {
    return { mode: 'complex', ...(await scheduleComplexEventReminderEmails(eventId)) };
  }
  return { mode: 'standard', ...(await scheduleReminderEmails(eventId)) };
}
