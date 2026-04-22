import { supabase } from './database.js';
import { sendEmail } from './emailService.js';
import { buildIcs, buildEventUid, buildSessionUid } from './icsBuilder.js';

export function parseCcField(cc) {
  if (!cc || typeof cc !== 'string') return [];
  return cc.split(',').map(s => s.trim()).filter(Boolean);
}

export async function sendConfirmationEmailsFromTemplate(eventId, booking, attendee, personalizedZoomUrl = null, pricingDetails = null, tenantId = null) {
  if (!supabase) return [];

  const results = [];

  try {
    const { data: confirmationEmails, error: emailsError } = await supabase
      .from('event_email')
      .select('*')
      .eq('event_id', eventId)
      .in('email_type', ['confirmation', 'booking_confirmation'])
      .eq('is_enabled', true);

    if (emailsError || !confirmationEmails || confirmationEmails.length === 0) {
      console.log('[sendConfirmationEmailsFromTemplate] No confirmation emails configured for event');
      return results;
    }

    console.log(`[sendConfirmationEmailsFromTemplate] Found ${confirmationEmails.length} confirmation email(s) to send`);

    let eventQuery = supabase
      .from('event')
      .select('id, title, description, start_date, end_date, location, is_online, is_complex, zoom_meeting_id, zoom_webinar_id, tenant_id, timezone')
      .eq('id', eventId);
    if (tenantId) {
      eventQuery = eventQuery.eq('tenant_id', tenantId);
    }
    let { data: event, error: eventError } = await eventQuery.single();

    if (eventError || !event) {
      let complexQuery = supabase
        .from('complex_event')
        .select('id, title, description, start_date, end_date, location, is_online, tenant_id, timezone')
        .eq('id', eventId);
      if (tenantId) {
        complexQuery = complexQuery.eq('tenant_id', tenantId);
      }
      const { data: complexEvent, error: complexError } = await complexQuery.single();
      if (complexError || !complexEvent) {
        console.error(`[sendConfirmationEmailsFromTemplate] Event not found in event or complex_event | eventId: ${eventId} | tenantId: ${tenantId || 'not provided'}`);
        return results;
      }
      event = { ...complexEvent, is_complex: true, zoom_meeting_id: null, zoom_webinar_id: null };
    }

    let zoomJoinUrl = personalizedZoomUrl;
    if (!zoomJoinUrl) {
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
    }

    event.zoom_join_url = zoomJoinUrl;

    if (zoomJoinUrl) {
      console.log(`[sendConfirmationEmailsFromTemplate] Using Zoom link for ${attendee?.email || booking?.attendee_email}: ${zoomJoinUrl.substring(0, 50)}...`);
    }

    let complexEventData = null;
    if (event.is_complex) {
      complexEventData = await fetchComplexEventData(eventId, booking?.ticket_class_id || booking?.ticketClassId, booking?.ticket_class_name || booking?.ticketClassName, event.tenant_id, event.timezone);
    }

    const icsAttachment = buildIcsAttachment(event, booking, complexEventData);

    const bookingData = {
      id: booking?.id || '',
      attendee_first_name: attendee?.first_name || booking?.attendee_first_name || '',
      attendee_last_name: attendee?.last_name || booking?.attendee_last_name || '',
      attendee_email: attendee?.email || booking?.attendee_email || '',
      booking_reference: booking?.booking_reference || '',
      ticket_price: booking?.ticket_price || 0,
      total_cost: booking?.total_cost || 0,
      ticket_class_name: booking?.ticket_class_name || 'Standard',
      pricingDetails: pricingDetails || null
    };

    for (const emailConfig of confirmationEmails) {
      try {
        const subject = replacePlaceholders(emailConfig.subject, { event, booking: bookingData, complexEventData });
        const body = replacePlaceholders(emailConfig.body, { event, booking: bookingData, complexEventData });

        const ccList = parseCcField(emailConfig.cc);

        const emailResult = await sendEmail({
          to: bookingData.attendee_email,
          subject: subject,
          html: formatBodyAsHtml(body),
          cc: ccList.length > 0 ? ccList : undefined,
          tenantId: event.tenant_id,
          attachments: icsAttachment ? [icsAttachment] : undefined
        });

        if (emailResult.success) {
          console.log(`[sendConfirmationEmailsFromTemplate] Sent confirmation to ${bookingData.attendee_email}`);
          results.push({ email: bookingData.attendee_email, success: true, ...emailResult });
        } else {
          console.error(`[sendConfirmationEmailsFromTemplate] Failed to send to ${bookingData.attendee_email}:`, emailResult.error);
          results.push({ email: bookingData.attendee_email, success: false, error: emailResult.error });
        }
      } catch (err) {
        console.error(`[sendConfirmationEmailsFromTemplate] Error sending confirmation:`, err.message);
        results.push({ email: bookingData.attendee_email, success: false, error: err.message });
      }
    }

  } catch (err) {
    console.error('[sendConfirmationEmailsFromTemplate] Error:', err.message);
  }

  return results;
}

function buildIcsAttachment(event, booking, complexEventData) {
  try {
    const bookingId = booking?.id || '';
    const entries = [];

    if (event?.is_complex) {
      const sessions = complexEventData?.sessions || [];
      for (const s of sessions) {
        if (!s.start_time || !s.end_time) continue;
        const isVirtual = s.delivery_mode === 'virtual';
        const sessionUrl = s.zoom_join_url || '';
        const location = isVirtual
          ? (sessionUrl || 'Online')
          : (s.location || '');
        entries.push({
          uid: buildSessionUid(bookingId, s.id),
          title: [event.title, s.title].filter(Boolean).join(' — ') || 'Event',
          description: s.description || '',
          start: s.start_time,
          end: s.end_time,
          location,
          url: sessionUrl || undefined,
          timeZone: s.timezone || event.timezone || undefined,
        });
      }
      if (entries.length === 0) {
        console.warn('[buildIcsAttachment] Skipping ICS — complex event has no accessible sessions with valid times');
        return null;
      }
    } else {
      if (!event?.start_date || !event?.end_date) {
        console.warn('[buildIcsAttachment] Skipping ICS — event missing start/end date');
        return null;
      }
      const isOnline = !!event.is_online;
      const url = event.zoom_join_url || '';
      const location = isOnline ? (url || 'Online') : (event.location || '');
      entries.push({
        uid: buildEventUid(bookingId, event.id),
        title: event.title || 'Event',
        description: event.description || '',
        start: event.start_date,
        end: event.end_date,
        location,
        url: url || undefined,
        timeZone: event.timezone || undefined,
      });
    }

    const ics = buildIcs(entries);
    if (!ics) {
      console.warn('[buildIcsAttachment] No valid entries for ICS attachment');
      return null;
    }

    return {
      filename: 'event.ics',
      data: Buffer.from(ics, 'utf8'),
      contentType: 'text/calendar; method=PUBLISH; charset=utf-8',
    };
  } catch (err) {
    console.error('[buildIcsAttachment] Failed to build ICS attachment:', err.message);
    return null;
  }
}

async function fetchComplexEventData(eventId, ticketClassId, ticketClassName, tenantId, eventTimezone = null) {
  try {
    let ticketClass = null;
    if (ticketClassId) {
      const { data } = await supabase
        .from('complex_event_ticket_class')
        .select('id, name, linked_track_ids, all_tracks')
        .eq('id', ticketClassId)
        .eq('complex_event_id', eventId)
        .maybeSingle();
      ticketClass = data;
    }

    let sessionQuery = supabase
      .from('complex_event_session')
      .select('id, title, description, start_time, end_time, delivery_mode, track_name, zoom_join_url, zoom_webinar_id, zoom_meeting_id, location, timezone')
      .eq('event_id', eventId)
      .eq('status', 'scheduled')
      .order('start_time', { ascending: true })
      .order('sort_order', { ascending: true });

    if (tenantId) {
      sessionQuery = sessionQuery.eq('tenant_id', tenantId);
    }

    const { data: sessions } = await sessionQuery;

    if (!sessions || sessions.length === 0) {
      return { sessions: [], ticketClass, accessibleTracks: [], sessionScheduleHtml: '' };
    }

    let accessibleSessions = sessions;
    const accessibleTracks = [];

    if (ticketClass && !ticketClass.all_tracks && ticketClass.linked_track_ids?.length > 0) {
      const { data: tracks } = await supabase
        .from('complex_event_track')
        .select('id, name')
        .in('id', ticketClass.linked_track_ids);

      const trackNames = (tracks || []).map(t => t.name?.trim().toLowerCase());
      accessibleTracks.push(...(tracks || []).map(t => t.name));

      accessibleSessions = sessions.filter(s => {
        if (!s.track_name) return true;
        return trackNames.includes(s.track_name.trim().toLowerCase());
      });
    } else {
      const uniqueTracks = [...new Set(sessions.map(s => s.track_name).filter(Boolean))];
      accessibleTracks.push(...uniqueTracks);
    }

    const sessionScheduleHtml = buildSessionScheduleHtml(accessibleSessions, eventTimezone);

    return {
      sessions: accessibleSessions,
      ticketClass,
      accessibleTracks,
      sessionScheduleHtml
    };
  } catch (err) {
    console.error('[fetchComplexEventData] Error:', err.message);
    return { sessions: [], ticketClass: null, accessibleTracks: [], sessionScheduleHtml: '' };
  }
}

function buildSessionScheduleHtml(sessions, eventTimezone = null) {
  if (!sessions || sessions.length === 0) return '';

  const rows = sessions.map(s => {
    const tz = s.timezone || eventTimezone || 'UTC';
    const startTime = s.start_time ? formatSessionTime(s.start_time, tz) : 'TBC';
    const endTime = s.end_time ? formatSessionTime(s.end_time, tz) : '';
    const timeRange = endTime ? `${startTime} - ${endTime}` : startTime;
    const locationStr = s.delivery_mode === 'virtual' ? 'Online' : (s.location || '');
    const zoomLink = s.zoom_join_url || '';

    let locationCell = locationStr;
    if (zoomLink) {
      locationCell = `<a href="${zoomLink}" style="color: #2563eb; text-decoration: underline;">Join via Zoom</a>`;
      if (locationStr && s.delivery_mode === 'hybrid') {
        locationCell = `${locationStr} / ${locationCell}`;
      }
    }

    const trackBadge = s.track_name ? `<span style="display:inline-block;background:#e5e7eb;border-radius:4px;padding:1px 6px;font-size:11px;margin-left:4px;">${s.track_name}</span>` : '';

    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;white-space:nowrap;vertical-align:top;">${timeRange}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top;"><strong>${s.title || ''}</strong>${trackBadge}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top;">${locationCell}</td>
    </tr>`;
  }).join('');

  return `<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
    <thead>
      <tr style="background:#f3f4f6;">
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #d1d5db;font-weight:600;">Time</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #d1d5db;font-weight:600;">Session</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #d1d5db;font-weight:600;">Location</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function formatSessionTime(dateStr, timeZone = 'UTC') {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return date.toLocaleString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timeZone || 'UTC'
    });
  } catch {
    return dateStr;
  }
}

export function replacePlaceholders(template, data) {
  const { event, booking, complexEventData } = data;

  let result = template || '';

  result = result.replace(/\{\{event_name\}\}/gi, event?.title || '');
  result = result.replace(/\{\{event_date\}\}/gi, formatEventDate(event?.start_date, event?.timezone));
  result = result.replace(/\{\{event_location\}\}/gi, event?.is_online ? 'Online Event' : (event?.location || ''));
  result = result.replace(/\{\{attendee_first_name\}\}/gi, booking?.attendee_first_name || '');
  result = result.replace(/\{\{attendee_last_name\}\}/gi, booking?.attendee_last_name || '');

  result = result.replace(/\[\[member\.first_name\]\]/gi, booking?.attendee_first_name || '');
  result = result.replace(/\[\[member\.last_name\]\]/gi, booking?.attendee_last_name || '');
  result = result.replace(/\[\[member\.email\]\]/gi, booking?.attendee_email || '');
  result = result.replace(/\[\[attendee\.first_name\]\]/gi, booking?.attendee_first_name || '');
  result = result.replace(/\[\[attendee\.last_name\]\]/gi, booking?.attendee_last_name || '');
  result = result.replace(/\[\[attendee\.email\]\]/gi, booking?.attendee_email || '');

  result = result.replace(/\[\[event\.name\]\]/gi, event?.title || '');
  result = result.replace(/\[\[event\.title\]\]/gi, event?.title || '');
  result = result.replace(/\[\[event\.date\]\]/gi, formatEventDate(event?.start_date, event?.timezone));
  result = result.replace(/\[\[event\.location\]\]/gi, event?.is_online ? 'Online Event' : (event?.location || ''));

  result = result.replace(/\{\{booking_id\}\}/gi, booking?.id || '');
  result = result.replace(/\[\[booking\.id\]\]/gi, booking?.id || '');
  result = result.replace(/\{\{booking_reference\}\}/gi, booking?.booking_reference || '');
  result = result.replace(/\[\[booking\.reference\]\]/gi, booking?.booking_reference || '');
  result = result.replace(/\[\[booking\.booking_reference\]\]/gi, booking?.booking_reference || '');
  result = result.replace(/\{\{ticket_class\}\}/gi, booking?.ticket_class_name || 'Standard');
  result = result.replace(/\[\[booking\.ticket_class\]\]/gi, booking?.ticket_class_name || 'Standard');

  const ticketPrice = Number(booking?.ticket_price || 0);
  const totalCost = Number(booking?.total_cost || 0);
  result = result.replace(/\{\{ticket_price\}\}/gi, ticketPrice > 0 ? `\u00A3${ticketPrice.toFixed(2)}` : 'Free');
  result = result.replace(/\[\[booking\.ticket_price\]\]/gi, ticketPrice > 0 ? `\u00A3${ticketPrice.toFixed(2)}` : 'Free');
  result = result.replace(/\{\{total_cost\}\}/gi, totalCost > 0 ? `\u00A3${totalCost.toFixed(2)}` : 'Free');
  result = result.replace(/\[\[booking\.total_cost\]\]/gi, totalCost > 0 ? `\u00A3${totalCost.toFixed(2)}` : 'Free');

  const pd = booking?.pricingDetails;
  if (pd?.freeTickets > 0) {
    result = result.replace(/\{\{#offer_discount\}\}([\s\S]*?)\{\{\/offer_discount\}\}/gi, '$1');
    const discountDesc = pd.discountDescription || `${pd.freeTickets} free ticket(s)`;
    result = result.replace(/\{\{offer_discount_description\}\}/gi, discountDesc);
    result = result.replace(/\[\[booking\.offer_discount_description\]\]/gi, discountDesc);
    const discountSaving = `\u00A3${(pd.freeTickets * ticketPrice).toFixed(2)}`;
    result = result.replace(/\{\{offer_discount_amount\}\}/gi, discountSaving);
    result = result.replace(/\[\[booking\.offer_discount_amount\]\]/gi, discountSaving);
  } else if (pd?.discount > 0) {
    result = result.replace(/\{\{#offer_discount\}\}([\s\S]*?)\{\{\/offer_discount\}\}/gi, '$1');
    const discountDesc = pd.discountDescription || 'Discount';
    result = result.replace(/\{\{offer_discount_description\}\}/gi, discountDesc);
    result = result.replace(/\[\[booking\.offer_discount_description\]\]/gi, discountDesc);
    const discountAmount = `\u00A3${pd.discount.toFixed(2)}`;
    result = result.replace(/\{\{offer_discount_amount\}\}/gi, discountAmount);
    result = result.replace(/\[\[booking\.offer_discount_amount\]\]/gi, discountAmount);
  } else {
    result = result.replace(/\{\{#offer_discount\}\}[\s\S]*?\{\{\/offer_discount\}\}/gi, '');
    result = result.replace(/\{\{offer_discount_description\}\}/gi, '');
    result = result.replace(/\[\[booking\.offer_discount_description\]\]/gi, '');
    result = result.replace(/\{\{offer_discount_amount\}\}/gi, '');
    result = result.replace(/\[\[booking\.offer_discount_amount\]\]/gi, '');
  }

  const zoomLink = event?.zoom_join_url || booking?.zoom_join_url || '';
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

export function formatEventDate(dateStr, timeZone = 'UTC') {
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

export function formatBodyAsHtml(body) {
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

export { fetchComplexEventData, buildSessionScheduleHtml };
