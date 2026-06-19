import { supabase } from '../../_lib/database.js';

// Public, tokenised member-group role invitation endpoint (Task #1608).
//
// GET  -> returns the invite context (member/group/role), resolved terms of
//         reference (role terms, falling back to the group's terms) and tenant
//         branding so the public page can render. No state change.
// POST -> body { action: 'accept' | 'decline' }. On the first valid action it
//         atomically claims the still-pending token. Accept creates/updates the
//         member_group_assignment with the invited role; decline just records
//         the decision. Re-clicked / expired links return a friendly state.

function resolveRoleTerms(group, role) {
  const map = group?.role_terms_of_reference;
  const roleTerms = map && typeof map === 'object' ? map[role] : null;
  if (roleTerms && String(roleTerms).trim()) return roleTerms;
  return group?.terms_of_reference || null;
}

function isExpired(row) {
  return !!row.expires_at && new Date(row.expires_at).toISOString() < new Date().toISOString();
}

function effectiveStatus(row) {
  if (row.status === 'pending' && isExpired(row)) return 'expired';
  return row.status;
}

function buildResponse({ row, member, group, tenant, extra }) {
  return {
    status: effectiveStatus(row),
    member: {
      name: member ? `${member.first_name || ''} ${member.last_name || ''}`.trim() : null,
      email: member?.email || null,
    },
    group: {
      name: group?.name || null,
    },
    role: row.group_role,
    terms_of_reference: group ? resolveRoleTerms(group, row.group_role) : null,
    expires_at: row.expires_at || null,
    decided_at: row.decided_at || null,
    tenant: tenant
      ? {
          name: tenant.name || null,
          logo_url: tenant.logo_url || null,
          primary_color: tenant.primary_color || null,
        }
      : null,
    ...(extra || {}),
  };
}

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { token } = req.query;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Token required' });
  }

  const { data: row, error: tokenErr } = await supabase
    .from('member_group_role_invitation')
    .select('id, tenant_id, group_id, member_id, group_role, status, expires_at, decided_at, assignment_id')
    .eq('token', token)
    .maybeSingle();

  if (tokenErr || !row) {
    return res.status(404).json({ error: 'This invitation link is invalid or has been removed.' });
  }

  const [{ data: member }, { data: group }, { data: tenant }] = await Promise.all([
    supabase.from('member').select('id, first_name, last_name, email').eq('id', row.member_id).maybeSingle(),
    supabase.from('member_group').select('id, name, terms_of_reference, role_terms_of_reference, is_active').eq('id', row.group_id).maybeSingle(),
    supabase.from('tenant').select('name, logo_url, primary_color').eq('id', row.tenant_id).maybeSingle(),
  ]);

  if (req.method === 'GET') {
    return res.json(buildResponse({ row, member, group, tenant }));
  }

  if (req.method === 'POST') {
    const action = (req.body?.action || '').toString().toLowerCase();
    if (action !== 'accept' && action !== 'decline') {
      return res.status(400).json({ error: "Invalid action. Use 'accept' or 'decline'." });
    }

    // Already handled — return the existing state.
    if (row.status !== 'pending') {
      return res.json(buildResponse({ row, member, group, tenant, extra: { alreadyHandled: true } }));
    }

    // Expired pending invite — cannot be actioned.
    if (isExpired(row)) {
      return res.json(buildResponse({ row, member, group, tenant, extra: { expired: true } }));
    }

    const newStatus = action === 'accept' ? 'accepted' : 'declined';
    const decidedAt = new Date().toISOString();

    // Atomically claim the token: only move it from 'pending'.
    const { data: claimed, error: claimErr } = await supabase
      .from('member_group_role_invitation')
      .update({ status: newStatus, decided_at: decidedAt })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();

    if (claimErr) {
      console.error('[RoleInvite] Failed to update invitation:', claimErr.message);
      return res.status(500).json({ error: 'Could not record your decision. Please try again.' });
    }

    if (!claimed) {
      // Lost the race — re-read and report the final state.
      const { data: fresh } = await supabase
        .from('member_group_role_invitation')
        .select('id, tenant_id, group_id, member_id, group_role, status, expires_at, decided_at, assignment_id')
        .eq('id', row.id)
        .maybeSingle();
      return res.json(buildResponse({ row: fresh || row, member, group, tenant, extra: { alreadyHandled: true } }));
    }

    if (action === 'accept') {
      // Create or update the member_group_assignment with the invited role.
      const { data: existingAssignment } = await supabase
        .from('member_group_assignment')
        .select('id')
        .eq('tenant_id', row.tenant_id)
        .eq('group_id', row.group_id)
        .eq('member_id', row.member_id)
        .maybeSingle();

      let assignmentId = existingAssignment?.id || null;
      let assignmentError = null;

      if (existingAssignment) {
        const { error: updErr } = await supabase
          .from('member_group_assignment')
          .update({ group_role: row.group_role })
          .eq('id', existingAssignment.id);
        assignmentError = updErr;
      } else {
        const { data: insertedAssignment, error: insErr } = await supabase
          .from('member_group_assignment')
          .insert({
            tenant_id: row.tenant_id,
            group_id: row.group_id,
            member_id: row.member_id,
            group_role: row.group_role,
          })
          .select('id')
          .maybeSingle();
        assignmentError = insErr;
        assignmentId = insertedAssignment?.id || null;
      }

      if (assignmentError) {
        console.error('[RoleInvite] Failed to apply assignment:', assignmentError.message);
        return res.json(buildResponse({
          row: { ...row, status: newStatus, decided_at: decidedAt },
          member,
          group,
          tenant,
          extra: { warning: 'Your acceptance was recorded, but the role could not be applied automatically. Please contact the group administrator.' },
        }));
      }

      if (assignmentId) {
        await supabase
          .from('member_group_role_invitation')
          .update({ assignment_id: assignmentId })
          .eq('id', row.id);
      }
    }

    return res.json(buildResponse({
      row: { ...row, status: newStatus, decided_at: decidedAt },
      member,
      group,
      tenant,
    }));
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
