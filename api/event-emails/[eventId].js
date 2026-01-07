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
      const { emails } = req.body;

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
        }
      }

      const savedEmails = [];

      for (const email of emails) {
        const emailData = {
          event_id: eventId,
          email_type: email.email_type,
          timing_type: email.timing_type || null,
          custom_hours_before: email.custom_hours_before || null,
          subject: email.subject,
          body: email.body,
          is_enabled: email.is_enabled !== false,
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
            continue;
          }
          savedEmails.push(updated);
        }
      }

      await scheduleReminderEmails(eventId);

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

    if (eventError || !event || !event.start_date) {
      console.log('[scheduleReminderEmails] No event or start_date found');
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

    const eventStart = new Date(event.start_date);
    
    for (const email of reminderEmails) {
      const hoursBeforeEvent = getHoursFromTimingType(email.timing_type, email.custom_hours_before);
      const scheduledTime = new Date(eventStart.getTime() - hoursBeforeEvent * 60 * 60 * 1000);

      if (scheduledTime <= new Date()) {
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

function getHoursFromTimingType(timingType, customHours) {
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
