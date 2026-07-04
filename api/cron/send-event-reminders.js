import { sendEmail } from '../_lib/emailService.js';
import { supabase } from '../_lib/database.js';
import { buildInboxDelivery } from '../_lib/transactionalInbox.js';
import { fetchComplexEventData, parseCcField } from '../_lib/eventConfirmationEmail.js';

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
        session_id,
        event_email:event_email_id (
          id,
          subject,
          body,
          cc,
          event_id,
          is_complex_event
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

        let booking = null;
        const { data: standardBooking, error: bookingError } = await supabase
          .from('booking')
          .select(`
            id,
            attendee_email,
            attendee_first_name,
            attendee_last_name,
            event_id,
            status,
            ticket_class_id,
            ticket_class_name
          `)
          .eq('id', scheduledEmail.booking_id)
          .single();

        if (!bookingError && standardBooking) {
          booking = standardBooking;
        } else {
          const { data: complexBooking, error: complexBookingError } = await supabase
            .from('complex_event_booking')
            .select(`
              id,
              attendee_email,
              attendee_first_name,
              attendee_last_name,
              event_id,
              status,
              ticket_class_id,
              ticket_class_name
            `)
            .eq('id', scheduledEmail.booking_id)
            .single();

          if (!complexBookingError && complexBooking) {
            booking = complexBooking;
          }
        }

        if (!booking) {
          console.log(`[cron/send-event-reminders] Booking ${scheduledEmail.booking_id} not found in booking or complex_event_booking`);
          await markAsFailed(scheduledEmail.id, 'Booking not found (may have been deleted)');
          failedCount++;
          continue;
        }

        if (booking.status === 'cancelled') {
          console.log(`[cron/send-event-reminders] Booking ${scheduledEmail.booking_id} is cancelled, skipping`);
          await markAsCancelled(scheduledEmail.id);
          continue;
        }

        let event = null;
        const isComplexEvent = eventEmail.is_complex_event || false;

        if (isComplexEvent) {
          const { data: complexEvent, error: complexError } = await supabase
            .from('complex_event')
            .select('id, title, start_date, location, status, timezone, tenant_id')
            .eq('id', eventEmail.event_id)
            .single();

          if (complexError || !complexEvent) {
            console.log(`[cron/send-event-reminders] Complex event not found for ${eventEmail.event_id}`);
            await markAsFailed(scheduledEmail.id, 'Complex event not found');
            failedCount++;
            continue;
          }

          event = {
            ...complexEvent,
            is_complex: true,
            is_online: false,
            zoom_meeting_id: null,
            zoom_webinar_id: null
          };
        } else {
          const { data: regularEvent, error: eventError } = await supabase
            .from('event')
            .select('id, title, start_date, location, is_online, is_complex, zoom_meeting_id, zoom_webinar_id, tenant_id, timezone')
            .eq('id', eventEmail.event_id)
            .single();

          if (eventError || !regularEvent) {
            console.log(`[cron/send-event-reminders] Event not found for ${eventEmail.event_id}`);
            await markAsFailed(scheduledEmail.id, 'Event not found');
            failedCount++;
            continue;
          }
          event = regularEvent;
        }

        let zoomJoinUrl = null;
        if (event.zoom_meeting_id) {
          const { data: zoomMeeting } = await supabase
            .from('zoom_meeting')
            .select('join_url')
            .eq('id', event.zoom_meeting_id)
            .single();
          zoomJoinUrl = zoomMeeting?.join_url;
        } else if (event.zoom_webinar_id) {
          const { data: zoomWebinar } = await supabase
            .from('zoom_webinar')
            .select('join_url')
            .eq('id', event.zoom_webinar_id)
            .single();
          zoomJoinUrl = zoomWebinar?.join_url;
        }
        
        event.zoom_join_url = zoomJoinUrl;

        let complexEventData = null;
        if (event.is_complex) {
          complexEventData = await fetchComplexEventData(
            event.id,
            booking.ticket_class_id,
            booking.ticket_class_name,
            event.tenant_id,
            event.timezone
          );
          console.log(`[cron/send-event-reminders] Fetched complex event data: ${complexEventData?.sessions?.length || 0} sessions`);
        }

        const subject = replacePlaceholders(eventEmail.subject, {
          event,
          booking,
          complexEventData
        });

        const body = replacePlaceholders(eventEmail.body, {
          event,
          booking,
          complexEventData
        });

        const ccList = parseCcField(eventEmail.cc);

        const inboxDelivery = await buildInboxDelivery({
          tenantId: event.tenant_id,
          memberId: booking?.member_id || null,
          email: scheduledEmail.attendee_email,
          labelKey: 'events',
        });

        const emailResult = await sendEmail({
          to: scheduledEmail.attendee_email,
          subject: subject,
          html: formatBodyAsHtml(body),
          cc: ccList.length > 0 ? ccList : undefined,
          tenantId: event.tenant_id,
          inboxDelivery,
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
  const { event, booking, complexEventData } = data;
  
  let result = template;
  
  result = result.replace(/\{\{event_name\}\}/gi, event.title || '');
  result = result.replace(/\{\{event_date\}\}/gi, formatEventDate(event.start_date, event.timezone));
  result = result.replace(/\{\{event_location\}\}/gi, event.is_online ? 'Online Event' : (event.location || ''));
  result = result.replace(/\{\{attendee_first_name\}\}/gi, booking.attendee_first_name || '');
  result = result.replace(/\{\{attendee_last_name\}\}/gi, booking.attendee_last_name || '');
  
  result = result.replace(/\[\[member\.first_name\]\]/gi, booking.attendee_first_name || '');
  result = result.replace(/\[\[member\.last_name\]\]/gi, booking.attendee_last_name || '');
  result = result.replace(/\[\[member\.email\]\]/gi, booking.attendee_email || '');
  result = result.replace(/\[\[attendee\.first_name\]\]/gi, booking.attendee_first_name || '');
  result = result.replace(/\[\[attendee\.last_name\]\]/gi, booking.attendee_last_name || '');
  result = result.replace(/\[\[attendee\.email\]\]/gi, booking.attendee_email || '');
  
  result = result.replace(/\[\[event\.name\]\]/gi, event.title || '');
  result = result.replace(/\[\[event\.title\]\]/gi, event.title || '');
  result = result.replace(/\[\[event\.date\]\]/gi, formatEventDate(event.start_date, event.timezone));
  result = result.replace(/\[\[event\.location\]\]/gi, event.is_online ? 'Online Event' : (event.location || ''));
  
  const zoomLink = event.zoom_join_url || booking.zoom_join_url || '';
  if (zoomLink) {
    result = result.replace(/\{\{#zoom_link\}\}([\s\S]*?)\{\{\/zoom_link\}\}/gi, '$1');
    result = result.replace(/\{\{zoom_link\}\}/gi, zoomLink);
    result = result.replace(/\[\[zoom_link\]\]/gi, zoomLink);
  } else {
    result = result.replace(/\{\{#zoom_link\}\}[\s\S]*?\{\{\/zoom_link\}\}/gi, '');
    result = result.replace(/\{\{zoom_link\}\}/gi, '');
    result = result.replace(/\[\[zoom_link\]\]/gi, '');
  }

  if (complexEventData) {
    const scheduleHtml = complexEventData.sessionScheduleHtml || '';
    const trackList = (complexEventData.accessibleTracks || []).join(', ');

    if (scheduleHtml) {
      result = result.replace(/\{\{#session_schedule\}\}([\s\S]*?)\{\{\/session_schedule\}\}/gi, '$1');
    } else {
      result = result.replace(/\{\{#session_schedule\}\}[\s\S]*?\{\{\/session_schedule\}\}/gi, '');
    }
    result = result.replace(/\{\{session_schedule\}\}/gi, scheduleHtml);
    result = result.replace(/\[\[session_schedule\]\]/gi, scheduleHtml);
    result = result.replace(/\{\{track_name\}\}/gi, trackList);
    result = result.replace(/\[\[booking\.track_name\]\]/gi, trackList);
    result = result.replace(/\[\[track_name\]\]/gi, trackList);

    const sessionZoomLinks = (complexEventData.sessions || [])
      .filter(s => s.zoom_join_url)
      .map(s => `${s.title}: ${s.zoom_join_url}`)
      .join('\n');
    result = result.replace(/\{\{session_zoom_links\}\}/gi, sessionZoomLinks);
    result = result.replace(/\[\[session_zoom_links\]\]/gi, sessionZoomLinks);
  } else {
    result = result.replace(/\{\{#session_schedule\}\}[\s\S]*?\{\{\/session_schedule\}\}/gi, '');
    result = result.replace(/\{\{session_schedule\}\}/gi, '');
    result = result.replace(/\[\[session_schedule\]\]/gi, '');
    result = result.replace(/\{\{track_name\}\}/gi, '');
    result = result.replace(/\[\[booking\.track_name\]\]/gi, '');
    result = result.replace(/\[\[track_name\]\]/gi, '');
    result = result.replace(/\{\{session_zoom_links\}\}/gi, '');
    result = result.replace(/\[\[session_zoom_links\]\]/gi, '');
  }
  
  return result;
}

function formatEventDate(dateStr, timeZone = 'UTC') {
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
      timeZoneName: 'short',
      timeZone: timeZone || 'UTC'
    });
  } catch {
    return dateStr;
  }
}

function formatBodyAsHtml(body) {
  if (!body) return '';
  
  const hasHtmlTags = /<[a-z][\s\S]*>/i.test(body);
  
  if (hasHtmlTags) {
    return `<div style="font-family: Arial, sans-serif; line-height: 1.6;">${body}</div>`;
  }
  
  let html = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
    .replace(/(https?:\/\/[^\s<]+)/gi, '<a href="$1">$1</a>');
  
  return `<div style="font-family: Arial, sans-serif; line-height: 1.6;">${html}</div>`;
}
