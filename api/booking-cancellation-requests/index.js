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

  const { booking_ids, booking_group_reference, request_type, reason } = req.body;

  if (!booking_ids || !Array.isArray(booking_ids) || booking_ids.length === 0) {
    return res.status(400).json({ error: 'booking_ids is required and must be a non-empty array' });
  }

  if (!request_type || !['individual', 'group'].includes(request_type)) {
    return res.status(400).json({ error: 'request_type must be "individual" or "group"' });
  }

  try {
    const { data: bookings, error: bookingsError } = await supabase
      .from('booking')
      .select('id, event_id, member_id, status, booking_group_reference, attendee_email')
      .in('id', booking_ids)
      .eq('tenant_id', tenantId);

    if (bookingsError) {
      console.error('[CancellationRequest] Error fetching bookings:', bookingsError);
      return res.status(500).json({ error: 'Failed to validate bookings' });
    }

    if (!bookings || bookings.length === 0) {
      return res.status(404).json({ error: 'No matching bookings found' });
    }

    if (bookings.length !== booking_ids.length) {
      return res.status(400).json({ error: 'Some booking IDs are invalid or do not belong to your tenant' });
    }

    const unauthorizedBookings = bookings.filter(b => b.member_id !== member.id);
    if (unauthorizedBookings.length > 0) {
      return res.status(403).json({ error: 'You can only request cancellation for your own bookings' });
    }

    const alreadyCancelled = bookings.filter(b => b.status === 'cancelled');
    if (alreadyCancelled.length > 0) {
      return res.status(400).json({ error: 'Some bookings are already cancelled' });
    }

    const { data: existingRequests } = await supabase
      .from('booking_cancellation_request')
      .select('booking_id')
      .in('booking_id', booking_ids)
      .eq('status', 'pending')
      .eq('tenant_id', tenantId);

    const alreadyRequested = existingRequests?.map(r => r.booking_id) || [];
    const newBookingIds = booking_ids.filter(id => !alreadyRequested.includes(id));

    if (newBookingIds.length === 0) {
      return res.status(400).json({ error: 'Cancellation requests already exist for all selected bookings' });
    }

    const rows = newBookingIds.map(bookingId => {
      const booking = bookings.find(b => b.id === bookingId);
      return {
        tenant_id: tenantId,
        booking_id: bookingId,
        booking_group_reference: booking_group_reference || booking?.booking_group_reference || null,
        event_id: booking?.event_id || null,
        member_id: member.id,
        request_type,
        reason: reason || null,
        status: 'pending',
      };
    });

    const { data: created, error: insertError } = await supabase
      .from('booking_cancellation_request')
      .insert(rows)
      .select();

    if (insertError) {
      console.error('[CancellationRequest] Insert error:', insertError);
      return res.status(500).json({ error: 'Failed to create cancellation request' });
    }

    console.log(`[CancellationRequest] Created ${created.length} request(s) for member ${member.id}`);
    return res.status(201).json({ requests: created, skipped: alreadyRequested.length });
  } catch (err) {
    console.error('[CancellationRequest] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(req, res) {
  const tenantUser = await getSessionTenantUser(req);
  let tenantId;

  if (tenantUser) {
    tenantId = tenantUser.tenant_id;
  } else {
    const member = await getSessionMember(req);
    if (!member) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    tenantId = member.organization?.tenant_id || member.tenant_id;

    const { data: requests, error } = await supabase
      .from('booking_cancellation_request')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('member_id', member.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[CancellationRequest] Error fetching member requests:', error);
      return res.status(500).json({ error: 'Failed to fetch requests' });
    }

    return res.json({ requests: requests || [] });
  }

  if (!tenantId) {
    return res.status(400).json({ error: 'Could not determine tenant' });
  }

  const { status: statusFilter } = req.query;

  try {
    let query = supabase
      .from('booking_cancellation_request')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (statusFilter && ['pending', 'approved', 'rejected'].includes(statusFilter)) {
      query = query.eq('status', statusFilter);
    }

    const { data: requests, error } = await query;

    if (error) {
      console.error('[CancellationRequest] Error fetching requests:', error);
      return res.status(500).json({ error: 'Failed to fetch requests' });
    }

    const bookingIds = [...new Set((requests || []).map(r => r.booking_id))];
    const memberIds = [...new Set((requests || []).map(r => r.member_id))];

    let bookingsMap = {};
    if (bookingIds.length > 0) {
      const { data: bookings } = await supabase
        .from('booking')
        .select('id, attendee_email, attendee_first_name, attendee_last_name, event_id, status, booking_group_reference, ticket_class_name')
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
        event: eventId ? (eventsMap[eventId] || null) : null,
      };
    });

    return res.json({ requests: enrichedRequests });
  } catch (err) {
    console.error('[CancellationRequest] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
