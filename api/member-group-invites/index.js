import crypto from 'crypto';
import { supabase } from '../_lib/database.js';
import { getCallerGroupManageAccess, canManageGroup } from '../_lib/memberGroupAdminAccess.js';
import { hasFeatureAccess } from '../_lib/tenantContext.js';
import { sendRoleInviteEmail } from '../_lib/memberGroupRoleInviteNotification.js';

const INVITE_REPORT_FEATURE = 'membership.member-groups-invite-report';

/**
 * /api/member-group-invites — Task #1608 admin/group-admin invite management.
 *
 *  - GET  ?groupId=<uuid>  list invitations for a group the caller manages.
 *  - POST { action }       create | resend | cancel an invitation.
 *
 * Authorization: tenant admins (any group) or active group admins (their
 * administered groups), via getCallerGroupManageAccess.
 */

const DEFAULT_EXPIRY_DAYS = 14;

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function expiryIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + (days || DEFAULT_EXPIRY_DAYS));
  return d.toISOString();
}

function memberName(m) {
  if (!m) return '';
  return `${m.first_name || ''} ${m.last_name || ''}`.trim();
}

function inviteResponse(row, member) {
  return {
    id: row.id,
    group_id: row.group_id,
    member_id: row.member_id,
    member_name: member ? memberName(member) : (row.member_name || null),
    member_email: member ? member.email || null : null,
    group_role: row.group_role,
    status: row.status,
    expires_at: row.expires_at || null,
    decided_at: row.decided_at || null,
    created_at: row.created_at || null,
  };
}

async function loadGroup(tenantId, groupId) {
  const { data } = await supabase
    .from('member_group')
    .select('id, name, roles, tenant_id, terms_of_reference, role_terms_url')
    .eq('id', groupId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  return data || null;
}

async function loadTenant(tenantId) {
  const { data } = await supabase
    .from('tenant')
    .select('name, slug, primary_color')
    .eq('id', tenantId)
    .maybeSingle();
  return data || null;
}

function resolveRoleTermsUrl(group, role) {
  const map = group?.role_terms_url;
  const url = map && typeof map === 'object' ? map[role] : null;
  return url && String(url).trim() ? String(url).trim() : null;
}

async function dispatchInvite({ tenant, group, member, role, token }) {
  return sendRoleInviteEmail({
    toEmail: member.email,
    tenantId: group.tenant_id,
    tenantName: tenant?.name,
    tenantSlug: tenant?.slug,
    primaryColor: tenant?.primary_color,
    memberName: memberName(member),
    groupName: group.name,
    role,
    termsUrl: resolveRoleTermsUrl(group, role),
    token,
  });
}

export default async function handler(req, res) {
  const access = await getCallerGroupManageAccess(req);
  if (access.error) {
    return res.status(access.status).json({ error: access.error });
  }
  const tenantId = access.tenantContext.tenantId;

  if (req.method === 'GET') {
    const { groupId } = req.query;

    // Tenant-wide invite report: no groupId supplied. Tenant admins only,
    // gated server-side by the membership.member-groups-invite-report feature.
    if (!groupId) {
      if (!access.isTenantAdmin) {
        return res.status(403).json({ error: 'You do not have permission to view the invite report.' });
      }
      const roleId = access.tenantContext.roleId;
      if (roleId) {
        const allowed = await hasFeatureAccess(roleId, INVITE_REPORT_FEATURE);
        if (!allowed) {
          return res.status(403).json({ error: 'You do not have access to the Member Group Invite Report.' });
        }
      }

      const { data: invites, error } = await supabase
        .from('member_group_role_invitation')
        .select('id, group_id, member_id, group_role, status, expires_at, decided_at, created_at')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });
      if (error) {
        console.error('[MemberGroupInvites] report list error:', error.message || error);
        return res.status(500).json({ error: 'Failed to load invitations' });
      }

      const memberIds = [...new Set((invites || []).map((i) => i.member_id).filter(Boolean))];
      let membersById = new Map();
      if (memberIds.length) {
        const { data: memberRows } = await supabase
          .from('member')
          .select('id, first_name, last_name, email')
          .eq('tenant_id', tenantId)
          .in('id', memberIds);
        membersById = new Map((memberRows || []).map((m) => [m.id, m]));
      }

      const groupIds = [...new Set((invites || []).map((i) => i.group_id).filter(Boolean))];
      let groupsById = new Map();
      if (groupIds.length) {
        const { data: groupRows } = await supabase
          .from('member_group')
          .select('id, name')
          .eq('tenant_id', tenantId)
          .in('id', groupIds);
        groupsById = new Map((groupRows || []).map((g) => [g.id, g]));
      }

      const nowIso = new Date().toISOString();
      const out = (invites || []).map((row) => {
        const effective = { ...row };
        if (row.status === 'pending' && row.expires_at && new Date(row.expires_at).toISOString() < nowIso) {
          effective.status = 'expired';
        }
        return {
          ...inviteResponse(effective, membersById.get(row.member_id)),
          group_name: groupsById.get(row.group_id)?.name || null,
        };
      });

      return res.json({ success: true, invitations: out });
    }

    if (!canManageGroup(access, groupId)) {
      return res.status(403).json({ error: 'You do not have access to this group.' });
    }

    const { data: invites, error } = await supabase
      .from('member_group_role_invitation')
      .select('id, group_id, member_id, group_role, status, expires_at, decided_at, created_at')
      .eq('tenant_id', tenantId)
      .eq('group_id', groupId)
      .order('created_at', { ascending: false });
    if (error) {
      console.error('[MemberGroupInvites] list error:', error.message || error);
      return res.status(500).json({ error: 'Failed to load invitations' });
    }

    // Resolve member names/emails for display.
    const memberIds = [...new Set((invites || []).map((i) => i.member_id).filter(Boolean))];
    let membersById = new Map();
    if (memberIds.length) {
      const { data: memberRows } = await supabase
        .from('member')
        .select('id, first_name, last_name, email')
        .eq('tenant_id', tenantId)
        .in('id', memberIds);
      membersById = new Map((memberRows || []).map((m) => [m.id, m]));
    }

    const nowIso = new Date().toISOString();
    const out = (invites || []).map((row) => {
      const effective = { ...row };
      // Surface expired pending invites as 'expired' for display (not persisted).
      if (row.status === 'pending' && row.expires_at && new Date(row.expires_at).toISOString() < nowIso) {
        effective.status = 'expired';
      }
      return inviteResponse(effective, membersById.get(row.member_id));
    });

    return res.json({ success: true, invitations: out });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const action = (body.action || 'create').toString().toLowerCase();

    if (action === 'create') {
      const { groupId, memberId, role } = body;
      if (!groupId || !memberId || !role) {
        return res.status(400).json({ error: 'groupId, memberId and role are required' });
      }
      if (!canManageGroup(access, groupId)) {
        return res.status(403).json({ error: 'You do not have access to this group.' });
      }

      const group = await loadGroup(tenantId, groupId);
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }
      if (!Array.isArray(group.roles) || !group.roles.includes(role)) {
        return res.status(400).json({ error: 'That role does not exist on this group.' });
      }

      const { data: member } = await supabase
        .from('member')
        .select('id, first_name, last_name, email, tenant_id')
        .eq('id', memberId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!member) {
        return res.status(404).json({ error: 'Member not found' });
      }
      if (!member.email) {
        return res.status(400).json({ error: 'This member has no email address on file.' });
      }

      // Prevent duplicate pending invites for the same member+role+group.
      const { data: existing } = await supabase
        .from('member_group_role_invitation')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('group_id', groupId)
        .eq('member_id', memberId)
        .eq('group_role', role)
        .eq('status', 'pending')
        .maybeSingle();
      if (existing) {
        return res.status(409).json({ error: 'There is already a pending invitation for this member and role.' });
      }

      const token = newToken();
      const { data: inserted, error: insertErr } = await supabase
        .from('member_group_role_invitation')
        .insert({
          token,
          tenant_id: tenantId,
          group_id: groupId,
          member_id: memberId,
          group_role: role,
          status: 'pending',
          expires_at: expiryIso(),
          invited_by_member_id: access.memberId || null,
        })
        .select('id, group_id, member_id, group_role, status, expires_at, decided_at, created_at')
        .maybeSingle();
      if (insertErr || !inserted) {
        console.error('[MemberGroupInvites] insert error:', insertErr?.message || insertErr);
        return res.status(500).json({ error: 'Failed to create invitation' });
      }

      const tenant = await loadTenant(tenantId);
      const emailResult = await dispatchInvite({ tenant, group, member, role, token });

      return res.json({
        success: true,
        invitation: inviteResponse(inserted, member),
        emailSent: emailResult.success,
        emailError: emailResult.success ? null : emailResult.error,
      });
    }

    if (action === 'resend' || action === 'cancel') {
      const { invitationId } = body;
      if (!invitationId) {
        return res.status(400).json({ error: 'invitationId is required' });
      }
      const { data: invite } = await supabase
        .from('member_group_role_invitation')
        .select('id, tenant_id, group_id, member_id, group_role, status, token')
        .eq('id', invitationId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!invite) {
        return res.status(404).json({ error: 'Invitation not found' });
      }
      if (!canManageGroup(access, invite.group_id)) {
        return res.status(403).json({ error: 'You do not have access to this group.' });
      }
      if (invite.status !== 'pending') {
        return res.status(409).json({ error: 'Only pending invitations can be changed.' });
      }

      if (action === 'cancel') {
        const { error: cancelErr } = await supabase
          .from('member_group_role_invitation')
          .update({ status: 'cancelled', decided_at: new Date().toISOString() })
          .eq('id', invite.id)
          .eq('status', 'pending');
        if (cancelErr) {
          console.error('[MemberGroupInvites] cancel error:', cancelErr.message || cancelErr);
          return res.status(500).json({ error: 'Failed to cancel invitation' });
        }
        return res.json({ success: true });
      }

      // resend: regenerate the token (invalidating the old link) and extend expiry.
      const group = await loadGroup(tenantId, invite.group_id);
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }
      const { data: member } = await supabase
        .from('member')
        .select('id, first_name, last_name, email, tenant_id')
        .eq('id', invite.member_id)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!member || !member.email) {
        return res.status(400).json({ error: 'This member has no email address on file.' });
      }

      const token = newToken();
      const { error: updErr } = await supabase
        .from('member_group_role_invitation')
        .update({ token, expires_at: expiryIso() })
        .eq('id', invite.id)
        .eq('status', 'pending');
      if (updErr) {
        console.error('[MemberGroupInvites] resend update error:', updErr.message || updErr);
        return res.status(500).json({ error: 'Failed to resend invitation' });
      }

      const tenant = await loadTenant(tenantId);
      const emailResult = await dispatchInvite({ tenant, group, member, role: invite.group_role, token });

      return res.json({
        success: true,
        emailSent: emailResult.success,
        emailError: emailResult.success ? null : emailResult.error,
      });
    }

    return res.status(400).json({ error: 'Invalid action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
