import { supabase } from './database.js';
import { getTenantContext } from './tenantContext.js';

/**
 * Resolve the list of member_group entries the calling member is allowed
 * to use project boards for. Caller qualifies for a group when:
 *   - they have an active member_group_assignment row,
 *   - the group is active AND projects_enabled = true,
 *   - the assignment has not expired,
 *   - the assignment's group_role is in member_group.projects_enabled_roles.
 *
 * Returns { tenantContext, memberId, identityId, groups: [{groupId, groupName, role, projectsEnabledRoles, allRoles}] }.
 */
export async function getCallerProjectsAccess(req) {
  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return { error: 'Unauthorized - tenant required', status: 401, tenantContext, memberId: null, identityId: null, groups: [] };
  }
  const memberId = tenantContext.memberId;
  if (!memberId) {
    return { error: 'Forbidden - member session required', status: 403, tenantContext, memberId: null, identityId: null, groups: [] };
  }
  if (!supabase) {
    return { error: 'Database not configured', status: 500, tenantContext, memberId, identityId: null, groups: [] };
  }

  // Resolve identityId from the member row (project_board_member keys by identity_id).
  const { data: memberRow, error: memberErr } = await supabase
    .from('member')
    .select('identity_id')
    .eq('id', memberId)
    .maybeSingle();
  if (memberErr) {
    console.error('[MemberGroupProjectsAccess] member lookup failed:', memberErr.message || memberErr);
    return { error: 'Failed to resolve member identity', status: 500, tenantContext, memberId, identityId: null, groups: [] };
  }
  const identityId = memberRow?.identity_id || null;

  const nowIso = new Date().toISOString();

  const { data: assignments, error: assignErr } = await supabase
    .from('member_group_assignment')
    .select('group_id, group_role, expires_at')
    .eq('member_id', memberId);

  if (assignErr) {
    console.error('[MemberGroupProjectsAccess] assignment lookup failed:', assignErr.message || assignErr);
    return { error: 'Failed to resolve group access', status: 500, tenantContext, memberId, identityId, groups: [] };
  }

  const liveAssignments = (assignments || []).filter((a) => {
    if (!a.group_id || !a.group_role) return false;
    if (!a.expires_at) return true;
    return new Date(a.expires_at).toISOString() > nowIso;
  });

  if (liveAssignments.length === 0) {
    return { tenantContext, memberId, identityId, groups: [] };
  }

  const groupIds = [...new Set(liveAssignments.map((a) => a.group_id))];

  const { data: groupRows, error: groupErr } = await supabase
    .from('member_group')
    .select('id, name, is_active, projects_enabled, projects_enabled_roles, roles, tenant_id')
    .eq('tenant_id', tenantContext.tenantId)
    .in('id', groupIds);

  if (groupErr) {
    console.error('[MemberGroupProjectsAccess] group lookup failed:', groupErr.message || groupErr);
    return { error: 'Failed to resolve group access', status: 500, tenantContext, memberId, identityId, groups: [] };
  }

  const activeGroups = new Map();
  (groupRows || []).forEach((g) => {
    if (g.is_active === false) return;
    if (g.projects_enabled !== true) return;
    activeGroups.set(g.id, g);
  });

  const seen = new Set();
  const qualifying = [];
  for (const a of liveAssignments) {
    const g = activeGroups.get(a.group_id);
    if (!g) continue;
    const allowed = Array.isArray(g.projects_enabled_roles) ? g.projects_enabled_roles : [];
    if (!allowed.includes(a.group_role)) continue;
    const key = `${a.group_id}::${a.group_role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    qualifying.push({
      groupId: g.id,
      groupName: g.name,
      role: a.group_role,
      projectsEnabledRoles: allowed,
      allRoles: Array.isArray(g.roles) ? g.roles : [],
    });
  }

  return { tenantContext, memberId, identityId, groups: qualifying };
}

export function requireProjectsGroupAccess(qualifyingGroups, groupId) {
  if (!groupId) return null;
  return qualifyingGroups.find((g) => g.groupId === groupId) || null;
}

/**
 * Recompute the qualifying-member set for a group and reconcile
 * project_board_member across every non-archived board linked to that group:
 * insert missing qualifying members as 'member', delete rows for non-qualifying
 * members. Never touches rows whose existing role is 'admin' or 'owner' (so
 * the creator/admin role is preserved).
 *
 * Best-effort: logs errors but never throws — sync is a background concern.
 */
export async function syncProjectBoardMembersForGroup(groupId) {
  if (!supabase || !groupId) return { ok: false, reason: 'no_supabase_or_group' };

  try {
    const { data: group, error: groupErr } = await supabase
      .from('member_group')
      .select('id, is_active, projects_enabled, projects_enabled_roles')
      .eq('id', groupId)
      .maybeSingle();
    if (groupErr || !group) {
      return { ok: false, reason: 'group_not_found' };
    }

    const { data: boards, error: boardsErr } = await supabase
      .from('project_board')
      .select('id')
      .eq('member_group_id', groupId)
      .eq('is_archived', false);
    if (boardsErr) {
      console.error('[syncProjectBoardMembersForGroup] boards lookup failed:', boardsErr.message);
      return { ok: false, reason: 'boards_lookup_failed' };
    }
    const boardIds = (boards || []).map((b) => b.id);
    if (boardIds.length === 0) {
      return { ok: true, boardsAffected: 0, qualifiedCount: 0 };
    }

    const allowed = Array.isArray(group.projects_enabled_roles) ? group.projects_enabled_roles : [];
    let qualifyingIdentityIds = new Set();

    if (group.is_active && group.projects_enabled && allowed.length > 0) {
      const nowIso = new Date().toISOString();
      const { data: assignments, error: assignErr } = await supabase
        .from('member_group_assignment')
        .select('member_id, group_role, expires_at')
        .eq('group_id', groupId);
      if (assignErr) {
        console.error('[syncProjectBoardMembersForGroup] assignments lookup failed:', assignErr.message);
        return { ok: false, reason: 'assignments_lookup_failed' };
      }
      const live = (assignments || []).filter((a) => {
        if (!a.member_id || !a.group_role) return false;
        if (!allowed.includes(a.group_role)) return false;
        if (!a.expires_at) return true;
        return new Date(a.expires_at).toISOString() > nowIso;
      });
      const memberIds = [...new Set(live.map((a) => a.member_id))];
      if (memberIds.length > 0) {
        const { data: members, error: membersErr } = await supabase
          .from('member')
          .select('id, identity_id')
          .in('id', memberIds);
        if (membersErr) {
          console.error('[syncProjectBoardMembersForGroup] members lookup failed:', membersErr.message);
          return { ok: false, reason: 'members_lookup_failed' };
        }
        (members || []).forEach((m) => {
          if (m.identity_id) qualifyingIdentityIds.add(m.identity_id);
        });
      }
    }

    let upserts = 0;
    let deletes = 0;
    for (const boardId of boardIds) {
      const { data: existingRows, error: existingErr } = await supabase
        .from('project_board_member')
        .select('identity_id, role')
        .eq('board_id', boardId);
      if (existingErr) {
        console.error('[syncProjectBoardMembersForGroup] board members lookup failed:', existingErr.message);
        continue;
      }
      const existing = new Map();
      (existingRows || []).forEach((r) => existing.set(r.identity_id, r.role));

      // Insert missing qualifying members as 'member'.
      const toInsert = [];
      for (const idtyId of qualifyingIdentityIds) {
        if (!existing.has(idtyId)) {
          toInsert.push({ board_id: boardId, identity_id: idtyId, role: 'member' });
        }
      }
      if (toInsert.length > 0) {
        const { error: insErr } = await supabase
          .from('project_board_member')
          .insert(toInsert);
        if (insErr) {
          console.error('[syncProjectBoardMembersForGroup] insert failed:', insErr.message);
        } else {
          upserts += toInsert.length;
        }
      }

      // Delete rows for non-qualifying members, but never touch admin/owner.
      const toDelete = [];
      for (const [idtyId, role] of existing.entries()) {
        if (role === 'admin' || role === 'owner') continue;
        if (!qualifyingIdentityIds.has(idtyId)) toDelete.push(idtyId);
      }
      if (toDelete.length > 0) {
        const { error: delErr } = await supabase
          .from('project_board_member')
          .delete()
          .eq('board_id', boardId)
          .in('identity_id', toDelete);
        if (delErr) {
          console.error('[syncProjectBoardMembersForGroup] delete failed:', delErr.message);
        } else {
          deletes += toDelete.length;
        }
      }
    }

    return { ok: true, boardsAffected: boardIds.length, qualifiedCount: qualifyingIdentityIds.size, upserts, deletes };
  } catch (err) {
    console.error('[syncProjectBoardMembersForGroup] unexpected error:', err.message || err);
    return { ok: false, reason: 'exception' };
  }
}

/**
 * Hook invoked after a member-group create/update or member-group-assignment
 * create/update/delete. Looks at the affected entity row and dispatches to
 * syncProjectBoardMembersForGroup for the affected group_id(s). Best-effort.
 *
 * `entityNorm` is the lowercased entity slug ('membergroup' / 'membergroupassignment').
 * `data` is the after-state (post-insert / post-update / pre-delete) row.
 * `beforeData` is the before-state for PATCH/DELETE (or null for POST).
 *
 * For MemberGroup we also auto-provision a default board on false->true
 * transition and archive boards on true->false transition.
 */
export async function handleMemberGroupEntityChange({ entityNorm, action, data, beforeData, actorIdentityId }) {
  if (!supabase) return;
  try {
    if (entityNorm === 'membergroup') {
      const groupId = data?.id || beforeData?.id;
      if (!groupId) return;

      const wasEnabled = beforeData?.projects_enabled === true;
      const isEnabled = data?.projects_enabled === true;

      // false -> true: auto-provision a default board if none exists.
      if (!wasEnabled && isEnabled) {
        const { data: existing } = await supabase
          .from('project_board')
          .select('id')
          .eq('member_group_id', groupId)
          .limit(1);
        if (!existing || existing.length === 0) {
          const tenantId = data?.tenant_id || beforeData?.tenant_id || null;
          if (tenantId) {
            const { data: board, error: boardErr } = await supabase
              .from('project_board')
              .insert({
                tenant_id: tenantId,
                name: data?.name || 'Group Board',
                color: '#6366f1',
                visibility: 'private',
                member_group_id: groupId,
                created_by: actorIdentityId || null,
              })
              .select()
              .single();
            if (boardErr) {
              console.error('[handleMemberGroupEntityChange] auto-provision board failed:', boardErr.message);
            } else if (board) {
              if (actorIdentityId) {
                await supabase.from('project_board_member').insert({
                  board_id: board.id,
                  identity_id: actorIdentityId,
                  role: 'admin',
                  added_by: actorIdentityId,
                }).then(({ error }) => {
                  if (error) console.error('[handleMemberGroupEntityChange] add creator failed:', error.message);
                });
              }
              const defaultLabels = [
                { name: 'High Priority', color: '#ef4444' },
                { name: 'Medium Priority', color: '#f59e0b' },
                { name: 'Low Priority', color: '#22c55e' },
                { name: 'Bug', color: '#dc2626' },
                { name: 'Feature', color: '#3b82f6' },
                { name: 'Enhancement', color: '#8b5cf6' },
              ];
              await supabase.from('project_label').insert(
                defaultLabels.map((l) => ({ board_id: board.id, name: l.name, color: l.color }))
              );
            }
          }
        }
      }

      // true -> false: archive every board linked to this group.
      if (wasEnabled && !isEnabled) {
        const { error: archErr } = await supabase
          .from('project_board')
          .update({ is_archived: true })
          .eq('member_group_id', groupId)
          .eq('is_archived', false);
        if (archErr) {
          console.error('[handleMemberGroupEntityChange] archive boards failed:', archErr.message);
        }
      }

      // Always sync membership when projects_enabled or roles or active state changed.
      const rolesBefore = JSON.stringify((beforeData?.projects_enabled_roles) || []);
      const rolesAfter = JSON.stringify((data?.projects_enabled_roles) || []);
      const activeBefore = beforeData?.is_active;
      const activeAfter = data?.is_active;
      const changed =
        wasEnabled !== isEnabled ||
        rolesBefore !== rolesAfter ||
        (activeBefore !== undefined && activeBefore !== activeAfter);
      if (changed || action === 'create') {
        await syncProjectBoardMembersForGroup(groupId);
      }
      return;
    }

    if (entityNorm === 'membergroupassignment') {
      const groupIds = new Set();
      if (data?.group_id) groupIds.add(data.group_id);
      if (beforeData?.group_id) groupIds.add(beforeData.group_id);
      for (const gid of groupIds) {
        await syncProjectBoardMembersForGroup(gid);
      }
    }
  } catch (err) {
    console.error('[handleMemberGroupEntityChange] unexpected error:', err.message || err);
  }
}
