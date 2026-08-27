// Tenant role duplication is deliberately kept outside the HTTP handler so
// the security and data-copying rules remain directly testable.

export const ROLE_MANAGEMENT_FEATURE_KEY = 'admin.role-management';

const COPYABLE_ROLE_FIELDS = [
  'description',
  'excluded_features',
  'show_tours',
  'show_bookmarks',
  'default_landing_page',
  'layout_theme',
  'requires_effective_from_date',
  'is_tenant_admin',
  'badge_image_url',
  'badge_background_colour',
  'badge_text_colour',
  'segment_values',
  'max_members',
  'assignable_role_ids',
];

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : [];
}

function subcategoryExclusionMap(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return {};
  return value;
}

export function getCopyName(sourceName, existingNames = []) {
  const base = `${String(sourceName || 'Role').trim() || 'Role'} (Copy)`;
  const names = new Set(existingNames.filter((name) => typeof name === 'string'));
  if (!names.has(base)) return base;

  let number = 2;
  while (names.has(`${base} ${number}`)) number += 1;
  return `${base} ${number}`;
}

export function buildRoleCopyPayload(sourceRole, existingNames = []) {
  const payload = {};
  for (const field of COPYABLE_ROLE_FIELDS) {
    if (field === 'excluded_features' || field === 'segment_values' || field === 'assignable_role_ids') {
      payload[field] = stringArray(sourceRole?.[field]);
    } else if (sourceRole?.[field] !== undefined) {
      payload[field] = sourceRole[field];
    }
  }

  return {
    ...payload,
    name: getCopyName(sourceRole?.name, existingNames),
    // These are intentionally not inherited. A duplicated role must always be
    // an ordinary, unassigned tenant role until an administrator chooses
    // otherwise in the review dialog.
    is_default: false,
    is_system: false,
    is_admin: false,
  };
}

/**
 * Return only the restrictions explicitly applied to the source role. Roles
 * absent from these access structures have unrestricted access and must stay
 * absent when copied.
 */
export function getResourceAccessCopyChanges(categories, sourceRoleId) {
  const changes = [];
  for (const category of categories || []) {
    if (!category?.id) continue;

    if (stringArray(category.excluded_role_ids).includes(sourceRoleId)) {
      changes.push({ categoryId: category.id, hasAccess: false });
    }

    const subcategoryMap = subcategoryExclusionMap(category.subcategory_excluded_role_ids);
    for (const [subcategory, excludedRoleIds] of Object.entries(subcategoryMap)) {
      if (typeof subcategory !== 'string' || !subcategory.trim()) continue;
      if (stringArray(excludedRoleIds).includes(sourceRoleId)) {
        changes.push({ categoryId: category.id, subcategory, hasAccess: false });
      }
    }
  }
  return changes;
}

export async function checkRoleDuplicationAccess(tenantCtx, deps = {}) {
  const checkAdmin = deps.hasAdminAccess;
  if (!tenantCtx || !tenantCtx.isAuthenticated || tenantCtx.tenantMismatch) {
    return { ok: false, status: 401, error: 'Authentication required' };
  }
  if (!tenantCtx.tenantId) {
    return { ok: false, status: 400, error: 'Tenant context not available' };
  }
  if (!checkAdmin || !(await checkAdmin(tenantCtx))) {
    return { ok: false, status: 403, error: 'Role Management access required' };
  }
  return { ok: true };
}

function accessRpcParams(change, tenantId, roleId, hasAccess) {
  if (change.subcategory) {
    return {
      rpc: 'resource_category_set_subcategory_role_access',
      params: {
        p_category_id: change.categoryId,
        p_tenant_id: tenantId,
        p_role_id: roleId,
        p_subcategory: change.subcategory,
        p_has_access: hasAccess,
      },
    };
  }
  return {
    rpc: 'resource_category_set_role_access',
    params: {
      p_category_id: change.categoryId,
      p_tenant_id: tenantId,
      p_role_id: roleId,
      p_has_access: hasAccess,
    },
  };
}

async function applyAccessChanges(db, changes, tenantId, roleId) {
  const applied = [];
  for (const change of changes) {
    const { rpc, params } = accessRpcParams(change, tenantId, roleId, false);
    const { data, error } = await db.rpc(rpc, params);
    // A null response means the category disappeared or does not belong to the
    // tenant. Treat that like an error rather than silently losing a restriction.
    if (error || data === null || data === undefined) {
      return { applied, error: error?.message || 'Resource category no longer exists' };
    }
    applied.push(change);
  }
  return { applied, error: null };
}

async function cleanUpFailedCopy(db, appliedChanges, tenantId, roleId) {
  const failures = [];
  for (const change of [...appliedChanges].reverse()) {
    const { rpc, params } = accessRpcParams(change, tenantId, roleId, true);
    const { data, error } = await db.rpc(rpc, params);
    if (error || data === null || data === undefined) {
      failures.push(error?.message || 'Failed to restore resource access');
    }
  }

  // If any restriction could not be reversed, retain the copied role so every
  // exclusion still points to a real, visible role that an administrator can
  // review and repair. Deleting it here would leave dangling IDs in JSON.
  if (failures.length > 0) return failures;

  const { error: deleteError } = await db
    .from('role')
    .delete()
    .eq('id', roleId)
    .eq('tenant_id', tenantId);
  if (deleteError) failures.push(deleteError.message || 'Failed to remove incomplete role copy');
  return failures;
}

/**
 * Create a new role within `tenantId`, then reproduce only the source role's
 * explicit resource visibility exclusions through the atomic SQL RPCs.
 */
export async function duplicateTenantRole({ db, tenantId, sourceRoleId }) {
  if (!db || !tenantId || typeof sourceRoleId !== 'string' || !sourceRoleId.trim()) {
    return { status: 400, body: { error: 'sourceRoleId is required' } };
  }

  const { data: sourceRole, error: sourceError } = await db
    .from('role')
    .select('*')
    .eq('id', sourceRoleId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (sourceError) {
    return { status: 500, body: { error: 'Failed to load source role' } };
  }
  if (!sourceRole) {
    // The tenant filter is intentional: cross-tenant IDs are not disclosed.
    return { status: 404, body: { error: 'Role not found' } };
  }

  const { data: roleNames, error: namesError } = await db
    .from('role')
    .select('name')
    .eq('tenant_id', tenantId);
  if (namesError) {
    return { status: 500, body: { error: 'Failed to prepare role copy' } };
  }

  const rolePayload = {
    tenant_id: tenantId,
    ...buildRoleCopyPayload(sourceRole, (roleNames || []).map((role) => role.name)),
  };
  const { data: copiedRole, error: createError } = await db
    .from('role')
    .insert(rolePayload)
    .select('*')
    .single();
  if (createError || !copiedRole?.id) {
    return { status: 500, body: { error: 'Failed to create role copy' } };
  }

  const { data: categories, error: categoriesError } = await db
    .from('resource_category')
    .select('id, excluded_role_ids, subcategory_excluded_role_ids')
    .eq('tenant_id', tenantId);
  if (categoriesError) {
    const cleanupFailures = await cleanUpFailedCopy(db, [], tenantId, copiedRole.id);
    return {
      status: 500,
      body: {
        error: cleanupFailures.length
          ? 'Role copy could not be completed; an administrator must review the incomplete copy'
          : 'Failed to copy resource visibility settings',
        copyRoleId: cleanupFailures.length ? copiedRole.id : undefined,
      },
    };
  }

  const changes = getResourceAccessCopyChanges(categories, sourceRoleId);
  const accessResult = await applyAccessChanges(db, changes, tenantId, copiedRole.id);
  if (accessResult.error) {
    const cleanupFailures = await cleanUpFailedCopy(db, accessResult.applied, tenantId, copiedRole.id);
    return {
      status: 500,
      body: {
        error: cleanupFailures.length
          ? 'Role copy could not be completed; an administrator must review the incomplete copy'
          : 'Failed to copy resource visibility settings. The copy was removed.',
        copyRoleId: cleanupFailures.length ? copiedRole.id : undefined,
      },
    };
  }

  return {
    status: 201,
    body: {
      role: copiedRole,
      copiedResourceRestrictions: changes.length,
      resourceAccessChanges: changes,
    },
  };
}