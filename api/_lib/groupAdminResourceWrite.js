import { supabase } from './database.js';
import { hasAdminAccess } from './tenantContext.js';

/**
 * Task #1588: Server-side authorization for Group-Admin resource writes.
 *
 * Group Admins (per-assignment is_group_admin flag) may UPDATE and DELETE a
 * `Resource` whose member_group_id matches a group they administer — mirroring
 * the event carve-out (groupAdminEventWrite.js). Tenant admins (tenant users OR
 * members with an admin role) keep the full, unchanged write path.
 *
 * The generic entity API has no server-side admin gate on tenant-scoped resource
 * writes today (RBAC is client-side), so this layer TIGHTENS security: a
 * non-admin caller can now only write group resources for groups they administer,
 * and never a tenant-wide resource (member_group_id IS NULL).
 *
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
function norm(entity) {
  return String(entity || '').replace(/[-_]/g, '').toLowerCase();
}

export function isResourceEntity(entity) {
  return norm(entity) === 'resource';
}

/**
 * Task #1701: default a new group resource's subcategories to its group's
 * linked resource subcategories when the create payload doesn't already supply
 * them. This guarantees group-created resources are auto-tagged (and therefore
 * surface tenant-wide under the matching filter) regardless of the client.
 *
 * Mutates and returns the passed body. No-op for tenant-wide resources
 * (member_group_id null), when the caller already provided a non-empty
 * subcategories array, or when the group has no linked subcategories.
 */
export async function applyGroupResourceSubcategoryDefaults(body) {
  if (!supabase || !body || typeof body !== 'object') return body;
  const groupId = body.member_group_id || null;
  if (!groupId) return body;
  if (Array.isArray(body.subcategories) && body.subcategories.length > 0) return body;

  const { data: group, error } = await supabase
    .from('member_group')
    .select('resource_subcategories')
    .eq('id', groupId)
    .single();
  if (error || !group) return body;

  const linked = Array.isArray(group.resource_subcategories)
    ? group.resource_subcategories.filter((s) => typeof s === 'string' && s.trim())
    : [];
  if (linked.length > 0) {
    body.subcategories = [...new Set(linked)];
  }
  return body;
}

/**
 * Resolve the set of member_group ids the caller ADMINISTERS. A caller qualifies
 * for a group when they have an active (non-expired) assignment flagged
 * is_group_admin, and the group is active and in the caller's tenant.
 */
async function getCallerAdminGroupIds(tenantCtx) {
  if (!supabase) return new Set();
  const memberId = tenantCtx?.memberId;
  if (!memberId) return new Set();

  const nowIso = new Date().toISOString();
  const { data: assignments, error: assignErr } = await supabase
    .from('member_group_assignment')
    .select('group_id, expires_at, is_group_admin')
    .eq('member_id', memberId);
  if (assignErr) return new Set();

  const liveAdmin = (assignments || []).filter((a) => {
    if (!a.group_id) return false;
    if (a.is_group_admin !== true) return false;
    if (!a.expires_at) return true;
    return new Date(a.expires_at).toISOString() > nowIso;
  });
  if (liveAdmin.length === 0) return new Set();

  const groupIds = [...new Set(liveAdmin.map((a) => a.group_id))];
  let query = supabase
    .from('member_group')
    .select('id, is_active, tenant_id')
    .in('id', groupIds);
  if (tenantCtx.tenantId) query = query.eq('tenant_id', tenantCtx.tenantId);
  const { data: groupRows, error: groupErr } = await query;
  if (groupErr) return new Set();

  return new Set(
    (groupRows || []).filter((g) => g.is_active !== false).map((g) => g.id)
  );
}

/**
 * Authorize an update/delete of a Resource by a Group Admin.
 *
 * - Tenant admins always pass.
 * - A non-admin may only touch a resource that belongs to a group they
 *   administer; tenant-wide resources (member_group_id null) are denied.
 * - On update, moving a resource to a different group is rejected unless the
 *   caller is a tenant admin.
 *
 * @param {object} args
 * @param {'update'|'delete'} args.op
 * @param {object|null} args.existingRow - { id, member_group_id, tenant_id }
 * @param {object} [args.body] - sanitized update payload (update only)
 * @param {object} args.tenantCtx
 */
export async function authorizeGroupAdminResourceWrite({ op, existingRow, body = {}, tenantCtx }) {
  // Tenant admins keep the full, unchanged write path.
  if (await hasAdminAccess(tenantCtx)) return { ok: true };

  if (!existingRow) {
    return { ok: false, status: 404, error: 'Resource not found' };
  }

  if (tenantCtx.tenantId && existingRow.tenant_id && existingRow.tenant_id !== tenantCtx.tenantId) {
    return { ok: false, status: 404, error: 'Resource not found in this tenant' };
  }

  const groupId = existingRow.member_group_id || null;
  if (!groupId) {
    // Tenant-wide resources are never editable by non-admins.
    return { ok: false, status: 403, error: 'You do not have permission to manage this resource' };
  }

  const adminGroupIds = await getCallerAdminGroupIds(tenantCtx);
  if (adminGroupIds.size === 0) {
    return { ok: false, status: 403, error: 'You do not have permission to manage this resource' };
  }
  if (!adminGroupIds.has(groupId)) {
    return { ok: false, status: 403, error: 'You can only manage resources for groups you administer' };
  }

  // On update, a non-admin may not move the resource to a different group.
  if (op === 'update' && 'member_group_id' in body && body.member_group_id && body.member_group_id !== groupId) {
    return { ok: false, status: 403, error: 'Cannot move a group resource to a different group' };
  }

  return { ok: true };
}
