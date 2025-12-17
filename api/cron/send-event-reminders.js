import { createClient } from '@supabase/supabase-js';
import { sendEmail } from '../_lib/emailService.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/send-event-reminders] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const now = new Date();
    const { data: pendingEmails, error: fetchError } = await supabase
      .from('scheduled_email')
      .select(`
        id,
        event_email_id,
        booking_id,
        attendee_email,
        scheduled_send_time,
        event_email:event_email_id (
          id,
          subject,
          body,
          event_id
        )
      `)
      .eq('status', 'pending')
      .lte('scheduled_send_time', now.toISOString())
      .order('scheduled_send_time', { ascending: true })
      .limit(50);

    if (fetchError) {
      console.error('[cron/send-event-reminders] Fetch error:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch pending emails' });
    }

    if (!pendingEmails || pendingEmails.length === 0) {
      console.log('[cron/send-event-reminders] No pending emails to send');
      return res.status(200).json({ message: 'No pending emails', sent: 0 });
    }

    console.log(`[cron/send-event-reminders] Processing ${pendingEmails.length} pending emails`);

    let sentCount = 0;
    let failedCount = 0;

    for (const scheduledEmail of pendingEmails) {
      try {
        const eventEmail = scheduledEmail.event_email;
        if (!eventEmail) {
          console.log(`[cron/send-event-reminders] No event_email found for scheduled_email ${scheduledEmail.id}`);
          await markAsFailed(scheduledEmail.id, 'Event email configuration not found');
          failedCount++;
          continue;
        }

        const { data: booking, error: bookingError } = await supabase
          .from('booking')
          .select(`
            id,
            attendee_email,
            attendee_first_name,
            attendee_last_name,
            event_id,
            status
          `)
          .eq('id', scheduledEmail.booking_id)
          .single();

        if (bookingError) {
          // PGRST116 = "The result contains 0 rows" - treat as not found
          if (bookingError.code === 'PGRST116') {
            console.log(`[cron/send-event-reminders] Booking ${scheduledEmail.booking_id} not found in database`);
            await markAsFailed(scheduledEmail.id, 'Booking not found (may have been deleted)');
          } else {
            console.log(`[cron/send-event-reminders] Booking lookup error for ${scheduledEmail.booking_id}:`, bookingError.message, bookingError.code);
            await markAsFailed(scheduledEmail.id, `Booking lookup failed: ${bookingError.message}`);
          }
          failedCount++;
          continue;
        }

        if (!booking) {
          console.log(`[cron/send-event-reminders] Booking ${scheduledEmail.booking_id} not found (no data returned)`);
          await markAsFailed(scheduledEmail.id, 'Booking not found');
          failedCount++;
          continue;
        }

        if (booking.status === 'cancelled') {
          console.log(`[cron/send-event-reminders] Booking ${scheduledEmail.booking_id} is cancelled, skipping`);
          await markAsCancelled(scheduledEmail.id);
          continue;
        }

        const { data: event, error: eventError } = await supabase
          .from('event')
          .select('id, title, start_date, location, is_online')
          .eq('id', eventEmail.event_id)
          .single();

        if (eventError || !event) {
          console.log(`[cron/send-event-reminders] Event not found for ${eventEmail.event_id}`);
          await markAsFailed(scheduledEmail.id, 'Event not found');
          failedCount++;
          continue;
        }

        const subject = replacePlaceholders(eventEmail.subject, {
          event,
          booking
        });

        const body = replacePlaceholders(eventEmail.body, {
          event,
          booking
        });

        const emailResult = await sendEmail({
          to: scheduledEmail.attendee_email,
          subject: subject,
          html: formatBodyAsHtml(body)
        });

        if (emailResult.success) {
          await supabase
            .from('scheduled_email')
            .update({
              status: 'sent',
              sent_at: new Date().toISOString()
            })
            .eq('id', scheduledEmail.id);
          
          sentCount++;
          console.log(`[cron/send-event-reminders] Sent reminder to ${scheduledEmail.attendee_email}`);
        } else {
          await markAsFailed(scheduledEmail.id, emailResult.error || 'Send failed');
          failedCount++;
        }

      } catch (err) {
        console.error(`[cron/send-event-reminders] Error processing email ${scheduledEmail.id}:`, err);
        await markAsFailed(scheduledEmail.id, err.message);
        failedCount++;
      }
    }

    console.log(`[cron/send-event-reminders] Complete: ${sentCount} sent, ${failedCount} failed`);
    
    return res.status(200).json({
      message: 'Reminder emails processed',
      sent: sentCount,
      failed: failedCount
    });

  } catch (err) {
    console.error('[cron/send-event-reminders] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function markAsFailed(emailId, errorMessage) {
  await supabase
    .from('scheduled_email')
    .update({
      status: 'failed',
      error_message: errorMessage
    })
    .eq('id', emailId);
}

async function markAsCancelled(emailId) {
  await supabase
    .from('scheduled_email')
    .update({
      status: 'cancelled'
    })
    .eq('id', emailId);
}

function replacePlaceholders(template, data) {
  const { event, booking } = data;
  
  let result = template;
  
  result = result.replace(/\{\{event_name\}\}/gi, event.title || '');
  result = result.replace(/\{\{event_date\}\}/gi, formatEventDate(event.start_date));
  result = result.replace(/\{\{event_location\}\}/gi, event.is_online ? 'Online Event' : (event.location || ''));
  result = result.replace(/\{\{attendee_first_name\}\}/gi, booking.attendee_first_name || '');
  result = result.replace(/\{\{attendee_last_name\}\}/gi, booking.attendee_last_name || '');
  
  // Handle zoom link - check event first, then booking (if field exists)
  const zoomLink = event.zoom_join_url || booking.zoom_join_url || '';
  if (zoomLink) {
    result = result.replace(/\{\{#zoom_link\}\}([\s\S]*?)\{\{\/zoom_link\}\}/gi, '$1');
    result = result.replace(/\{\{zoom_link\}\}/gi, zoomLink);
  } else {
    result = result.replace(/\{\{#zoom_link\}\}[\s\S]*?\{\{\/zoom_link\}\}/gi, '');
    result = result.replace(/\{\{zoom_link\}\}/gi, '');
  }
  
  return result;
}

function formatEventDate(dateStr) {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return date.toLocaleString('en-GB', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short'
    });
  } catch {
    return dateStr;
  }
}

function formatBodyAsHtml(body) {
  let html = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
    .replace(/(https?:\/\/[^\s<]+)/gi, '<a href="$1">$1</a>');
  
  return `<div style="font-family: Arial, sans-serif; line-height: 1.6;">${html}</div>`;
}
