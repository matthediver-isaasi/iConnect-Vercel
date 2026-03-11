import { supabase } from '../_lib/database.js';
import { getSessionMember, getSessionTenantUser } from '../_lib/session.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  if (req.method === 'POST') {
    return handlePost(req, res);
  }

  if (req.method === 'GET') {
    return handleGet(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function handlePost(req, res) {
  const member = await getSessionMember(req);
  if (!member) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const tenantId = member.organization?.tenant_id || member.tenant_id;
  if (!tenantId) {
    return res.status(400).json({ error: 'Could not determine tenant' });
  }

  const { booking_id, target_member_id, reason } = req.body;

  if (!booking_id) {
    return res.status(400).json({ error: 'booking_id is required' });
  }

  if (!target_member_id) {
    return res.status(400).json({ error: 'target_member_id is required' });
  }

  try {
    const { data: booking, error: bookingError } = await supabase
      .from('booking')
      .select('id, event_id, member_id, status, attendee_email, tenant_id')
      .eq('id', booking_id)
      .eq('tenant_id', tenantId)
      .single();

    if (bookingError || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const memberEmail = member.email?.toLowerCase();
    const isOwner = booking.member_id === member.id ||
      (booking.attendee_email || '').toLowerCase() === memberEmail;

    if (!isOwner) {
      return res.status(403).json({ error: 'You can only request transfers for your own bookings' });
    }

    if (booking.status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot transfer a cancelled booking' });
    }

    const { data: existingTransfer } = await supabase
      .from('booking_transfer_request')
      .select('id')
      .eq('booking_id', booking_id)
      .eq('status', 'pending')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (existingTransfer) {
      return res.status(400).json({ error: 'A pending transfer request already exists for this booking' });
    }

    const { data: existingCancel } = await supabase
      .from('booking_cancellation_request')
      .select('id')
      .eq('booking_id', booking_id)
      .eq('status', 'pending')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (existingCancel) {
      return res.status(400).json({ error: 'A pending cancellation request exists for this booking. Cancel it before requesting a transfer.' });
    }

    const { data: targetMember, error: targetError } = await supabase
      .from('member')
      .select('id, first_name, last_name, email')
      .eq('id', target_member_id)
      .eq('tenant_id', tenantId)
      .not('email', 'ilike', 'deleted_%@deleted.local')
      .single();

    if (targetError || !targetMember) {
      return res.status(400).json({ error: 'Target member not found' });
    }

    if (target_member_id === member.id) {
      return res.status(400).json({ error: 'Cannot transfer a booking to yourself' });
    }

    if (targetMember.email && booking.attendee_email &&
        targetMember.email.toLowerCase() === booking.attendee_email.toLowerCase()) {
      return res.status(400).json({ error: 'Target member is already the attendee for this booking' });
    }

    const { data: bookingFull } = await supabase
      .from('booking')
      .select('organization_id, attendee_email')
      .eq('id', booking_id)
      .eq('tenant_id', tenantId)
      .single();

    if (bookingFull?.organization_id) {
      let attendeeMemberId = booking.member_id;
      if (bookingFull.attendee_email) {
        const { data: attendeeMember } = await supabase
          .from('member')
          .select('id')
          .eq('tenant_id', tenantId)
          .ilike('email', bookingFull.attendee_email)
          .maybeSingle();
        if (attendeeMember) {
          attendeeMemberId = attendeeMember.id;
        }
      }

      let attendeeRoleId = null;
      if (attendeeMemberId) {
        const { data: attendeeTeam } = await supabase
          .from('team_member')
          .select('role_id')
          .eq('organization_id', bookingFull.organization_id)
          .eq('member_id', attendeeMemberId)
          .maybeSingle();
        attendeeRoleId = attendeeTeam?.role_id || null;
      }

      let targetTeamQuery = supabase
        .from('team_member')
        .select('role_id')
        .eq('organization_id', bookingFull.organization_id)
        .eq('member_id', target_member_id);

      if (attendeeRoleId) {
        targetTeamQuery = targetTeamQuery.eq('role_id', attendeeRoleId);
      }

      const { data: targetTeam } = await targetTeamQuery;

      if (!targetTeam || targetTeam.length === 0) {
        return res.status(400).json({ error: 'Target member must be in the same organisation and role' });
      }
    }

    const row = {
      tenant_id: tenantId,
      booking_id: booking_id,
      event_id: booking.event_id || null,
      member_id: member.id,
      target_member_id: target_member_id,
      reason: reason || null,
      status: 'pending',
    };

    const { data: created, error: insertError } = await supabase
      .from('booking_transfer_request')
      .insert(row)
      .select()
      .single();

    if (insertError) {
      console.error('[TransferRequest] Insert error:', insertError);
      return res.status(500).json({ error: 'Failed to create transfer request' });
    }

    console.log(`[TransferRequest] Created transfer request ${created.id} for booking ${booking_id} by member ${member.id}`);
    return res.status(201).json({ request: created });
  } catch (err) {
    console.error('[TransferRequest] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(req, res) {
  const tenantUser = await getSessionTenantUser(req);
  let tenantId;
  let memberIdFilter = null;
  let memberEmailFilter = null;

  if (tenantUser) {
    tenantId = tenantUser.tenant_id;
  } else {
    const member = await getSessionMember(req);
    if (!member) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    tenantId = member.organization?.tenant_id || member.tenant_id;
    memberIdFilter = member.id;
    memberEmailFilter = member.email?.toLowerCase() || null;
  }

  if (!tenantId) {
    return res.status(400).json({ error: 'Could not determine tenant' });
  }

  const { status: statusFilter } = req.query;

  try {
    let requests;

    if (memberIdFilter) {
      const bookingIdsForAttendee = [];
      if (memberEmailFilter) {
        const { data: attendeeBookings } = await supabase
          .from('booking')
          .select('id')
          .eq('tenant_id', tenantId)
          .ilike('attendee_email', memberEmailFilter);

        if (attendeeBookings?.length > 0) {
          bookingIdsForAttendee.push(...attendeeBookings.map(b => b.id));
        }
      }

      let query = supabase
        .from('booking_transfer_request')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });

      if (bookingIdsForAttendee.length > 0) {
        query = query.or(`member_id.eq.${memberIdFilter},booking_id.in.(${bookingIdsForAttendee.join(',')})`);
      } else {
        query = query.eq('member_id', memberIdFilter);
      }

      if (statusFilter && ['pending', 'approved', 'rejected'].includes(statusFilter)) {
        query = query.eq('status', statusFilter);
      }

      const { data, error } = await query;
      if (error) {
        console.error('[TransferRequest] Error fetching requests:', error);
        return res.status(500).json({ error: 'Failed to fetch requests' });
      }
      requests = data;
    } else {
      let query = supabase
        .from('booking_transfer_request')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });

      if (statusFilter && ['pending', 'approved', 'rejected'].includes(statusFilter)) {
        query = query.eq('status', statusFilter);
      }

      const { data, error } = await query;
      if (error) {
        console.error('[TransferRequest] Error fetching requests:', error);
        return res.status(500).json({ error: 'Failed to fetch requests' });
      }
      requests = data;
    }

    const bookingIds = [...new Set((requests || []).map(r => r.booking_id))];
    const memberIds = [...new Set((requests || []).flatMap(r => [r.member_id, r.target_member_id]))];

    let bookingsMap = {};
    if (bookingIds.length > 0) {
      const { data: bookings } = await supabase
        .from('booking')
        .select('id, attendee_email, attendee_first_name, attendee_last_name, event_id, status, booking_group_reference, booking_reference, ticket_class_name, organization_id')
        .in('id', bookingIds);
      bookingsMap = (bookings || []).reduce((acc, b) => { acc[b.id] = b; return acc; }, {});
    }

    const eventIds = [...new Set([
      ...(requests || []).filter(r => r.event_id).map(r => r.event_id),
      ...Object.values(bookingsMap).filter(b => b.event_id).map(b => b.event_id),
    ])];

    let membersMap = {};
    if (memberIds.length > 0) {
      const { data: members } = await supabase
        .from('member')
        .select('id, first_name, last_name, email')
        .in('id', memberIds);
      membersMap = (members || []).reduce((acc, m) => { acc[m.id] = m; return acc; }, {});
    }

    let eventsMap = {};
    if (eventIds.length > 0) {
      const { data: events } = await supabase
        .from('event')
        .select('id, title, start_date, location, program_tag')
        .in('id', eventIds);
      eventsMap = (events || []).reduce((acc, e) => { acc[e.id] = e; return acc; }, {});
    }

    const enrichedRequests = (requests || []).map(r => {
      const booking = bookingsMap[r.booking_id] || null;
      const eventId = r.event_id || booking?.event_id || null;

      return {
        ...r,
        booking,
        member: membersMap[r.member_id] || null,
        target_member: membersMap[r.target_member_id] || null,
        event: eventId ? (eventsMap[eventId] || null) : null,
      };
    });

    return res.json({ requests: enrichedRequests });
  } catch (err) {
    console.error('[TransferRequest] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
