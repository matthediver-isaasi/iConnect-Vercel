import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';
import { BOOKING_SOURCE_REGULAR, BOOKING_SOURCE_COMPLEX, isComplexSource, normalizeComplexBooking } from '../_lib/bookingLookup.js';

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
  let member = await getSessionMember(req);
  let hasTransferAccess = false;
  let tenantId = null;

  const ctx = await getTenantContext(req);
  if (ctx?.isAuthenticated) {
    if (ctx.tenantUserId) {
      hasTransferAccess = true;
    } else if (ctx.roleId) {
      hasTransferAccess = await hasFeatureAccess(ctx.roleId, 'commerce.event-cancellations');
    }
  }

  if (member) {
    tenantId = member.organization?.tenant_id || member.tenant_id;
  } else if (hasTransferAccess) {
    tenantId = ctx.tenantId;
  }

  if (!tenantId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { booking_id, target_member_id, reason, target_email, target_first_name, target_last_name, target_organisation, target_phone } = req.body;

  if (!booking_id) {
    return res.status(400).json({ error: 'booking_id is required' });
  }

  const isPublicTransfer = !target_member_id && target_email;

  if (!target_member_id && !target_email) {
    return res.status(400).json({ error: 'target_member_id or target_email is required' });
  }

  if (isPublicTransfer) {
    const trimmedEmail = target_email?.trim();
    const trimmedFirst = target_first_name?.trim();
    const trimmedLast = target_last_name?.trim();

    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      return res.status(400).json({ error: 'A valid email address is required for public transfers' });
    }
    if (!trimmedFirst || !trimmedLast) {
      return res.status(400).json({ error: 'First name and last name are required for public transfers' });
    }
  }

  try {
    const requestedSource = req.body.booking_source;
    let bookingSource;
    let booking, bookingError;

    if (requestedSource === BOOKING_SOURCE_COMPLEX) {
      const { data, error } = await supabase
        .from('complex_event_booking')
        .select('id, event_id, member_id, status, attendee_email, tenant_id, organization_id')
        .eq('id', booking_id)
        .eq('tenant_id', tenantId)
        .single();
      booking = data;
      bookingError = error;
      bookingSource = BOOKING_SOURCE_COMPLEX;
    } else if (requestedSource === BOOKING_SOURCE_REGULAR) {
      const { data, error } = await supabase
        .from('booking')
        .select('id, event_id, member_id, status, attendee_email, tenant_id')
        .eq('id', booking_id)
        .eq('tenant_id', tenantId)
        .single();
      booking = data;
      bookingError = error;
      bookingSource = BOOKING_SOURCE_REGULAR;
    } else {
      const { data: regData, error: regError } = await supabase
        .from('booking')
        .select('id, event_id, member_id, status, attendee_email, tenant_id')
        .eq('id', booking_id)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (regData) {
        booking = regData;
        bookingSource = BOOKING_SOURCE_REGULAR;
      } else {
        const { data: cplxData, error: cplxError } = await supabase
          .from('complex_event_booking')
          .select('id, event_id, member_id, status, attendee_email, tenant_id, organization_id')
          .eq('id', booking_id)
          .eq('tenant_id', tenantId)
          .maybeSingle();
        if (cplxData) {
          booking = cplxData;
          bookingSource = BOOKING_SOURCE_COMPLEX;
        } else {
          bookingError = cplxError || regError;
          bookingSource = BOOKING_SOURCE_REGULAR;
        }
      }
    }

    const isComplex = isComplexSource(bookingSource);

    if (bookingError || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (!hasTransferAccess) {
      const memberEmail = member?.email?.toLowerCase();
      const isOwner = (member && booking.member_id === member.id) ||
        (memberEmail && (booking.attendee_email || '').toLowerCase() === memberEmail);

      if (!isOwner) {
        return res.status(403).json({ error: 'You can only request transfers for your own bookings' });
      }
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

    if (isPublicTransfer) {
      const normalizedEmail = target_email.trim().toLowerCase();

      if (booking.attendee_email && normalizedEmail === booking.attendee_email.toLowerCase()) {
        return res.status(400).json({ error: 'Target email is already the attendee for this booking' });
      }

      const { data: existingMember } = await supabase
        .from('member')
        .select('id')
        .eq('tenant_id', tenantId)
        .ilike('email', normalizedEmail)
        .not('email', 'ilike', 'deleted_%@deleted.local')
        .maybeSingle();

      if (existingMember) {
        return res.status(400).json({ error: 'This email belongs to an existing member. Please use the member transfer flow instead.' });
      }

      const row = {
        tenant_id: tenantId,
        booking_id: booking_id,
        booking_source: bookingSource,
        event_id: booking.event_id || null,
        member_id: hasTransferAccess ? (booking.member_id || null) : (member?.id || null),
        target_member_id: null,
        target_email: normalizedEmail,
        target_first_name: target_first_name.trim(),
        target_last_name: target_last_name.trim(),
        target_organisation: target_organisation?.trim() || null,
        target_phone: target_phone?.trim() || null,
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

      console.log(`[TransferRequest] Created public transfer request ${created.id} for booking ${booking_id} -> ${normalizedEmail}${hasTransferAccess ? ' (elevated-access)' : ''}`);
      return res.status(201).json({ request: created });
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

    if (!hasTransferAccess && member && target_member_id === member.id) {
      return res.status(400).json({ error: 'Cannot transfer a booking to yourself' });
    }

    if (targetMember.email && booking.attendee_email &&
        targetMember.email.toLowerCase() === booking.attendee_email.toLowerCase()) {
      return res.status(400).json({ error: 'Target member is already the attendee for this booking' });
    }

    const { data: bookingFull } = isComplex
      ? await supabase.from('complex_event_booking').select('organization_id, attendee_email').eq('id', booking_id).eq('tenant_id', tenantId).single()
      : await supabase.from('booking').select('organization_id, attendee_email').eq('id', booking_id).eq('tenant_id', tenantId).single();

    if (bookingFull?.organization_id) {
      const { data: targetMemberOrg } = await supabase
        .from('member')
        .select('organization_id')
        .eq('id', target_member_id)
        .eq('tenant_id', tenantId)
        .single();

      if (!targetMemberOrg || targetMemberOrg.organization_id !== bookingFull.organization_id) {
        return res.status(400).json({ error: 'Target member must be in the same organisation' });
      }

      const { data: transferRoleSetting } = await supabase
        .from('system_settings')
        .select('setting_value')
        .eq('setting_key', 'transfer_restrict_by_role')
        .eq('tenant_id', tenantId)
        .maybeSingle();
      const restrictByRole = transferRoleSetting?.setting_value !== 'false';

      if (restrictByRole) {
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

        if (attendeeRoleId) {
          const { data: targetTeam } = await supabase
            .from('team_member')
            .select('role_id')
            .eq('organization_id', bookingFull.organization_id)
            .eq('member_id', target_member_id)
            .eq('role_id', attendeeRoleId)
            .maybeSingle();

          if (!targetTeam) {
            return res.status(400).json({ error: 'Target member must have the same role within the organisation' });
          }
        }
      }
    }

    const row = {
      tenant_id: tenantId,
      booking_id: booking_id,
      booking_source: bookingSource,
      event_id: booking.event_id || null,
      member_id: hasTransferAccess ? (booking.member_id || null) : member.id,
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

    console.log(`[TransferRequest] Created transfer request ${created.id} for booking ${booking_id}${hasTransferAccess ? ' (elevated-access)' : ` by member ${member.id}`}`);
    return res.status(201).json({ request: created });
  } catch (err) {
    console.error('[TransferRequest] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(req, res) {
  const ctx = await getTenantContext(req);
  if (!ctx.isAuthenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const tenantId = ctx.tenantId;
  let memberIdFilter = null;
  let memberEmailFilter = null;

  let hasTransferAccess = false;
  if (ctx.tenantUserId) {
    hasTransferAccess = true;
  } else if (ctx.roleId) {
    hasTransferAccess = await hasFeatureAccess(ctx.roleId, 'commerce.event-cancellations');
  }
  if (!hasTransferAccess) {
    memberIdFilter = ctx.memberId;
    if (ctx.memberId) {
      const { data: memberData } = await supabase
        .from('member')
        .select('email')
        .eq('id', ctx.memberId)
        .single();
      memberEmailFilter = memberData?.email?.toLowerCase() || null;
    }
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

        const { data: complexAttendeeBookings } = await supabase
          .from('complex_event_booking')
          .select('id')
          .eq('tenant_id', tenantId)
          .ilike('attendee_email', memberEmailFilter);

        if (complexAttendeeBookings?.length > 0) {
          bookingIdsForAttendee.push(...complexAttendeeBookings.map(b => b.id));
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
    const memberIds = [...new Set((requests || []).flatMap(r => [r.member_id, r.target_member_id]).filter(Boolean))];

    const regularBookingIds = [...new Set((requests || []).filter(r => r.booking_source !== BOOKING_SOURCE_COMPLEX).map(r => r.booking_id))];
    const complexBookingIds = [...new Set((requests || []).filter(r => r.booking_source === BOOKING_SOURCE_COMPLEX).map(r => r.booking_id))];

    let bookingsMap = {};
    if (regularBookingIds.length > 0) {
      const { data: bookings } = await supabase
        .from('booking')
        .select('id, attendee_email, attendee_first_name, attendee_last_name, event_id, status, booking_group_reference, booking_reference, ticket_class_name, organization_id')
        .in('id', regularBookingIds);
      for (const b of (bookings || [])) bookingsMap[b.id] = b;
    }
    if (complexBookingIds.length > 0) {
      const { data: cBookings } = await supabase
        .from('complex_event_booking')
        .select('id, attendee_email, attendee_first_name, attendee_last_name, event_id, status, booking_group_reference, booking_reference, ticket_class_name, organization_id')
        .in('id', complexBookingIds)
        .eq('tenant_id', tenantId);
      for (const b of (cBookings || [])) bookingsMap[b.id] = b;
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

      const missingEventIds = eventIds.filter(id => !eventsMap[id]);
      if (missingEventIds.length > 0) {
        const { data: complexEvents } = await supabase
          .from('complex_event')
          .select('id, title, start_date, location')
          .in('id', missingEventIds)
          .eq('tenant_id', tenantId);
        for (const ce of (complexEvents || [])) {
          eventsMap[ce.id] = { ...ce, program_tag: null };
        }
      }
    }

    const enrichedRequests = (requests || []).map(r => {
      const booking = bookingsMap[r.booking_id] || null;
      const eventId = r.event_id || booking?.event_id || null;

      let targetMemberInfo = null;
      if (r.target_member_id) {
        targetMemberInfo = membersMap[r.target_member_id] || null;
      } else if (r.target_email) {
        targetMemberInfo = {
          id: null,
          first_name: r.target_first_name || '',
          last_name: r.target_last_name || '',
          email: r.target_email,
          is_public: true,
          organisation: r.target_organisation || null,
          phone: r.target_phone || null,
        };
      }

      return {
        ...r,
        booking,
        member: membersMap[r.member_id] || null,
        target_member: targetMemberInfo,
        event: eventId ? (eventsMap[eventId] || null) : null,
      };
    });

    return res.json({ requests: enrichedRequests });
  } catch (err) {
    console.error('[TransferRequest] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
