import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';
import { getSessionMember } from '../../_lib/session.js';
import { pickViewerBooking, emailExactIlikePattern } from '../../_lib/viewerBookingMatch.js';

const WHITELISTED_BOOKING_FIELDS = [
  'id', 'event_id', 'member_id', 'organization_id',
  'attendee_email', 'attendee_first_name', 'attendee_last_name',
  'attendee_phone', 'attendee_job_title', 'guest_organisation_name',
  'ticket_class_name', 'booking_reference', 'is_guest_booking'
];

const WHITELISTED_MEMBER_FIELDS = [
  'id', 'first_name', 'last_name', 'email', 'phone', 'mobile',
  'job_title', 'organization_id', 'status', 'address_line_1',
  'address_line_2', 'city', 'county', 'postcode', 'country',
  'date_of_birth', 'gender', 'title', 'middle_name', 'suffix',
  'preferred_name', 'company_name', 'department', 'website',
  'role_id'
];

// Keep in sync with ORG_CORE_FIELDS / ORG_PREFILL_FIELDS in client/src/pages/FormBuilder.jsx.
const WHITELISTED_ORG_FIELDS = [
  'id', 'name', 'description', 'invoicing_email', 'phone', 'invoicing_address',
  'website_url', 'logo_url', 'training_fund_balance', 'tags'
];

// Empty payload used by the authenticated fallback when there is nothing to
// prefill (form not event-linked, viewer has no booking for the event, …).
// A 200 with nulls lets the client degrade gracefully to blank fields.
const EMPTY_PAYLOAD = {
  booking: null,
  member: null,
  memberCustomValues: [],
  organization: null,
  orgCustomValues: []
};

// Builds the whitelisted booking/member/org prefill payload from a resolved
// booking row. Shared by the explicit booking_id path and the authenticated
// viewer-resolution path so both return the exact same shape.
async function buildPrefillPayload(supabase, tenantId, booking) {
  const publicBooking = {};
  for (const field of WHITELISTED_BOOKING_FIELDS) {
    if (booking[field] !== undefined) {
      publicBooking[field] = booking[field];
    }
  }

  if (booking.event_id) {
    const { data: event } = await supabase
      .from('event')
      .select('title')
      .eq('id', booking.event_id)
      .eq('tenant_id', tenantId)
      .single();

    if (event) {
      publicBooking.event_name = event.title;
    }
  }

  let member = null;
  let memberCustomValues = [];
  let organization = null;
  let orgCustomValues = [];

  if (booking.member_id) {
    const { data: memberData } = await supabase
      .from('member')
      .select('*')
      .eq('id', booking.member_id)
      .eq('tenant_id', tenantId)
      .single();

    if (memberData) {
      member = {};
      for (const field of WHITELISTED_MEMBER_FIELDS) {
        if (memberData[field] !== undefined) {
          member[field] = memberData[field];
        }
      }

      const { data: mcv } = await supabase
        .from('member_preference_value')
        .select('id, member_id, field_id, value')
        .eq('member_id', booking.member_id);

      if (mcv) {
        memberCustomValues = mcv;
      }

      if (!booking.organization_id && memberData.organization_id) {
        booking.organization_id = memberData.organization_id;
      }
    }
  }

  const orgId = booking.organization_id;
  if (orgId) {
    const { data: orgData } = await supabase
      .from('organization')
      .select('*')
      .eq('id', orgId)
      .eq('tenant_id', tenantId)
      .single();

    if (orgData) {
      organization = {};
      for (const field of WHITELISTED_ORG_FIELDS) {
        if (orgData[field] !== undefined) {
          organization[field] = orgData[field];
        }
      }

      const { data: ocv } = await supabase
        .from('organization_preference_value')
        .select('id, organization_id, field_id, value')
        .eq('organization_id', orgId);

      if (ocv) {
        orgCustomValues = ocv;
      }
    }
  }

  return {
    booking: publicBooking,
    member,
    memberCustomValues,
    organization,
    orgCustomValues
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { booking_id, form_slug, resolve, tenant: tenantParam } = req.query;

  // Task #3399: without an explicit booking_id, the endpoint can resolve the
  // authenticated viewer's own booking for the form's linked event
  // (?resolve=viewer). Explicit booking_id keeps its original contract.
  const viewerResolution = !booking_id && resolve === 'viewer';

  if (!booking_id && !viewerResolution) {
    return res.status(400).json({ error: 'booking_id is required' });
  }
  if (!form_slug) {
    return res.status(400).json({ error: 'form_slug is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    let tenantId = null;

    const tenant = await resolveTenantFromRequest(req);
    if (tenant) {
      tenantId = tenant.id;
    }

    if (!tenantId && tenantParam) {
      let { data: tenantBySlug } = await supabase
        .from('tenant')
        .select('id')
        .eq('slug', tenantParam)
        .eq('status', 'active')
        .single();

      if (tenantBySlug) {
        tenantId = tenantBySlug.id;
      } else {
        const { data: tenantBySubdomain } = await supabase
          .from('tenant')
          .select('id')
          .eq('subdomain', tenantParam)
          .eq('status', 'active')
          .single();

        if (tenantBySubdomain) {
          tenantId = tenantBySubdomain.id;
        }
      }
    }

    if (!tenantId) {
      return res.status(400).json({ error: 'Invalid tenant context' });
    }

    const { data: form, error: formError } = await supabase
      .from('form')
      .select('id, prefill_source, is_event_related, related_event_id')
      .eq('slug', form_slug)
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .single();

    if (formError || !form) {
      return res.status(404).json({ error: 'Form not found' });
    }

    if (form.prefill_source !== 'booking') {
      return res.status(400).json({ error: 'Form is not configured for booking prefill' });
    }

    let booking = null;

    if (viewerResolution) {
      // Task #3399: resolve the viewer's own booking for the form's linked
      // event, entirely server-side. The member comes from the session (never
      // from client-supplied ids), so this path can only ever surface the
      // viewer's own booking. All "nothing to prefill" outcomes return an
      // empty 200 payload so the form degrades gracefully to blank fields.
      if (!form.is_event_related || !form.related_event_id) {
        return res.json(EMPTY_PAYLOAD);
      }

      const sessionMember = await getSessionMember(req);
      if (!sessionMember) {
        return res.json(EMPTY_PAYLOAD);
      }

      // The session member must belong to the resolved tenant.
      const memberTenantId = sessionMember.tenant_id || sessionMember.organization?.tenant_id || null;
      if (memberTenantId && memberTenantId !== tenantId) {
        return res.json(EMPTY_PAYLOAD);
      }

      // Task #3403: match bookings where the viewer is the ATTENDEE
      // (attendee_email, case-insensitive) OR the booker (member_id). A
      // booking made on the viewer's behalf carries someone else's
      // member_id, so member_id alone misses attendees. Attendee matches
      // win; most recent wins among duplicates (see pickViewerBooking).
      // Two prioritized queries (not one capped .or) so an old attendee
      // booking can never be crowded out of a row cap by newer booker rows.
      const baseQuery = () => supabase
        .from('booking')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('event_id', form.related_event_id)
        .neq('status', 'cancelled')
        .order('created_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: true })
        .limit(10);

      let bookings = [];
      let bookingsError = null;

      const emailPattern = emailExactIlikePattern(sessionMember.email);
      if (emailPattern) {
        // Escaped pattern = case-insensitive EXACT equality, never a wildcard
        // match. pickViewerBooking re-verifies exact equality locally anyway.
        const attendeeRes = await baseQuery().ilike('attendee_email', emailPattern);
        bookingsError = attendeeRes.error;
        bookings = attendeeRes.data || [];
      }

      if (!bookingsError && bookings.length === 0) {
        const bookerRes = await baseQuery().eq('member_id', sessionMember.id);
        bookingsError = bookerRes.error;
        bookings = bookerRes.data || [];
      }

      if (bookingsError) {
        // Transient DB error — not a definitive "no booking" answer. 500 so
        // the client treats it as an error rather than blocking the form.
        console.error('[Public Prefill Booking] Viewer booking lookup error:', bookingsError);
        return res.status(500).json({ error: 'Failed to fetch booking data' });
      }

      const picked = pickViewerBooking(bookings, {
        memberId: sessionMember.id,
        email: sessionMember.email
      });

      if (!picked) {
        // Task #3400: authenticated member, event-linked form, but no booking
        // of theirs for the event. Mark this outcome explicitly so the client
        // can block the form with a helpful message instead of rendering
        // blank fields. Other empty outcomes (anonymous, non-event form,
        // wrong tenant) stay as plain EMPTY_PAYLOAD.
        return res.json({ ...EMPTY_PAYLOAD, noBooking: true });
      }

      booking = picked;

      // When the viewer matched as ATTENDEE on someone else's booking, the
      // row's member_id is the BOOKER. Prefill the member/org sections from
      // the viewer instead — the survey is about them, and the booker's
      // personal details must not leak into the attendee's form.
      if (booking.member_id !== sessionMember.id) {
        booking = { ...booking, member_id: sessionMember.id, organization_id: null };
      }
    } else {
      const { data: bookingData, error: bookingError } = await supabase
        .from('booking')
        .select('*')
        .eq('id', booking_id)
        .eq('tenant_id', tenantId)
        .single();

      if (bookingError || !bookingData) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      booking = bookingData;
    }

    const payload = await buildPrefillPayload(supabase, tenantId, booking);
    return res.json(payload);
  } catch (error) {
    console.error('[Public Prefill Booking] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch booking data' });
  }
}
