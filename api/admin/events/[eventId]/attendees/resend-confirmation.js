import { getSessionMember } from '../../../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';
import { isResourceExcluded } from '../../../../_lib/roleVisibility.js';
import { sendConfirmationEmailsFromTemplate } from '../../../../_lib/eventConfirmationEmail.js';
import { getZoomAccessTokenForTenant } from '../../../../_lib/zoomClient.js';
import { isGroupAdminForEventRequest } from '../../../../_lib/groupAdminEventWrite.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

async function verifyAdminAccess(req) {
  const sessionMember = await getSessionMember(req);

  if (!sessionMember) {
    return { hasAccess: false, error: 'Not authenticated' };
  }

  if (!sessionMember.role_id) {
    return { hasAccess: false, memberId: sessionMember.id };
  }

  if (!supabase) {
    return { hasAccess: false, error: 'Database not configured' };
  }

  try {
    const { data: role, error: roleError } = await supabase
      .from('role')
      .select('excluded_features')
      .eq('id', sessionMember.role_id)
      .single();

    if (roleError || !role) {
      return { hasAccess: false, memberId: sessionMember.id };
    }

    const excludedFeatures = role.excluded_features || [];
    const isAdmin = !isResourceExcluded(excludedFeatures, 'admin.role-management');

    if (isAdmin) {
      return { hasAccess: true, memberId: sessionMember.id };
    }

    return { hasAccess: false, memberId: sessionMember.id };
  } catch (error) {
    console.error('[Admin Resend Confirmation Access Verify] Error:', error);
    return { hasAccess: false, error: 'Verification failed' };
  }
}

async function findBooking(bookingId) {
  // Try the regular booking table first
  const { data: regular } = await supabase
    .from('booking')
    .select('*')
    .eq('id', bookingId)
    .maybeSingle();

  if (regular) {
    return { booking: regular, isComplex: false };
  }

  // Fall back to the complex_event_booking table
  const { data: complex } = await supabase
    .from('complex_event_booking')
    .select('*')
    .eq('id', bookingId)
    .maybeSingle();

  if (complex) {
    return {
      booking: {
        ...complex,
        total_cost: complex.total_paid,
      },
      isComplex: true,
    };
  }

  return { booking: null, isComplex: false };
}

async function findRegistrantJoinUrl(baseUrl, accessToken, email) {
  const normalizedEmail = String(email).toLowerCase();
  let nextPageToken = '';
  do {
    const url = `${baseUrl}?page_size=300&status=approved${nextPageToken ? `&next_page_token=${nextPageToken}` : ''}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      console.warn(`[Admin Resend Confirmation] Zoom registrant lookup failed (${res.status})`);
      return null;
    }
    const data = await res.json();
    const matching = (data.registrants || []).find(
      (r) => (r.email || '').toLowerCase() === normalizedEmail
    );
    if (matching) return matching.join_url || null;
    nextPageToken = data.next_page_token || '';
  } while (nextPageToken);
  return null;
}

async function getPersonalizedZoomUrl(eventId, attendeeEmail, tenantId) {
  if (!eventId || !attendeeEmail) return null;

  const { data: event } = await supabase
    .from('event')
    .select('zoom_webinar_id, zoom_meeting_id, tenant_id')
    .eq('id', eventId)
    .maybeSingle();

  if (!event || (!event.zoom_webinar_id && !event.zoom_meeting_id)) {
    return null;
  }

  const targetTenantId = tenantId || event.tenant_id;
  if (!targetTenantId) return null;

  try {
    if (event.zoom_webinar_id) {
      const { data: webinar } = await supabase
        .from('zoom_webinar')
        .select('zoom_webinar_id, registration_required')
        .eq('id', event.zoom_webinar_id)
        .maybeSingle();

      if (!webinar?.zoom_webinar_id || !webinar.registration_required) return null;

      const accessToken = await getZoomAccessTokenForTenant(targetTenantId);
      return await findRegistrantJoinUrl(
        `https://api.zoom.us/v2/webinars/${webinar.zoom_webinar_id}/registrants`,
        accessToken,
        attendeeEmail
      );
    }

    if (event.zoom_meeting_id) {
      const { data: meeting } = await supabase
        .from('zoom_meeting')
        .select('zoom_meeting_id, registration_required')
        .eq('id', event.zoom_meeting_id)
        .maybeSingle();

      if (!meeting?.zoom_meeting_id || !meeting.registration_required) return null;

      const accessToken = await getZoomAccessTokenForTenant(targetTenantId);
      return await findRegistrantJoinUrl(
        `https://api.zoom.us/v2/meetings/${meeting.zoom_meeting_id}/registrants`,
        accessToken,
        attendeeEmail
      );
    }
  } catch (err) {
    console.warn(
      `[Admin Resend Confirmation] Could not fetch personalized Zoom URL for ${attendeeEmail}, falling back to generic: ${err.message}`
    );
  }

  return null;
}

function buildPricingDetails(booking) {
  if (!booking) return null;
  const discount = Number(booking.discount_code_amount ?? booking.discount_amount ?? 0);
  const freeTickets = Number(booking.free_tickets || 0);
  const discountDescription = booking.discount_code_description
    || booking.discount_description
    || null;

  if (discount > 0 || freeTickets > 0) {
    return {
      discount: discount > 0 ? discount : 0,
      freeTickets: freeTickets > 0 ? freeTickets : 0,
      discountDescription,
    };
  }

  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { hasAccess, error: accessError } = await verifyAdminAccess(req);

  if (accessError) {
    return res.status(401).json({ error: accessError });
  }

  if (!hasAccess) {
    // Task e1476154: group admins may manage attendees of their own group's
    // events (simple or complex) — the group page surfaces the same modal.
    const groupOk = await isGroupAdminForEventRequest(req, req.query.eventId);
    if (!groupOk) {
      return res.status(403).json({ error: 'Admin access required' });
    }
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { eventId } = req.query;
  const { bookingId } = req.body || {};

  if (!eventId) {
    return res.status(400).json({ error: 'Event ID is required' });
  }

  if (!bookingId) {
    return res.status(400).json({ error: 'Booking ID is required' });
  }

  try {
    const { booking } = await findBooking(bookingId);

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (booking.event_id && String(booking.event_id) !== String(eventId)) {
      return res.status(400).json({ error: 'Booking does not belong to this event' });
    }

    const attendeeEmail = booking.attendee_email;
    if (!attendeeEmail) {
      return res.status(400).json({ error: 'Booking has no attendee email' });
    }

    const attendee = {
      first_name: booking.attendee_first_name || '',
      last_name: booking.attendee_last_name || '',
      email: attendeeEmail,
    };

    const pricingDetails = buildPricingDetails(booking);
    const tenantId = booking.tenant_id || null;
    const targetEventId = booking.event_id || eventId;

    const personalizedZoomUrl = await getPersonalizedZoomUrl(
      targetEventId,
      attendeeEmail,
      tenantId
    );

    console.log(
      `[Admin Resend Confirmation] Resending confirmation for booking ${bookingId} (event ${targetEventId}) to ${attendeeEmail} | personalizedZoom=${personalizedZoomUrl ? 'yes' : 'no'}`
    );

    const results = await sendConfirmationEmailsFromTemplate(
      targetEventId,
      booking,
      attendee,
      personalizedZoomUrl,
      pricingDetails,
      tenantId
    );

    if (!results || results.length === 0) {
      return res.status(404).json({
        error: 'No confirmation email is configured for this event',
      });
    }

    const successes = results.filter(r => r.success);
    if (successes.length === 0) {
      const firstError = results.find(r => !r.success)?.error || 'Email send failed';
      return res.status(502).json({ error: firstError });
    }

    return res.status(200).json({
      success: true,
      email: attendeeEmail,
      sent: successes.length,
      total: results.length,
    });
  } catch (error) {
    console.error('[Admin Resend Confirmation] Error:', error);
    return res.status(500).json({ error: error.message || 'Failed to resend confirmation email' });
  }
}
