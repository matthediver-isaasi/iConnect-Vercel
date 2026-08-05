import { supabase } from './database.js';
import { sendEmail } from './emailService.js';
import { buildInboxDelivery } from './transactionalInbox.js';
import { buildIcs, buildEventUid, buildSessionUid } from './icsBuilder.js';
import { buildQrImageUrl, ensureBookingToken, ensureComplexSessionTokens } from './checkinService.js';
import { fetchTrainingAgendaData, applyAgendaPlaceholders } from './trainingAgenda.js';

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
      .select('id, title, description, start_date, end_date, location, is_online, is_complex, is_training, zoom_meeting_id, zoom_webinar_id, tenant_id, timezone, qr_on_confirmation')
      .eq('id', eventId);
    if (tenantId) {
      eventQuery = eventQuery.eq('tenant_id', tenantId);
    }
    let { data: event, error: eventError } = await eventQuery.single();

    if (eventError || !event) {
      let complexQuery = supabase
        .from('complex_event')
        .select('id, title, description, start_date, end_date, location, is_online, tenant_id, timezone, qr_on_confirmation')
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

    // Training events (Task #3419): resolve agenda context so
    // {{agenda_schedule}} renders the multi-day schedule in confirmations.
    let trainingAgendaData = null;
    if (!event.is_complex && event.is_training) {
      trainingAgendaData = await fetchTrainingAgendaData(eventId);
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

    // Entrance QR: in-person (offline) events only, when not opted out via
    // qr_on_confirmation. Simple = one booking QR; complex = one QR per
    // registered in-person session. Online events get nothing.
    let qrHtml = '';
    if (!event.is_online && event.qr_on_confirmation !== false) {
      try {
        qrHtml = await buildConfirmationQrHtml(event, booking, eventId);
      } catch (qrErr) {
        console.warn('[sendConfirmationEmailsFromTemplate] QR build failed:', qrErr?.message);
      }
    }

    const inboxDelivery = await buildInboxDelivery({
      tenantId: event.tenant_id,
      memberId: booking?.member_id || null,
      email: bookingData.attendee_email,
      labelKey: 'events',
    });

    for (const emailConfig of confirmationEmails) {
      try {
        let subject = replacePlaceholders(emailConfig.subject, { event, booking: bookingData, complexEventData });
        let body = replacePlaceholders(emailConfig.body, { event, booking: bookingData, complexEventData });
        if (event.is_training) {
          subject = applyAgendaPlaceholders(subject, { agendaData: trainingAgendaData });
          body = applyAgendaPlaceholders(body, { agendaData: trainingAgendaData });
        }

        const ccList = parseCcField(emailConfig.cc);

        const emailResult = await sendEmail({
          to: bookingData.attendee_email,
          subject: subject,
          html: formatBodyAsHtml(body) + qrHtml,
          cc: ccList.length > 0 ? ccList : undefined,
          tenantId: event.tenant_id,
          attachments: icsAttachment ? [icsAttachment] : undefined,
          inboxDelivery,
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

function renderQrCard(imgUrl, label) {
  const labelHtml = label
    ? `<div style="margin-top:8px;font-size:13px;color:#666666;">${escapeQrText(label)}</div>`
    : '';
  return `<div style="text-align:center;margin:16px 0;">
    <img src="${imgUrl}" alt="Entrance QR code" width="180" style="display:inline-block;width:180px;max-width:100%;height:auto;border:1px solid #e0e0e0;border-radius:4px;" />
    ${labelHtml}
  </div>`;
}

function escapeQrText(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Build entrance-QR HTML appended to in-person booking confirmations.
// Returns '' when no in-person token applies (e.g. online sessions only).
async function buildConfirmationQrHtml(event, booking, eventId) {
  if (!booking?.id) return '';

  if (event.is_complex) {
    const complexBooking = {
      id: booking.id,
      event_id: eventId,
      ticket_class_id: booking.ticket_class_id || booking.ticketClassId || null,
      tenant_id: event.tenant_id,
    };
    const sessions = await ensureComplexSessionTokens(complexBooking, event.tenant_id);
    if (!sessions || sessions.length === 0) return '';
    const cards = sessions
      .filter((s) => s && s.token)
      .map((s) => {
        const title = s.session?.title || 'Session';
        const track = s.session?.track_name ? ` — ${s.session.track_name}` : '';
        return renderQrCard(buildQrImageUrl(s.token), `${title}${track}`);
      })
      .join('');
    if (!cards) return '';
    return `<div style="font-family: Arial, sans-serif;margin-top:24px;">
      <h3 style="font-size:16px;color:#333333;margin:0 0 8px 0;text-align:center;">Your entrance QR codes</h3>
      <p style="font-size:13px;color:#666666;margin:0 0 8px 0;text-align:center;">Show the relevant code at each session's door for check-in.</p>
      ${cards}
    </div>`;
  }

  const token = await ensureBookingToken(booking.id, event.tenant_id);
  if (!token) return '';
  return `<div style="font-family: Arial, sans-serif;margin-top:24px;">
    <h3 style="font-size:16px;color:#333333;margin:0 0 8px 0;text-align:center;">Your entrance QR code</h3>
    ${renderQrCard(buildQrImageUrl(token), 'Show this QR code at the door for check-in')}
  </div>`;
}

function buildIcsAttachment(event, booking, complexEventData) {
  try {
    const bookingId = booking?.id || '';
    const entries = [];

    if (event?.is_complex) {
      const sessions = complexEventData?.sessions || [];
      for (const s of sessions) {
        if (!s.start_time || !s.end_time) continue;
        const isVirtual = s.delivery_mode ? s.delivery_mode === 'virtual' : !!s.is_online;
        const isHybrid = s.delivery_mode === 'hybrid';
        const sessionUrl = s.zoom_join_url || '';
        let location;
        if (isVirtual) {
          location = sessionUrl || 'Online';
        } else if (isHybrid) {
          location = [s.location, sessionUrl || 'Online'].filter(Boolean).join(' / ');
        } else {
          location = s.location || '';
        }
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
        // No accessible sessions with valid times — fall back to a single
        // whole-event VEVENT so the attendee still gets something importable.
        if (event?.start_date && event?.end_date) {
          entries.push({
            uid: buildEventUid(bookingId, event.id),
            title: event.title || 'Event',
            description: event.description || '',
            start: event.start_date,
            end: event.end_date,
            location: event.is_online ? 'Online' : (event.location || ''),
            timeZone: event.timezone || undefined,
          });
        } else {
          console.warn('[buildIcsAttachment] Skipping ICS — complex event has no accessible sessions with valid times and no event dates');
          return null;
        }
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

// Session columns the schedule/ICS rendering wants. `is_online` may not exist
// on older schemas, so the fetch drops back to the base column set on 42703
// (undefined column) rather than failing the whole send.
const SESSION_BASE_COLUMNS = 'id, title, description, start_time, end_time, delivery_mode, track_name, zoom_join_url, zoom_webinar_id, zoom_meeting_id, location, timezone';
const SESSION_EXTRA_COLUMNS = ', is_online';

async function fetchComplexEventSessions(eventId, tenantId) {
  const runQuery = async (columns) => {
    let q = supabase
      .from('complex_event_session')
      .select(columns)
      .eq('event_id', eventId)
      .eq('status', 'scheduled')
      .order('start_time', { ascending: true })
      .order('sort_order', { ascending: true });
    if (tenantId) q = q.eq('tenant_id', tenantId);
    return q;
  };

  let { data, error } = await runQuery(SESSION_BASE_COLUMNS + SESSION_EXTRA_COLUMNS);
  if (error && error.code === '42703') {
    ({ data, error } = await runQuery(SESSION_BASE_COLUMNS));
  }
  if (error) {
    console.warn('[fetchComplexEventSessions] Session query error:', error.message);
    return [];
  }
  return data || [];
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

    const sessions = await fetchComplexEventSessions(eventId, tenantId);

    if (!sessions || sessions.length === 0) {
      return { sessions: [], ticketClass, accessibleTracks: [], sessionScheduleHtml: '' };
    }

    // Track colours for the schedule badges. Tolerant: any failure just means
    // badges render without a custom colour.
    const trackColours = {};
    let eventTracks = [];
    try {
      let trackQuery = supabase
        .from('complex_event_track')
        .select('id, name, colour')
        .eq('complex_event_id', eventId);
      if (tenantId) trackQuery = trackQuery.eq('tenant_id', tenantId);
      const { data: trackRows, error: trackError } = await trackQuery;
      if (!trackError && trackRows) {
        eventTracks = trackRows;
        for (const t of trackRows) {
          if (t.name) trackColours[t.name.trim().toLowerCase()] = t.colour || null;
        }
      }
    } catch (trackErr) {
      console.warn('[fetchComplexEventData] Track colour fetch failed:', trackErr?.message);
    }

    let accessibleSessions = sessions;
    const accessibleTracks = [];

    if (ticketClass && !ticketClass.all_tracks && ticketClass.linked_track_ids?.length > 0) {
      const linkedIds = new Set(ticketClass.linked_track_ids);
      let tracks = eventTracks.filter(t => linkedIds.has(t.id));
      if (tracks.length === 0 && eventTracks.length === 0) {
        // Track fetch above failed — fall back to a direct lookup so access
        // filtering keeps working.
        const { data } = await supabase
          .from('complex_event_track')
          .select('id, name')
          .in('id', ticketClass.linked_track_ids);
        tracks = data || [];
      }

      const trackNames = tracks.map(t => t.name?.trim().toLowerCase());
      accessibleTracks.push(...tracks.map(t => t.name));

      accessibleSessions = sessions.filter(s => {
        if (!s.track_name) return true;
        return trackNames.includes(s.track_name.trim().toLowerCase());
      });
    } else {
      const uniqueTracks = [...new Set(sessions.map(s => s.track_name).filter(Boolean))];
      accessibleTracks.push(...uniqueTracks);
    }

    const sessionScheduleHtml = buildSessionScheduleHtml(accessibleSessions, eventTimezone, { trackColours });

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

function escapeScheduleHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isValidHexColour(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

function isSessionOnline(session) {
  if (session?.delivery_mode) return session.delivery_mode === 'virtual';
  return !!session?.is_online;
}

function isSessionHybrid(session) {
  return session?.delivery_mode === 'hybrid';
}

// Day key (YYYY-MM-DD) in the display timezone, for grouping sessions by
// calendar day the way the public schedule page does.
function formatDayKey(dateStr, timeZone) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  } catch {
    return null;
  }
}

function formatDayHeading(dateStr, timeZone) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'UTC',
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    }).format(d);
  } catch {
    return '';
  }
}

function formatTimeOnly(dateStr, timeZone) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'UTC',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
  } catch {
    return '';
  }
}

// Email-safe rendering of the attendee's session schedule, grouped by
// calendar day in the event timezone — a lightweight mirror of the public
// /session-events schedule view. Only tables + inline styles (no flexbox,
// grid or media queries) so it degrades gracefully in Outlook/Gmail. Long
// descriptions are deliberately omitted to keep the email scannable.
//
// options.trackColours: { lowercasedTrackName: '#rrggbb' | null }
// options.accentColor: link colour (defaults to the blue the old builder used).
function buildSessionScheduleHtml(sessions, eventTimezone = null, options = {}) {
  if (!sessions || sessions.length === 0) return '';

  const accent = isValidHexColour(options.accentColor) ? options.accentColor.trim() : '#2563eb';
  const trackColours = options.trackColours || {};

  // Group by day in the display timezone; sessions without a start time go
  // into a trailing "Date to be confirmed" bucket.
  const dayMap = new Map();
  const undated = [];
  for (const s of sessions) {
    const tz = s.timezone || eventTimezone || 'UTC';
    const key = s.start_time ? formatDayKey(s.start_time, tz) : null;
    if (!key) {
      undated.push(s);
      continue;
    }
    if (!dayMap.has(key)) dayMap.set(key, { heading: formatDayHeading(s.start_time, tz), sessions: [] });
    dayMap.get(key).sessions.push(s);
  }

  const dayKeys = [...dayMap.keys()].sort();

  const renderSessionRow = (s, isLast) => {
    const tz = s.timezone || eventTimezone || 'UTC';
    const startTime = s.start_time ? formatTimeOnly(s.start_time, tz) : 'TBC';
    const endTime = s.end_time ? formatTimeOnly(s.end_time, tz) : '';
    const timeRange = endTime ? `${startTime}&#8211;${endTime}` : startTime;

    const online = isSessionOnline(s);
    const hybrid = isSessionHybrid(s);
    const locationParts = [];
    if (!online && s.location) locationParts.push(escapeScheduleHtml(s.location));
    if (online) locationParts.push('Online');
    if (hybrid) {
      if (locationParts.length === 0 && s.location) locationParts.push(escapeScheduleHtml(s.location));
      locationParts.push('Online');
    }
    const locationText = locationParts.join(' &middot; ') || (online ? 'Online' : '');

    let trackBadge = '';
    if (s.track_name) {
      const colour = trackColours[s.track_name.trim().toLowerCase()];
      const badgeColour = isValidHexColour(colour) ? colour.trim() : '#6b7280';
      trackBadge = `<span style="display:inline-block;border:1px solid ${badgeColour};color:${badgeColour};border-radius:10px;padding:0 8px;font-size:11px;line-height:18px;margin-left:6px;vertical-align:middle;">${escapeScheduleHtml(s.track_name)}</span>`;
    }

    const joinLink = s.zoom_join_url
      ? `<a href="${escapeScheduleHtml(s.zoom_join_url)}" style="color:${accent};text-decoration:underline;font-size:13px;">Join online</a>`
      : '';

    const metaBits = [locationText, joinLink].filter(Boolean).join(' &middot; ');
    const metaLine = metaBits
      ? `<div style="font-size:13px;color:#6b7280;padding-top:2px;">${metaBits}</div>`
      : '';

    const borderStyle = isLast ? '' : 'border-bottom:1px solid #e5e7eb;';

    return `<tr>
      <td width="110" style="padding:10px 12px;${borderStyle}white-space:nowrap;vertical-align:top;font-size:13px;color:#374151;">${timeRange}</td>
      <td style="padding:10px 12px;${borderStyle}vertical-align:top;">
        <div style="font-size:14px;color:#111827;"><strong>${escapeScheduleHtml(s.title || 'Session')}</strong>${trackBadge}</div>
        ${metaLine}
      </td>
    </tr>`;
  };

  const renderDayBlock = (heading, daySessions) => {
    const rows = daySessions.map((s, i) => renderSessionRow(s, i === daySessions.length - 1)).join('');
    return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:0 0 16px 0;border:1px solid #e5e7eb;border-radius:6px;">
      <tr>
        <td colspan="2" style="padding:8px 12px;background-color:#f3f4f6;font-size:13px;font-weight:bold;color:#111827;border-bottom:1px solid #e5e7eb;">${escapeScheduleHtml(heading)}</td>
      </tr>
      ${rows}
    </table>`;
  };

  const blocks = [];
  for (const key of dayKeys) {
    const day = dayMap.get(key);
    blocks.push(renderDayBlock(day.heading, day.sessions));
  }
  if (undated.length > 0) {
    blocks.push(renderDayBlock('Date to be confirmed', undated));
  }

  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:16px 0;font-family:Arial,sans-serif;">
    <tr><td>
      ${blocks.join('\n')}
    </td></tr>
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

// Resolve the booking-scoped placeholder tokens shared between transactional
// event emails and bulk campaigns. Handles both [[booking.*]] and the legacy
// {{...}} forms documented in client/src/lib/emailPlaceholders.js. Kept here as
// the single source of truth so campaign sends reuse it rather than duplicating
// the token map. `booking` may be a partial row; missing fields resolve to the
// same defaults transactional emails already use.
export function replaceBookingPlaceholders(template, booking) {
  let result = template || '';

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

  return result;
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

  result = replaceBookingPlaceholders(result, booking);

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
