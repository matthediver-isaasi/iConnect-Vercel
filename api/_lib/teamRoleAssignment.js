export const TEAM_LOGIN_ACCESS_FEATURE = 'membership.team.login-access-toggle';

function stringIds(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((id) => typeof id === 'string' && id))]
    : [];
}

export function isStrictIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function validateRoleAssignmentPolicy({
  tenantCtx,
  targetMember,
  callerRole,
  destinationRole,
  effectiveFrom,
  privileged = false,
}) {
  if (!targetMember) {
    return { ok: false, status: 404, error: 'Member not found' };
  }
  if (!destinationRole) {
    return privileged
      ? { ok: true }
      : { ok: false, status: 403, error: 'Your role is not permitted to remove a team member role' };
  }
  if (destinationRole.tenant_id !== targetMember.tenant_id) {
    return { ok: false, status: 403, error: 'The selected role is not available in this tenant' };
  }
  if (!privileged) {
    if (!tenantCtx?.roleId || !callerRole) {
      return { ok: false, status: 403, error: 'Login Access permission is required to change team roles' };
    }
    if (targetMember.organization_id !== tenantCtx.organizationId) {
      return { ok: false, status: 403, error: 'You can only change roles for members of your organisation' };
    }
    if (destinationRole.is_tenant_admin === true) {
      return { ok: false, status: 403, error: 'Tenant administrator roles cannot be assigned from the Team page' };
    }
    if (!stringIds(callerRole.assignable_role_ids).includes(destinationRole.id)) {
      return { ok: false, status: 403, error: 'Your role is not permitted to assign the selected role' };
    }
  }
  if (destinationRole.requires_effective_from_date === true) {
    if (!isStrictIsoDate(effectiveFrom)) {
      return { ok: false, status: 400, error: 'An Effective From date is required for the selected role' };
    }
  }
  return { ok: true };
}

export function isRoleAtCapacity(currentCount, maxMembers) {
  return maxMembers !== null
    && maxMembers !== undefined
    && Number(currentCount || 0) >= Number(maxMembers);
}

export async function validateAssignableRoleIds({ supabase, tenantId, roleIds }) {
  const ids = stringIds(roleIds);
  if (ids.length === 0) return { ok: true, roleIds: [] };
  const { data, error } = await supabase
    .from('role')
    .select('id, is_tenant_admin')
    .eq('tenant_id', tenantId)
    .in('id', ids);
  if (error) return { ok: false, status: 500, error: 'Failed to validate assignable roles' };
  if ((data || []).length !== ids.length || data.some((role) => role.is_tenant_admin === true)) {
    return {
      ok: false,
      status: 400,
      error: 'Assignable roles must be non-administrator roles from the same tenant',
    };
  }
  return { ok: true, roleIds: ids };
}

export async function authorizeAndCheckTeamRoleAssignment({
  supabase,
  tenantCtx,
  memberId,
  targetMember: suppliedTargetMember,
  destinationRoleId,
  effectiveFrom,
  hasAdminAccess,
  hasFeatureAccess,
}) {
  let targetMember = suppliedTargetMember || null;
  if (!targetMember) {
    const { data, error: memberError } = await supabase
      .from('member')
      .select('id, tenant_id, organization_id, role_id')
      .eq('id', memberId)
      .eq('tenant_id', tenantCtx.tenantId)
      .maybeSingle();
    if (memberError) {
      return { ok: false, status: 500, error: 'Failed to validate the target member' };
    }
    targetMember = data;
  }
  if (!targetMember) return { ok: false, status: 404, error: 'Member not found' };
  const roleChanged = targetMember.role_id !== destinationRoleId;

  const privileged = !!tenantCtx.tenantUserId || await hasAdminAccess(tenantCtx);
  let callerRole = null;
  if (!privileged) {
    const hasPermission = await hasFeatureAccess(tenantCtx.roleId, TEAM_LOGIN_ACCESS_FEATURE);
    if (!hasPermission) {
      return { ok: false, status: 403, error: 'Login Access permission is required to change team roles' };
    }
    const { data, error } = await supabase
      .from('role')
      .select('id, tenant_id, assignable_role_ids')
      .eq('id', tenantCtx.roleId)
      .eq('tenant_id', tenantCtx.tenantId)
      .maybeSingle();
    if (error) return { ok: false, status: 500, error: 'Failed to validate your role assignment policy' };
    callerRole = data;
  }

  let destinationRole = null;
  if (destinationRoleId) {
    const { data, error: roleError } = await supabase
      .from('role')
      .select('id, tenant_id, name, max_members, is_tenant_admin, requires_effective_from_date')
      .eq('id', destinationRoleId)
      .eq('tenant_id', tenantCtx.tenantId)
      .maybeSingle();
    if (roleError) return { ok: false, status: 500, error: 'Failed to validate the selected role' };
    destinationRole = data;
  }

  const policy = validateRoleAssignmentPolicy({
    tenantCtx,
    targetMember,
    callerRole,
    destinationRole,
    effectiveFrom,
    privileged,
  });
  if (!policy.ok) return policy;

  if (roleChanged && destinationRole
    && destinationRole.max_members !== null && destinationRole.max_members !== undefined) {
    if (!targetMember.organization_id) {
      return {
        ok: false,
        status: 400,
        error: 'Organisation context is required to assign a capacity-limited role',
      };
    }
    const { count, error: countError } = await supabase
      .from('member')
      .select('id', { count: 'exact', head: true })
      .eq('role_id', destinationRoleId)
      .eq('organization_id', targetMember.organization_id)
      .eq('login_enabled', true)
      .neq('id', memberId);
    if (countError) return { ok: false, status: 500, error: 'Failed to validate role capacity' };
    const currentCount = count || 0;
    if (isRoleAtCapacity(currentCount, destinationRole.max_members)) {
      return {
        ok: false,
        status: 409,
        error: `The "${destinationRole.name}" role is full (${currentCount}/${destinationRole.max_members}) for this organisation.`,
      };
    }
  }

  return { ok: true, targetMember, destinationRole, unchanged: !roleChanged };
}