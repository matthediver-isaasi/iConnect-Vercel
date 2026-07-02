#!/usr/bin/env node

/**
 * One-off send the configured reminder email for an event to every
 * active attendee, immediately, ignoring scheduled_email rows.
 *
 * Usage:
 *   node scripts/send-event-reminder-once.mjs [eventId] [--dry-run] [--config-id=<event_email.id>]
 *
 * Env vars required:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, MAILGUN_API_KEY
 *
 * Examples:
 *   node scripts/send-event-reminder-once.mjs --dry-run
 *   node scripts/send-event-reminder-once.mjs 5f2c04d1-75a0-4cdc-869e-badadba9da7a
 */

import { sendEmail } from '../api/_lib/emailService.js';
import { supabase } from '../api/_lib/database.js';
import { fetchComplexEventData, parseCcField } from '../api/_lib/eventConfirmationEmail.js';

const DEFAULT_EVENT_ID = '5f2c04d1-75a0-4cdc-869e-badadba9da7a';

function parseArgs(argv) {
  const args = { eventId: null, dryRun: false, configId: null };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--config-id=')) args.configId = a.slice('--config-id='.length);
    else if (!a.startsWith('--') && !args.eventId) args.eventId = a;
  }
  if (!args.eventId) args.eventId = DEFAULT_EVENT_ID;
  return args;
}

// Helpers below are copied verbatim from api/cron/send-event-reminders.js
// to ensure rendered output matches what the cron would produce.
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
// End of copied helpers.

async function loadEvent(eventId) {
  const { data: regular } = await supabase
    .from('event')
    .select('id, title, start_date, location, is_online, is_complex, zoom_meeting_id, zoom_webinar_id, tenant_id, timezone')
    .eq('id', eventId)
    .maybeSingle();

  if (regular) {
    return { event: regular, isComplexEvent: false };
  }

  const { data: complex } = await supabase
    .from('complex_event')
    .select('id, title, start_date, location, status, timezone, tenant_id')
    .eq('id', eventId)
    .maybeSingle();

  if (complex) {
    return {
      event: {
        ...complex,
        is_complex: true,
        is_online: false,
        zoom_meeting_id: null,
        zoom_webinar_id: null,
      },
      isComplexEvent: true,
    };
  }

  return { event: null, isComplexEvent: false };
}

async function loadReminderConfig(eventId, isComplexEvent, configId) {
  let query = supabase
    .from('event_email')
    .select('*')
    .eq('event_id', eventId)
    .eq('email_type', 'reminder')
    .eq('is_complex_event', isComplexEvent);

  if (configId) {
    query = query.eq('id', configId);
  }

  const { data, error } = await query.order('updated_at', { ascending: false });
  if (error) throw new Error(`Failed to load event_email: ${error.message}`);
  if (!data || data.length === 0) {
    if (configId) {
      throw new Error(`No event_email row for event ${eventId} with id=${configId} and email_type=reminder`);
    }
    throw new Error(`No reminder event_email configured for event ${eventId} (is_complex_event=${isComplexEvent})`);
  }

  if (data.length > 1 && !configId) {
    console.warn(`[send-event-reminder-once] WARN: ${data.length} reminder configs found, using most recently updated (id=${data[0].id}). Pass --config-id=<id> to pick a specific one.`);
  }

  return data[0];
}

async function loadBookings(eventId, isComplexEvent) {
  const table = isComplexEvent ? 'complex_event_booking' : 'booking';
  const { data, error } = await supabase
    .from(table)
    .select('id, attendee_email, attendee_first_name, attendee_last_name, ticket_class_id, ticket_class_name, status')
    .eq('event_id', eventId)
    .neq('status', 'cancelled');

  if (error) throw new Error(`Failed to load bookings from ${table}: ${error.message}`);
  return data || [];
}

async function resolveZoomJoinUrl(event) {
  if (event.zoom_meeting_id) {
    const { data } = await supabase
      .from('zoom_meeting')
      .select('join_url')
      .eq('id', event.zoom_meeting_id)
      .maybeSingle();
    return data?.join_url || null;
  }
  if (event.zoom_webinar_id) {
    const { data } = await supabase
      .from('zoom_webinar')
      .select('join_url')
      .eq('id', event.zoom_webinar_id)
      .maybeSingle();
    return data?.join_url || null;
  }
  return null;
}

async function main() {
  const { eventId, dryRun, configId } = parseArgs(process.argv);

  if (!supabase) {
    console.error('Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.');
    process.exit(1);
  }
  if (!process.env.MAILGUN_API_KEY && !dryRun) {
    console.error('MAILGUN_API_KEY not configured. Set it or use --dry-run.');
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Send event reminder once${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`Event ID: ${eventId}`);
  if (configId) console.log(`Config ID: ${configId}`);
  console.log(`${'='.repeat(60)}\n`);

  const { event, isComplexEvent } = await loadEvent(eventId);
  if (!event) {
    console.error(`Event ${eventId} not found in event or complex_event.`);
    process.exit(1);
  }
  console.log(`Event: "${event.title}" (${isComplexEvent ? 'complex' : 'standard'}, tenant=${event.tenant_id})`);

  const reminderConfig = await loadReminderConfig(eventId, isComplexEvent, configId);
  console.log(`Reminder config: id=${reminderConfig.id}, subject="${reminderConfig.subject}"`);

  const ccList = parseCcField(reminderConfig.cc);
  if (ccList.length > 0) console.log(`CC: ${ccList.join(', ')}`);

  const zoomJoinUrl = await resolveZoomJoinUrl(event);
  event.zoom_join_url = zoomJoinUrl;
  if (zoomJoinUrl) console.log(`Zoom join URL: ${zoomJoinUrl.substring(0, 60)}...`);

  const bookings = await loadBookings(eventId, isComplexEvent);
  console.log(`Found ${bookings.length} active booking(s)\n`);

  const counts = { sent: 0, failed: 0, skipped: 0 };
  let dryRunSamplePrinted = false;

  for (const booking of bookings) {
    if (!booking.attendee_email) {
      console.log(`  [SKIP] booking ${booking.id} has no attendee_email`);
      counts.skipped++;
      continue;
    }

    let complexEventData = null;
    if (event.is_complex) {
      complexEventData = await fetchComplexEventData(
        event.id,
        booking.ticket_class_id,
        booking.ticket_class_name,
        event.tenant_id,
        event.timezone
      );
    }

    const subject = replacePlaceholders(reminderConfig.subject, { event, booking, complexEventData });
    const body = replacePlaceholders(reminderConfig.body, { event, booking, complexEventData });
    const html = formatBodyAsHtml(body);

    if (dryRun) {
      console.log(`  [DRY-RUN] would send to: ${booking.attendee_email} (booking ${booking.id})`);
      if (!dryRunSamplePrinted) {
        console.log(`\n--- Sample rendered email ---`);
        console.log(`To: ${booking.attendee_email}`);
        if (ccList.length > 0) console.log(`Cc: ${ccList.join(', ')}`);
        console.log(`Subject: ${subject}`);
        console.log(`HTML body:\n${html}`);
        console.log(`--- End sample ---\n`);
        dryRunSamplePrinted = true;
      }
      counts.sent++;
      continue;
    }

    try {
      const result = await sendEmail({
        to: booking.attendee_email,
        subject,
        html,
        cc: ccList.length > 0 ? ccList : undefined,
        tenantId: event.tenant_id,
      });

      if (result.success) {
        console.log(`  [SENT] ${booking.attendee_email} (messageId=${result.messageId})`);
        counts.sent++;
      } else {
        console.log(`  [FAIL] ${booking.attendee_email}: ${result.error}`);
        counts.failed++;
      }
    } catch (err) {
      console.log(`  [FAIL] ${booking.attendee_email}: ${err.message}`);
      counts.failed++;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Summary: ${JSON.stringify(counts)}`);
  console.log(`${'='.repeat(60)}\n`);

  if (counts.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
