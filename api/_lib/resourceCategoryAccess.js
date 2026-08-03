// Task #3306: role-based resource category access.
//
// resource_category.excluded_role_ids (JSONB array of role ids) lists member
// roles that CANNOT see a category. Semantics:
//   - empty/NULL  -> visible to everyone (guests included) — current behaviour.
//   - non-empty   -> "restricted": hidden from the listed roles, from members
//                    with no role, and from guests entirely (member-only).
// Admins / resource managers always see everything.
//
// A resource is hidden by this gate only when it has at least one subcategory
// AND every one of its subcategories is "hidden" — i.e. the subcategory name
// appears in at least one category the viewer cannot see and in no category
// the viewer can see. Resources with no subcategories, or with any subcategory
// in a visible category, or with unmapped/legacy subcategory names, stay
// visible (backward compatible).

export function getExcludedRoleIds(category) {
  const raw = category?.excluded_role_ids;
  return Array.isArray(raw) ? raw.filter((r) => typeof r === 'string' && r) : [];
}

export function isCategoryRestricted(category) {
  return getExcludedRoleIds(category).length > 0;
}

/**
 * Whether a viewer may see a category.
 * @param {object} category
 * @param {{ roleId?: string|null, isGuest?: boolean, isPrivileged?: boolean }} viewer
 */
export function isCategoryVisibleToViewer(category, viewer = {}) {
  if (viewer.isPrivileged) return true;
  const excluded = getExcludedRoleIds(category);
  if (excluded.length === 0) return true;
  if (viewer.isGuest) return false; // restricted categories are member-only
  if (!viewer.roleId) return false; // member without a role: fail closed on restricted
  return !excluded.includes(viewer.roleId);
}

export function filterCategoriesForViewer(categories, viewer = {}) {
  return (categories || []).filter((c) => isCategoryVisibleToViewer(c, viewer));
}

/**
 * Subcategory names the viewer must not see: present in some hidden category
 * and absent from every visible category.
 * @returns {Set<string>}
 */
export function computeHiddenSubcategories(categories, viewer = {}) {
  const hidden = new Set();
  const visible = new Set();
  for (const cat of categories || []) {
    const subs = Array.isArray(cat?.subcategories) ? cat.subcategories : [];
    const target = isCategoryVisibleToViewer(cat, viewer) ? visible : hidden;
    for (const s of subs) {
      if (typeof s === 'string' && s) target.add(s);
    }
  }
  for (const s of visible) hidden.delete(s);
  return hidden;
}

/** True when the resource should be hidden given a hidden-subcategory set. */
export function isResourceHiddenByCategories(resource, hiddenSubcategories) {
  if (!hiddenSubcategories || hiddenSubcategories.size === 0) return false;
  const subs = Array.isArray(resource?.subcategories)
    ? resource.subcategories.filter((s) => typeof s === 'string' && s)
    : [];
  if (subs.length === 0) return false;
  return subs.every((s) => hiddenSubcategories.has(s));
}

export function filterResourcesByCategoryAccess(resources, hiddenSubcategories) {
  if (!hiddenSubcategories || hiddenSubcategories.size === 0) return resources || [];
  return (resources || []).filter((r) => !isResourceHiddenByCategories(r, hiddenSubcategories));
}

/**
 * Fetch a tenant's resource categories including excluded_role_ids, tolerating
 * environments where the column does not exist yet (42703 drop-and-retry —
 * the local dev database points at a stale schema). Without the column the
 * feature is simply inert: every category reads as unrestricted.
 */
export async function fetchCategoriesWithAccess(supabaseClient, tenantId) {
  const base = 'id, name, description, subcategories, applies_to_content_types, display_order, is_active';
  let { data, error } = await supabaseClient
    .from('resource_category')
    .select(`${base}, excluded_role_ids`)
    .eq('tenant_id', tenantId)
    .order('display_order', { ascending: true });
  if (error && error.code === '42703') {
    ({ data, error } = await supabaseClient
      .from('resource_category')
      .select(base)
      .eq('tenant_id', tenantId)
      .order('display_order', { ascending: true }));
  }
  if (error) throw error;
  return data || [];
}
