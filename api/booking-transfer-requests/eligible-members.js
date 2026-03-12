import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const member = await getSessionMember(req);
  if (!member) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const tenantId = member.organization?.tenant_id || member.tenant_id;
  if (!tenantId) {
    return res.status(400).json({ error: 'Could not determine tenant' });
  }

  const { booking_id, q: query } = req.query;

  if (!booking_id) {
    return res.status(400).json({ error: 'booking_id is required' });
  }

  if (!query || query.length < 2) {
    return res.json([]);
  }

  try {
    const { data: booking, error: bookingError } = await supabase
      .from('booking')
      .select('id, attendee_email, attendee_first_name, attendee_last_name, member_id, organization_id, event_id, tenant_id')
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
      return res.status(403).json({ error: 'You can only transfer your own bookings' });
    }

    const { data: transferRoleSetting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'transfer_restrict_by_role')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    const restrictByRole = transferRoleSetting?.setting_value !== 'false';

    let roleId = null;
    let attendeeMemberId = booking.member_id;
    if (booking.organization_id && restrictByRole) {
      if (booking.attendee_email) {
        const { data: attendeeMember } = await supabase
          .from('member')
          .select('id')
          .eq('tenant_id', tenantId)
          .ilike('email', booking.attendee_email)
          .maybeSingle();
        if (attendeeMember) {
          attendeeMemberId = attendeeMember.id;
        }
      }

      if (attendeeMemberId) {
        const { data: teamMember } = await supabase
          .from('team_member')
          .select('role_id')
          .eq('organization_id', booking.organization_id)
          .eq('member_id', attendeeMemberId)
          .maybeSingle();

        roleId = teamMember?.role_id || null;
      }
    }

    const searchPattern = `%${query}%`;

    let membersQuery = supabase
      .from('member')
      .select('id, first_name, last_name, email')
      .eq('tenant_id', tenantId)
      .not('email', 'ilike', 'deleted_%@deleted.local')
      .neq('id', member.id)
      .or(`first_name.ilike.${searchPattern},last_name.ilike.${searchPattern},email.ilike.${searchPattern}`)
      .limit(20);

    const { data: members, error: searchError } = await membersQuery;

    if (searchError) {
      console.error('[TransferEligible] Search error:', searchError);
      return res.status(500).json({ error: 'Failed to search members' });
    }

    if (!members || members.length === 0) {
      return res.json([]);
    }

    let eligibleMembers = members;

    if (booking.organization_id) {
      const memberIds = members.map(m => m.id);

      let teamQuery = supabase
        .from('team_member')
        .select('member_id, role_id')
        .eq('organization_id', booking.organization_id)
        .in('member_id', memberIds);

      if (roleId) {
        teamQuery = teamQuery.eq('role_id', roleId);
      }

      const { data: teamMembers } = await teamQuery;
      const eligibleMemberIds = new Set((teamMembers || []).map(tm => tm.member_id));

      eligibleMembers = members.filter(m => eligibleMemberIds.has(m.id));
    }

    if (booking.attendee_email) {
      const currentEmail = booking.attendee_email.toLowerCase();
      eligibleMembers = eligibleMembers.filter(m =>
        (m.email || '').toLowerCase() !== currentEmail
      );
    }

    return res.json(eligibleMembers);
  } catch (err) {
    console.error('[TransferEligible] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
