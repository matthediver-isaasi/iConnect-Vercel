import { getSession, getSessionMember } from './session.js';

const cleanString = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
const roleKey = (value) => cleanString(value).toLocaleLowerCase('en-US');

export function normalizeFormAccessPolicy(input) {
  if (input === null || input === undefined || input === '') {
    return { ok: true, policy: null, restricted: false };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'access_policy must be an object' };
  }
  if (Object.keys(input).length === 0) {
    return { ok: true, policy: null, restricted: false };
  }
  if (input.version !== 1) {
    return { ok: false, error: 'access_policy.version must be 1' };
  }
  if (!['and', 'or'].includes(input.operator)) {
    return { ok: false, error: 'access_policy.operator must be "and" or "or"' };
  }
  if (!Array.isArray(input.group_rules) || !Array.isArray(input.rbac_role_ids)) {
    return { ok: false, error: 'access_policy group_rules and rbac_role_ids must be arrays' };
  }

  const groupRules = [];
  const seenGroups = new Set();
  for (const rule of input.group_rules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      return { ok: false, error: 'Each access policy group rule must be an object' };
    }
    const groupId = cleanString(rule.group_id);
    if (!groupId || !Array.isArray(rule.role_names)) {
      return { ok: false, error: 'Each group rule requires group_id and role_names' };
    }
    if (seenGroups.has(groupId)) {
      return { ok: false, error: `Duplicate group rule: ${groupId}` };
    }
    seenGroups.add(groupId);
    const roleNames = [];
    const seenRoles = new Set();
    for (const raw of rule.role_names) {
      if (typeof raw !== 'string' || !raw.trim()) {
        return { ok: false, error: 'Group role names must be non-empty strings' };
      }
      const name = cleanString(raw);
      const key = roleKey(name);
      if (!name || seenRoles.has(key)) continue;
      seenRoles.add(key);
      roleNames.push(name);
    }
    groupRules.push({ group_id: groupId, role_names: roleNames });
  }

  if (input.rbac_role_ids.some((id) => typeof id !== 'string' || !id.trim())) {
    return { ok: false, error: 'RBAC role IDs must be non-empty strings' };
  }
  const roleIds = [...new Set(input.rbac_role_ids.map(cleanString))];
  const policy = {
    version: 1,
    group_rules: groupRules,
    rbac_role_ids: roleIds,
    operator: input.operator,
  };
  return {
    ok: true,
    policy,
    restricted: groupRules.length > 0 || roleIds.length > 0,
  };
}

export function formAccessDeniedOutcome(code = 'FORM_ACCESS_DENIED') {
  return {
    allowed: false,
    restricted: true,
    access_policy_required: true,
    requires_authentication: code === 'AUTHENTICATION_REQUIRED',
    code,
  };
}

export async function validateFormAccessPolicy({ supabase, tenantId, policy: input }) {
  const normalized = normalizeFormAccessPolicy(input);
  if (!normalized.ok || !normalized.restricted) return normalized;
  if (!supabase || !tenantId) return { ok: false, error: 'Cannot validate access policy without tenant context' };

  try {
    const groupIds = normalized.policy.group_rules.map((rule) => rule.group_id);
    const roleIds = normalized.policy.rbac_role_ids;
    const [groupResult, roleResult] = await Promise.all([
      groupIds.length
        ? supabase.from('member_group').select('id, roles, is_active').eq('tenant_id', tenantId).in('id', groupIds)
        : Promise.resolve({ data: [], error: null }),
      roleIds.length
        ? supabase.from('role').select('id').eq('tenant_id', tenantId).in('id', roleIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (groupResult.error || roleResult.error) {
      return { ok: false, error: 'Failed to validate access policy references' };
    }
    const groups = new Map((groupResult.data || []).map((group) => [group.id, group]));
    const validRoleIds = new Set((roleResult.data || []).map((role) => role.id));
    if (validRoleIds.size !== roleIds.length) {
      return { ok: false, error: 'One or more access policy roles do not belong to this tenant' };
    }
    for (const rule of normalized.policy.group_rules) {
      const group = groups.get(rule.group_id);
      if (!group || group.is_active !== true) {
        return { ok: false, error: 'One or more access policy groups are missing, inactive, or belong to another tenant' };
      }
      const canonical = new Map((group.roles || []).map((name) => [roleKey(name), cleanString(name)]).filter(([key]) => key));
      const resolvedNames = [];
      for (const requested of rule.role_names) {
        const resolved = canonical.get(roleKey(requested));
        if (!resolved) return { ok: false, error: `Unknown role "${requested}" for the selected member group` };
        resolvedNames.push(resolved);
      }
      rule.role_names = resolvedNames;
    }
    return normalized;
  } catch {
    return { ok: false, error: 'Failed to validate access policy references' };
  }
}

export async function resolveFormAccess({
  supabase,
  req,
  tenantId,
  policy: input,
  session = undefined,
  member = undefined,
  now = Date.now(),
}) {
  const normalized = normalizeFormAccessPolicy(input);
  if (!normalized.ok) return formAccessDeniedOutcome('INVALID_ACCESS_POLICY');
  if (!normalized.restricted) {
    return { allowed: true, restricted: false, access_policy_required: false, requires_authentication: false, code: 'UNRESTRICTED' };
  }
  try {
    const activeSession = session === undefined ? await getSession(req) : session;
    if (!activeSession) return formAccessDeniedOutcome('AUTHENTICATION_REQUIRED');
    const sessionTenantId = activeSession.data?.tenantId || activeSession.data?.preservedTenantId || null;
    if (sessionTenantId && sessionTenantId !== tenantId) return formAccessDeniedOutcome('TENANT_MISMATCH');

    const activeMember = member === undefined ? await getSessionMember(req) : member;
    const memberTenantId = activeMember?.tenant_id || activeMember?.organization?.tenant_id || null;
    if (!activeMember || memberTenantId !== tenantId) return formAccessDeniedOutcome('TENANT_MISMATCH');

    const groupIds = normalized.policy.group_rules.map((rule) => rule.group_id);
    const roleIds = normalized.policy.rbac_role_ids;
    const [groupsResult, rolesResult, assignmentsResult] = await Promise.all([
      groupIds.length
        ? supabase.from('member_group').select('id, roles, is_active').eq('tenant_id', tenantId).in('id', groupIds)
        : Promise.resolve({ data: [], error: null }),
      roleIds.length
        ? supabase.from('role').select('id').eq('tenant_id', tenantId).in('id', roleIds)
        : Promise.resolve({ data: [], error: null }),
      groupIds.length
        ? supabase.from('member_group_assignment').select('group_id, group_role, expires_at')
          .eq('tenant_id', tenantId).eq('member_id', activeMember.id).in('group_id', groupIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (groupsResult.error || rolesResult.error || assignmentsResult.error) {
      return formAccessDeniedOutcome('ACCESS_LOOKUP_FAILED');
    }

    // A policy is invalid as a whole when any stored reference has gone stale.
    // Do not allow the other side of an OR policy to mask a deleted/inactive
    // group, removed group role, or deleted/cross-tenant RBAC role.
    const groups = new Map((groupsResult.data || []).map((group) => [group.id, group]));
    const liveRoleIds = new Set((rolesResult.data || []).map((role) => role.id));
    if (liveRoleIds.size !== roleIds.length) {
      return formAccessDeniedOutcome('INVALID_ACCESS_POLICY');
    }
    for (const rule of normalized.policy.group_rules) {
      const group = groups.get(rule.group_id);
      if (!group || group.is_active !== true) {
        return formAccessDeniedOutcome('INVALID_ACCESS_POLICY');
      }
      const canonicalRoles = new Set((group.roles || []).map(roleKey).filter(Boolean));
      if (rule.role_names.some((roleName) => !canonicalRoles.has(roleKey(roleName)))) {
        return formAccessDeniedOutcome('INVALID_ACCESS_POLICY');
      }
    }

    const checks = [];
    if (roleIds.length) {
      checks.push(roleIds.includes(activeMember.role_id));
    }
    if (groupIds.length) {
      const groupMatch = normalized.policy.group_rules.some((rule) => {
        const group = groups.get(rule.group_id);
        const canonicalRoles = new Set((group.roles || []).map(roleKey).filter(Boolean));
        const requiredRoles = new Set(rule.role_names.map(roleKey));
        return (assignmentsResult.data || []).some((assignment) => {
          if (assignment.group_id !== rule.group_id) return false;
          const expiry = assignment.expires_at ? Date.parse(assignment.expires_at) : null;
          if (expiry !== null && (!Number.isFinite(expiry) || expiry <= now)) return false;
          const assignmentRole = roleKey(assignment.group_role);
          return canonicalRoles.has(assignmentRole)
            && (requiredRoles.size === 0 || requiredRoles.has(assignmentRole));
        });
      });
      checks.push(groupMatch);
    }
    const allowed = normalized.policy.operator === 'and' ? checks.every(Boolean) : checks.some(Boolean);
    return allowed
      ? { allowed: true, restricted: true, access_policy_required: true, requires_authentication: false, code: 'ACCESS_GRANTED' }
      : formAccessDeniedOutcome('FORM_ACCESS_DENIED');
  } catch {
    return formAccessDeniedOutcome('ACCESS_LOOKUP_FAILED');
  }
}

export function sendFormAccessDenied(res, outcome) {
  return res.status(403).json({
    error: outcome.requires_authentication ? 'Authentication is required to access this form' : 'You do not have access to this form',
    code: outcome.code,
    access: outcome,
    access_policy_required: true,
  });
}