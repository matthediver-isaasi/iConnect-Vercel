import { sendEmail } from '../_lib/emailService.js';
import { createEventEmailZoomResolver, personaliseEmailZoomTargets } from '../_lib/eventEmailZoomLinks.js';
import { supabase } from '../_lib/database.js';
import { resolveEventEmailSurvey } from '../_lib/campaignEventSurvey.js';
import { buildInboxDelivery } from '../_lib/transactionalInbox.js';
import { fetchComplexEventData, buildSessionScheduleHtml, parseCcField, replacePlaceholders as renderPlaceholders } from '../_lib/eventConfirmationEmail.js';
import { fetchTrainingAgendaData, applyAgendaPlaceholders, safeHttpUrl } from '../_lib/trainingAgenda.js';
import { trainingReminderEvent, validateTrainingReminder } from '../_lib/trainingReminderTargets.js';
import { validateFollowUpDelivery } from '../_lib/eventFollowUps.js';
import { renderFollowUp } from '../_lib/eventFollowUpRendering.js';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
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
          event_survey_assignment_id,
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
    const skipped = [];

    for (const scheduledEmail of pendingEmails) {
      // Use an existing terminal status as a fail-closed claim: a crash or an
      // ambiguous provider outcome requires investigation, never automatic retry.
      const { data: claimed, error: claimError } = await supabase.from('scheduled_email')
        .update({ status: 'failed', error_message: 'Delivery claimed; outcome unknown. Do not re-send without checking delivery history.' })
        .eq('id', scheduledEmail.id).eq('status', 'pending')
        .eq('scheduled_send_time', scheduledEmail.scheduled_send_time).select('id');
      if (claimError || !claimed?.length) continue;
      try {
        const { data: eventEmail, error: configError } = await supabase.from('event_email')
          .select('*').eq('id', scheduledEmail.event_email_id).maybeSingle();
        if (configError) throw configError;
        if (!eventEmail) {
          console.log(`[cron/send-event-reminders] No event_email found for scheduled_email ${scheduledEmail.id}`);
          await markAsFailed(scheduledEmail.id, 'Event email configuration not found');
          failedCount++;
          continue;
        }
        if (eventEmail.email_type === 'follow_up') {
          const { data: row, error: rowError } = await supabase.from('scheduled_email').select('*').eq('id', scheduledEmail.id).single();
          if (rowError) throw rowError;
          const validation = await validateFollowUpDelivery(supabase, row, eventEmail);
          if (validation.reason) {
            await markAsCancelled(row.id, validation.reason);
            skipped.push({ id: row.id, reason: validation.reason });
            continue;
          }
          const rendered = await renderFollowUp(supabase, validation, eventEmail);
          const inboxDelivery = await buildInboxDelivery({ tenantId: validation.event.tenant_id,
            memberId: validation.booking.member_id || null, email: validation.booking.attendee_email, labelKey: 'events' });
          // Re-read authority after rendering/provider-independent lookups.
          const { data: latestConfig, error: latestError } = await supabase.from('event_email').select('*').eq('id', eventEmail.id).maybeSingle();
          if (latestError) throw latestError;
          const latest = latestConfig && await validateFollowUpDelivery(supabase, row, latestConfig);
          if (!latest || latest.reason || JSON.stringify(latestConfig) !== JSON.stringify(eventEmail)) {
            await markAsCancelled(row.id, latest?.reason || 'Follow-up configuration changed during preparation');
            continue;
          }
          const cc = parseCcField(eventEmail.cc);
          const delivery = await sendEmail({ to: validation.booking.attendee_email, ...rendered,
            cc: cc.length ? cc : undefined, tenantId: validation.event.tenant_id, inboxDelivery });
          if (!delivery.success) throw new Error(delivery.error || 'Follow-up delivery outcome unknown');
          const { error: sentError } = await supabase.from('scheduled_email')
            .update({ status: 'sent', sent_at: new Date().toISOString(), error_message: null }).eq('id', row.id).eq('status', 'failed');
          if (sentError) throw new Error('Provider accepted delivery but recording success failed; check delivery history');
          sentCount++;
          continue;
        }
        if (!eventEmail.is_enabled || eventEmail.email_type !== 'reminder') {
          await markAsCancelled(scheduledEmail.id, 'Reminder disabled or no longer a reminder');
          skipped.push({ id: scheduledEmail.id, reason: 'Reminder disabled or no longer a reminder' });
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

        if (booking.status === 'cancelled' || booking.event_id !== eventEmail.event_id) {
          console.log(`[cron/send-event-reminders] Booking ${scheduledEmail.booking_id} is cancelled, skipping`);
          await markAsCancelled(scheduledEmail.id, 'Booking cancelled or no longer belongs to event');
          skipped.push({ id: scheduledEmail.id, reason: 'Booking cancelled or no longer belongs to event' });
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
            .select('id, title, start_date, location, is_online, is_complex, is_training, zoom_meeting_id, zoom_webinar_id, tenant_id, timezone')
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

        // Training events (Task #3419): the reminder row may be bound to one
        // agenda line (scheduled_email.session_id = agenda line id). Fetch
        // agenda context so {{agenda_schedule}} and per-line tokens resolve.
        let trainingAgendaData = null;
        let trainingAgendaLine = null;
        if (!event.is_complex) {
          trainingAgendaData = await fetchTrainingAgendaData(event.id);
          if (event.is_training) {
            if (!trainingAgendaData) throw new Error('Unable to load training agenda; delivery suppressed');
            // Read the additive column only for training events. A deployment
            // ahead of the migration must not stop unrelated event reminders.
            const { data: targetState, error: targetStateError } = await supabase.from('scheduled_email')
              .select('training_target_snapshot').eq('id', scheduledEmail.id).single();
            if (targetStateError) throw new Error('Training reminder target verification unavailable; check the target-snapshot migration before scheduling delivery');
            const validation = validateTrainingReminder(event, eventEmail,
              { ...scheduledEmail, training_target_snapshot: targetState?.training_target_snapshot },
              trainingAgendaData.lines);
            if (validation.reason) {
              await markAsCancelled(scheduledEmail.id, validation.reason);
              skipped.push({ id: scheduledEmail.id, reason: validation.reason });
              continue;
            }
            event = trainingReminderEvent(event, validation.target);
          }
          if (scheduledEmail.session_id && trainingAgendaData?.lines) {
            trainingAgendaLine = trainingAgendaData.lines.find(l => l.id === scheduledEmail.session_id) || null;
            // Prefer the line's own join link for {{zoom_link}} on Online
            // lines (http(s)-validated to keep emails injection-safe).
            const lineJoinUrl = safeHttpUrl(trainingAgendaLine?.zoom_join_url);
            if (lineJoinUrl) {
              event.zoom_join_url = lineJoinUrl;
            }
          }
        }

        const surveyContent = await resolveEventEmailSurvey(supabase, eventEmail, event, isComplexEvent ? 'complex_event' : 'event');
        await personaliseEmailZoomTargets(
          createEventEmailZoomResolver(supabase, event.tenant_id, scheduledEmail.attendee_email),
          event, complexEventData, trainingAgendaData, buildSessionScheduleHtml,
        );
        if (trainingAgendaLine) event.zoom_join_url = trainingAgendaLine.zoom_join_url || '';

        let subject = renderPlaceholders(surveyContent.subject, {
          event,
          booking,
          complexEventData
        });

        let body = renderPlaceholders(surveyContent.body, {
          event,
          booking,
          complexEventData
        });

        if (!event.is_complex) {
          subject = applyAgendaPlaceholders(subject, { agendaData: trainingAgendaData, line: trainingAgendaLine });
          body = applyAgendaPlaceholders(body, { agendaData: trainingAgendaData, line: trainingAgendaLine });
        }

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
          const { error: sentError } = await supabase
            .from('scheduled_email')
            .update({
              status: 'sent',
              sent_at: new Date().toISOString(),
              error_message: null
            })
            .eq('id', scheduledEmail.id);
          if (sentError) throw new Error('Provider accepted delivery but recording success failed; check delivery history');
          
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
      failed: failedCount,
      skipped
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

async function markAsCancelled(emailId, reason = 'Reminder no longer eligible') {
  await supabase
    .from('scheduled_email')
    .update({
      status: 'cancelled',
      error_message: reason
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
