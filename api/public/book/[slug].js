import { supabase } from '../../_lib/database.js';
import { createCalendarEvent, getOutlookConnectionForIdentity } from '../../outlook/calendar.js';
import { formatInTimeZone } from 'date-fns-tz';

// Extract tenant slug from subdomain (e.g., gsf.iconn.app -> 'gsf')
function getTenantSlugFromHost(host) {
  if (!host) return null;
  // Remove port if present
  const hostname = host.split(':')[0];
  // Check for subdomain pattern: {tenant}.iconn.app or {tenant}.{domain}
  const parts = hostname.split('.');
  if (parts.length >= 2) {
    // First part is the tenant slug (e.g., 'gsf' from 'gsf.iconn.app')
    const potentialSlug = parts[0];
    // Exclude common non-tenant prefixes
    if (!['www', 'api', 'localhost', '127'].includes(potentialSlug)) {
      return potentialSlug;
    }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { slug } = req.query;
  if (!slug) {
    return res.status(400).json({ error: 'Booking slug required' });
  }

  try {
    // Extract tenant from subdomain
    const host = req.headers.host || req.headers['x-forwarded-host'];
    const tenantSlug = getTenantSlugFromHost(host);
    
    console.log('[Booking] Host:', host, 'Tenant slug:', tenantSlug);

    // Find tenant by subdomain
    let tenantId = null;
    let tenant = null;
    
    if (tenantSlug) {
      const { data: tenantData } = await supabase
        .from('tenant')
        .select('id, name, slug, logo_url, primary_color')
        .eq('slug', tenantSlug)
        .single();
      
      if (tenantData) {
        tenantId = tenantData.id;
        tenant = tenantData;
      }
    }

    if (!tenantId) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Find identity by booking slug AND tenant_id to ensure tenant isolation
    const { data: identity, error: identityError } = await supabase
      .from('tenant_identity')
      .select('id, first_name, last_name, email, avatar_url, booking_slug')
      .eq('booking_slug', slug)
      .eq('tenant_id', tenantId)
      .single();

    if (identityError || !identity) {
      return res.status(404).json({ error: 'Booking page not found' });
    }

    // Find availability profile for this identity AND this specific tenant
    const { data: profile, error: profileError } = await supabase
      .from('agent_availability_profile')
      .select('*')
      .eq('identity_id', identity.id)
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'Booking page not active for this organization' });
    }

    // Fetch meeting templates assigned to this agent
    const { data: agentTemplates } = await supabase
      .from('agent_meeting_template')
      .select(`
        id,
        is_active,
        custom_duration_minutes,
        template:meeting_template_id(
          id, slug, name, description, duration_minutes, meeting_type, is_active, sort_order
        )
      `)
      .eq('tenant_id', tenantId)
      .eq('identity_id', identity.id)
      .eq('is_active', true);

    // Filter active templates and format them
    const meetingTypes = (agentTemplates || [])
      .filter(at => at.template?.is_active)
      .map(at => ({
        id: at.template.id,
        slug: at.template.slug,
        name: at.template.name,
        description: at.template.description,
        duration_minutes: at.custom_duration_minutes || at.template.duration_minutes,
        meeting_type: at.template.meeting_type,
        sort_order: at.template.sort_order
      }))
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

    if (req.method === 'GET') {
      return res.json({
        agent: {
          name: `${identity.first_name || ''} ${identity.last_name || ''}`.trim() || identity.email,
          avatar: identity.avatar_url
        },
        profile: {
          timezone: profile.timezone,
          slotMinutes: profile.default_slot_minutes,
          bufferMinutes: profile.buffer_minutes,
          workingHours: profile.working_hours,
          title: profile.booking_title,
          description: profile.booking_description
        },
        meetingTypes,
        tenant: tenant ? {
          name: tenant.name,
          logo: tenant.logo_url,
          color: tenant.primary_color
        } : null
      });
    }

    if (req.method === 'POST') {
      const {
        attendee_name,
        attendee_email,
        attendee_phone,
        attendee_timezone,
        attendee_notes,
        starts_at,
        duration_minutes,
        meeting_template_id,
        meeting_template_slug
      } = req.body;

      if (!attendee_name || !attendee_email || !starts_at) {
        return res.status(400).json({ error: 'Name, email, and time slot are required' });
      }

      // Resolve meeting template if specified - must be from agent's assigned templates
      let selectedTemplate = null;
      if (meeting_template_id) {
        selectedTemplate = meetingTypes.find(mt => mt.id === meeting_template_id);
        if (!selectedTemplate && meetingTypes.length > 0) {
          return res.status(400).json({ error: 'Invalid meeting template for this agent' });
        }
      } else if (meeting_template_slug) {
        selectedTemplate = meetingTypes.find(mt => mt.slug === meeting_template_slug);
        if (!selectedTemplate && meetingTypes.length > 0) {
          return res.status(400).json({ error: 'Invalid meeting template for this agent' });
        }
      }

      const startTime = new Date(starts_at);
      const duration = selectedTemplate?.duration_minutes || duration_minutes || profile.default_slot_minutes;
      const endTime = new Date(startTime.getTime() + duration * 60 * 1000);
      const meetingType = selectedTemplate?.meeting_type || 'phone';

      const { data: conflicts } = await supabase
        .from('agent_booking')
        .select('id')
        .eq('identity_id', identity.id)
        .eq('tenant_id', tenantId)
        .neq('status', 'cancelled')
        .or(`and(starts_at.lt.${endTime.toISOString()},ends_at.gt.${startTime.toISOString()})`);

      if (conflicts && conflicts.length > 0) {
        return res.status(409).json({ error: 'This time slot is no longer available' });
      }

      const { data: memberMatch } = await supabase
        .from('member')
        .select('id')
        .eq('tenant_id', tenantId)
        .ilike('email', attendee_email)
        .limit(1);

      const meetingTitle = selectedTemplate 
        ? `${selectedTemplate.name} with ${attendee_name}`
        : `Meeting with ${attendee_name}`;

      const { data: booking, error: bookingError } = await supabase
        .from('agent_booking')
        .insert({
          tenant_id: tenantId,
          identity_id: identity.id,
          attendee_name,
          attendee_email: attendee_email.toLowerCase(),
          attendee_phone,
          attendee_timezone: attendee_timezone || profile.timezone,
          attendee_notes,
          title: meetingTitle,
          starts_at: startTime.toISOString(),
          ends_at: endTime.toISOString(),
          duration_minutes: duration,
          status: 'confirmed',
          member_id: memberMatch?.[0]?.id || null,
          meeting_template_id: selectedTemplate?.id || null,
          meeting_type: meetingType
        })
        .select()
        .single();

      if (bookingError) {
        console.error('[Public Booking] Create error:', bookingError);
        return res.status(500).json({ error: 'Failed to create booking' });
      }

      // Create calendar event in agent's Outlook calendar if connected
      let calendarEventId = null;
      try {
        const outlookConnection = await getOutlookConnectionForIdentity(identity.id, tenantId);
        if (outlookConnection) {
          const agentTimezone = profile.timezone || 'UTC';
          // Format times as local strings (without Z suffix) for Microsoft Graph when specifying timeZone
          const startLocalStr = formatInTimeZone(startTime, agentTimezone, "yyyy-MM-dd'T'HH:mm:ss");
          const endLocalStr = formatInTimeZone(endTime, agentTimezone, "yyyy-MM-dd'T'HH:mm:ss");
          
          const calendarEvent = await createCalendarEvent(outlookConnection, {
            subject: `Meeting with ${attendee_name}`,
            body: `<p>Booking via ${tenant?.name || 'iconn.app'}</p>
                   <p><strong>Attendee:</strong> ${attendee_name}</p>
                   <p><strong>Email:</strong> ${attendee_email}</p>
                   ${attendee_phone ? `<p><strong>Phone:</strong> ${attendee_phone}</p>` : ''}
                   ${attendee_notes ? `<p><strong>Notes:</strong> ${attendee_notes}</p>` : ''}`,
            startDateTime: startLocalStr,
            endDateTime: endLocalStr,
            timeZone: agentTimezone,
            attendees: [{ email: attendee_email, name: attendee_name }],
            isOnlineMeeting: false
          });
          
          calendarEventId = calendarEvent?.id;
          console.log('[Public Booking] Created Outlook calendar event:', calendarEventId);
          
          // Update booking with calendar event ID
          if (calendarEventId) {
            const { error: updateEventIdError } = await supabase
              .from('agent_booking')
              .update({ outlook_event_id: calendarEventId })
              .eq('id', booking.id);
            
            if (updateEventIdError) {
              console.error('[Public Booking] Failed to save outlook_event_id:', updateEventIdError);
            } else {
              console.log('[Public Booking] Saved outlook_event_id to booking:', booking.id);
            }
          }
        } else {
          console.log('[Public Booking] No Outlook connection for agent, skipping calendar event');
        }
      } catch (calendarError) {
        // Don't fail the booking if calendar creation fails
        console.error('[Public Booking] Calendar event creation failed:', calendarError);
      }

      return res.status(201).json({
        success: true,
        booking: {
          id: booking.id,
          starts_at: booking.starts_at,
          ends_at: booking.ends_at,
          status: booking.status,
          calendarEventCreated: !!calendarEventId
        },
        agent: {
          name: `${identity.first_name || ''} ${identity.last_name || ''}`.trim(),
          email: identity.email
        }
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Public Booking] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
