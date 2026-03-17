import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';

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

const WHITELISTED_ORG_FIELDS = [
  'id', 'name', 'invoicing_email', 'phone', 'invoicing_address',
  'website_url', 'logo_url'
];

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { booking_id, form_slug, tenant: tenantParam } = req.query;

  if (!booking_id) {
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
      .select('id, prefill_source')
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

    const { data: booking, error: bookingError } = await supabase
      .from('booking')
      .select('*')
      .eq('id', booking_id)
      .eq('tenant_id', tenantId)
      .single();

    if (bookingError || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

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

    return res.json({
      booking: publicBooking,
      member,
      memberCustomValues,
      organization,
      orgCustomValues
    });
  } catch (error) {
    console.error('[Public Prefill Booking] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch booking data' });
  }
}
