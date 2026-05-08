import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const { eventId } = req.query;

  if (!eventId) {
    return res.status(400).json({ error: 'Event ID is required' });
  }

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('event_email')
        .select('*')
        .eq('event_id', eventId)
        .order('created_at', { ascending: true });

      if (error) {
        console.error('[event-emails] Fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch email configurations' });
      }

      return res.status(200).json(data || []);
    } catch (err) {
      console.error('[event-emails] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'PUT') {
    try {
      const { emails, is_complex_event } = req.body;

      if (!Array.isArray(emails)) {
        return res.status(400).json({ error: 'Emails must be an array' });
      }

      const { data: existingEmails, error: fetchError } = await supabase
        .from('event_email')
        .select('id')
        .eq('event_id', eventId);

      if (fetchError) {
        console.error('[event-emails] Fetch existing error:', fetchError);
        return res.status(500).json({ error: 'Failed to fetch existing emails' });
      }

      const existingIds = new Set(existingEmails?.map(e => e.id) || []);
      const incomingIds = new Set(emails.filter(e => !e.isNew).map(e => e.id));

      const idsToDelete = [...existingIds].filter(id => !incomingIds.has(id));
      if (idsToDelete.length > 0) {
        const { error: deleteError } = await supabase
          .from('event_email')
          .delete()
          .in('id', idsToDelete);

        if (deleteError) {
          console.error('[event-emails] Delete error:', deleteError);
          return res.status(500).json({ error: 'Failed to delete removed email configurations' });
        }
      }

      const ccEmailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      for (const email of emails) {
        if (!email.cc || typeof email.cc !== 'string') continue;
        const parts = email.cc.split(',').map(s => s.trim()).filter(Boolean);
        const invalid = parts.filter(p => !ccEmailRegex.test(p));
        if (invalid.length > 0) {
          return res.status(400).json({
            error: `Invalid CC email address: ${invalid.join(', ')}`
          });
        }
      }

      const savedEmails = [];
      const errors = [];

      for (let i = 0; i < emails.length; i++) {
        const email = emails[i];
        const resolvedUnit = email.timing_type === 'custom' ? (email.custom_unit || 'hours') : null;
        const resolvedSendAt = (email.timing_type === 'custom' && resolvedUnit === 'specific_datetime' && email.custom_send_at)
          ? email.custom_send_at : null;

        const normalizedCc = typeof email.cc === 'string'
          ? email.cc.split(',').map(s => s.trim()).filter(Boolean).join(', ')
          : '';

        const emailData = {
          event_id: eventId,
          email_type: email.email_type,
          timing_type: email.timing_type || null,
          custom_hours_before: email.custom_hours_before || null,
          custom_unit: resolvedUnit,
          custom_send_at: resolvedSendAt,
          subject: email.subject,
          body: email.body,
          cc: normalizedCc || null,
          is_enabled: email.is_enabled !== false,
          is_complex_event: is_complex_event || false,
          updated_at: new Date().toISOString()
        };

        if (email.isNew || !existingIds.has(email.id)) {
          const { data: inserted, error: insertError } = await supabase
            .from('event_email')
            .insert(emailData)
            .select()
            .single();

          if (insertError) {
            console.error('[event-emails] Insert error:', insertError);
            errors.push({ email_type: email.email_type, error: insertError.message, request_index: i });
            continue;
          }
          savedEmails.push(inserted);
        } else {
          const { data: updated, error: updateError } = await supabase
            .from('event_email')
            .update(emailData)
            .eq('id', email.id)
            .select()
            .single();

          if (updateError) {
            console.error('[event-emails] Update error:', updateError);
            errors.push({ email_type: email.email_type, error: updateError.message, request_index: i });
            continue;
          }
          savedEmails.push(updated);
        }
      }

      if (errors.length > 0) {
        console.error('[event-emails] Failed to save some emails:', errors);
        return res.status(500).json({ 
          error: `Failed to save ${errors.length} email configuration(s)`,
          details: errors,
          savedEmails 
        });
      }

      if (is_complex_event) {
        await scheduleComplexEventReminderEmails(eventId);
      } else {
        await scheduleReminderEmails(eventId);
      }

      return res.status(200).json(savedEmails);
    } catch (err) {
      console.error('[event-emails] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function scheduleReminderEmails(eventId) {
  try {
    const { data: event, error: eventError } = await supabase
      .from('event')
      .select('id, start_date, title')
      .eq('id', eventId)
      .single();

    if (eventError || !event) {
      console.log('[scheduleReminderEmails] No event found');
      return;
    }

    const { data: reminderEmails, error: emailsError } = await supabase
      .from('event_email')
      .select('*')
      .eq('event_id', eventId)
      .eq('email_type', 'reminder')
      .eq('is_enabled', true);

    if (emailsError || !reminderEmails || reminderEmails.length === 0) {
      console.log('[scheduleReminderEmails] No reminder emails configured');
      return;
    }

    const { data: bookings, error: bookingsError } = await supabase
      .from('booking')
      .select('id, attendee_email')
      .eq('event_id', eventId)
      .neq('status', 'cancelled');

    if (bookingsError || !bookings || bookings.length === 0) {
      console.log('[scheduleReminderEmails] No active bookings found');
      return;
    }

    const eventStart = event.start_date ? new Date(event.start_date) : null;

    for (const email of reminderEmails) {
      const isAbsolute = isAbsoluteReminder(email);
      if (!isAbsolute && !eventStart) {
        console.log('[scheduleReminderEmails] Skipping relative reminder; event has no start_date');
        continue;
      }
      const scheduledTime = calculateScheduledTime(eventStart, email);

      if (!scheduledTime || scheduledTime <= new Date()) {
        continue;
      }

      for (const booking of bookings) {
        const { data: existing } = await supabase
          .from('scheduled_email')
          .select('id')
          .eq('event_email_id', email.id)
          .eq('booking_id', booking.id)
          .single();

        if (existing) {
          await supabase
            .from('scheduled_email')
            .update({ 
              scheduled_send_time: scheduledTime.toISOString(),
              status: 'pending'
            })
            .eq('id', existing.id);
        } else {
          await supabase
            .from('scheduled_email')
            .insert({
              event_email_id: email.id,
              booking_id: booking.id,
              attendee_email: booking.attendee_email,
              scheduled_send_time: scheduledTime.toISOString(),
              status: 'pending'
            });
        }
      }
    }

    console.log(`[scheduleReminderEmails] Scheduled reminders for event ${eventId}`);
  } catch (err) {
    console.error('[scheduleReminderEmails] Error:', err);
  }
}

async function scheduleComplexEventReminderEmails(eventId) {
  try {
    const { data: sessions, error: sessionsError } = await supabase
      .from('complex_event_session')
      .select('id, title, start_time')
      .eq('complex_event_id', eventId)
      .order('start_time', { ascending: true });

    if (sessionsError || !sessions || sessions.length === 0) {
      console.log('[scheduleComplexEventReminderEmails] No sessions found for complex event');
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

    const { data: reminderEmails, error: emailsError } = await supabase
      .from('event_email')
      .select('*')
      .eq('event_id', eventId)
      .eq('email_type', 'reminder')
      .eq('is_enabled', true);

    if (emailsError || !reminderEmails || reminderEmails.length === 0) {
      console.log('[scheduleComplexEventReminderEmails] No reminder emails configured');
      return;
    }

    const { data: bookings, error: bookingsError } = await supabase
      .from('booking')
      .select('id, attendee_email, ticket_class_id')
      .eq('event_id', eventId)
      .neq('status', 'cancelled');

    if (bookingsError || !bookings || bookings.length === 0) {
      console.log('[scheduleComplexEventReminderEmails] No active bookings found');
      return;
    }

    const { data: ticketClasses } = await supabase
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
          continue;
        }

        for (const booking of bookings) {
          const { data: existing } = await supabase
            .from('scheduled_email')
            .select('id')
            .eq('event_email_id', email.id)
            .eq('booking_id', booking.id)
            .is('session_id', null)
            .maybeSingle();

          if (existing) {
            await supabase
              .from('scheduled_email')
              .update({
                scheduled_send_time: scheduledTime.toISOString(),
                status: 'pending'
              })
              .eq('id', existing.id);
          } else {
            await supabase
              .from('scheduled_email')
              .insert({
                event_email_id: email.id,
                booking_id: booking.id,
                attendee_email: booking.attendee_email,
                scheduled_send_time: scheduledTime.toISOString(),
                session_id: null,
                status: 'pending'
              });
          }
        }
        continue;
      }

      for (const session of sessions) {
        if (!session.start_time) continue;

        const sessionStart = new Date(session.start_time);
        const scheduledTime = calculateScheduledTime(sessionStart, email);

        if (!scheduledTime || scheduledTime <= new Date()) {
          continue;
        }

        const sessionTrackIds = sessionTrackMap[session.id] || [];

        for (const booking of bookings) {
          const tc = booking.ticket_class_id ? ticketClassMap[booking.ticket_class_id] : null;
          if (tc && !tc.all_tracks && tc.linked_track_ids?.length > 0) {
            const hasAccess = sessionTrackIds.length === 0 || 
              sessionTrackIds.some(tid => tc.linked_track_ids.includes(tid));
            if (!hasAccess) continue;
          }

          const { data: existing } = await supabase
            .from('scheduled_email')
            .select('id')
            .eq('event_email_id', email.id)
            .eq('booking_id', booking.id)
            .eq('session_id', session.id)
            .maybeSingle();

          if (existing) {
            await supabase
              .from('scheduled_email')
              .update({
                scheduled_send_time: scheduledTime.toISOString(),
                status: 'pending'
              })
              .eq('id', existing.id);
          } else {
            await supabase
              .from('scheduled_email')
              .insert({
                event_email_id: email.id,
                booking_id: booking.id,
                attendee_email: booking.attendee_email,
                scheduled_send_time: scheduledTime.toISOString(),
                session_id: session.id,
                status: 'pending'
              });
          }
        }
      }
    }

    console.log(`[scheduleComplexEventReminderEmails] Scheduled per-session reminders for complex event ${eventId}`);
  } catch (err) {
    console.error('[scheduleComplexEventReminderEmails] Error:', err);
  }
}

function isAbsoluteReminder(email) {
  return (
    email &&
    email.timing_type === 'custom' &&
    email.custom_unit === 'specific_datetime' &&
    !!email.custom_send_at
  );
}

function calculateScheduledTime(eventStart, email) {
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

function getHoursFromTimingType(timingType, customValue, customUnit) {
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
