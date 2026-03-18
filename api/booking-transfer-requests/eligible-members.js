import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';

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

  let member = await getSessionMember(req);
  let isAdmin = false;
  let tenantId = null;

  const ctx = await getTenantContext(req);
  if (ctx?.isAuthenticated) {
    isAdmin = await hasAdminAccess(ctx);
  }

  if (member) {
    tenantId = member.organization?.tenant_id || member.tenant_id;
  } else if (isAdmin) {
    tenantId = ctx.tenantId;
  }

  if (!tenantId) {
    return res.status(401).json({ error: 'Not authenticated' });
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
      console.log('[TransferEligible] Booking not found:', booking_id, bookingError?.message);
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (!isAdmin) {
      const memberEmail = member.email?.toLowerCase();
      const isOwner = booking.member_id === member.id ||
        (booking.attendee_email || '').toLowerCase() === memberEmail;

      if (!isOwner) {
        return res.status(403).json({ error: 'You can only transfer your own bookings' });
      }
    }

    const { data: transferRoleSetting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'transfer_restrict_by_role')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    const restrictByRole = transferRoleSetting?.setting_value !== 'false';

    console.log('[TransferEligible] booking_id:', booking_id, 'org_id:', booking.organization_id, 'restrictByRole:', restrictByRole);

    const searchPattern = `%${query}%`;

    let membersQuery = supabase
      .from('member')
      .select('id, first_name, last_name, email')
      .eq('tenant_id', tenantId)
      .not('email', 'ilike', 'deleted_%@deleted.local')
      .or(`first_name.ilike.${searchPattern},last_name.ilike.${searchPattern},email.ilike.${searchPattern}`)
      .limit(20);

    if (member?.id) {
      membersQuery = membersQuery.neq('id', member.id);
    }

    if (booking.organization_id) {
      membersQuery = membersQuery.eq('organization_id', booking.organization_id);
    }

    const { data: members, error: searchError } = await membersQuery;

    if (searchError) {
      console.error('[TransferEligible] Search error:', searchError);
      return res.status(500).json({ error: 'Failed to search members' });
    }

    if (!members || members.length === 0) {
      console.log('[TransferEligible] No members found matching query:', query);
      return res.json([]);
    }

    let eligibleMembers = members;

    if (booking.organization_id && restrictByRole) {
      let attendeeMemberId = booking.member_id;
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

      let roleId = null;
      if (attendeeMemberId) {
        const { data: teamMember } = await supabase
          .from('team_member')
          .select('role_id')
          .eq('organization_id', booking.organization_id)
          .eq('member_id', attendeeMemberId)
          .maybeSingle();

        roleId = teamMember?.role_id || null;
      }

      console.log('[TransferEligible] Role restriction active, attendee roleId:', roleId);

      if (roleId) {
        const memberIds = members.map(m => m.id);

        const { data: teamMembers } = await supabase
          .from('team_member')
          .select('member_id')
          .eq('organization_id', booking.organization_id)
          .eq('role_id', roleId)
          .in('member_id', memberIds);

        const eligibleMemberIds = new Set((teamMembers || []).map(tm => tm.member_id));
        eligibleMembers = members.filter(m => eligibleMemberIds.has(m.id));
        console.log('[TransferEligible] After role filter:', eligibleMembers.length, 'of', members.length);
      }
    }

    if (booking.attendee_email) {
      const currentEmail = booking.attendee_email.toLowerCase();
      eligibleMembers = eligibleMembers.filter(m =>
        (m.email || '').toLowerCase() !== currentEmail
      );
    }

    console.log('[TransferEligible] Returning', eligibleMembers.length, 'eligible members');
    return res.json(eligibleMembers);
  } catch (err) {
    console.error('[TransferEligible] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
