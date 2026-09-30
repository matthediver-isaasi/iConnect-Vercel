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

// Task #3320: per-subcategory role exclusions.
// resource_category.subcategory_excluded_role_ids is a JSONB map of
// subcategory name -> array of role ids that cannot see that subcategory
// (within this category). Missing/empty entries mean the subcategory follows
// the category's own visibility — current behaviour, so tenants that never
// touch subcategory toggles need no migration of data.
export function getSubcategoryExclusionMap(category) {
  const raw = category?.subcategory_excluded_role_ids;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

export function getSubcategoryExcludedRoleIds(category, subcategoryName) {
  const arr = getSubcategoryExclusionMap(category)[subcategoryName];
  return Array.isArray(arr) ? arr.filter((r) => typeof r === 'string' && r) : [];
}

export function hasSubcategoryRestrictions(category) {
  const map = getSubcategoryExclusionMap(category);
  return Object.keys(map).some((k) => {
    const arr = map[k];
    return Array.isArray(arr) && arr.some((r) => typeof r === 'string' && r);
  });
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
 * Task #3320: whether a viewer may see a specific subcategory occurrence
 * within a category. Requires the category itself to be visible, then applies
 * the per-subcategory role exclusions with the same semantics as category
 * exclusions: empty = visible to everyone; non-empty = member-only, hidden
 * from listed roles and from members with no role.
 */
export function isSubcategoryVisibleInCategory(category, subcategoryName, viewer = {}) {
  if (viewer.isPrivileged) return true;
  if (!isCategoryVisibleToViewer(category, viewer)) return false;
  const excluded = getSubcategoryExcludedRoleIds(category, subcategoryName);
  if (excluded.length === 0) return true;
  if (viewer.isGuest) return false; // restricted subcategories are member-only
  if (!viewer.roleId) return false; // member without a role: fail closed
  return !excluded.includes(viewer.roleId);
}

/**
 * Task #3320: a copy of the category whose `subcategories` list only contains
 * names the viewer may see in THIS category. Used when building filter
 * sidebars so hidden subcategory chips never render.
 */
export function filterCategorySubcategoriesForViewer(category, viewer = {}) {
  const subs = Array.isArray(category?.subcategories) ? category.subcategories : [];
  return {
    ...category,
    subcategories: subs.filter(
      (s) => typeof s === 'string' && s && isSubcategoryVisibleInCategory(category, s, viewer)
    ),
  };
}

/**
 * Task #3320: strip access-control fields before returning categories to
 * non-admin callers.
 */
export function stripCategoryAccessFields(category) {
  const { excluded_role_ids, subcategory_excluded_role_ids, ...rest } = category || {};
  return rest;
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
    for (const s of subs) {
      if (typeof s !== 'string' || !s) continue;
      // Task #3320: an occurrence is hidden when its category is hidden OR
      // the subcategory itself is role-excluded within a visible category.
      const target = isSubcategoryVisibleInCategory(cat, s, viewer) ? visible : hidden;
      target.add(s);
    }
  }
  // Duplicate names across categories: any visible occurrence wins.
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
  // Try the fullest column set first, then degrade (42703 = column missing in
  // this environment; the corresponding feature is simply inert there).
  const selects = [
    `${base}, excluded_role_ids, subcategory_excluded_role_ids`,
    `${base}, excluded_role_ids`,
    base,
  ];
  let data = null;
  let error = null;
  for (const sel of selects) {
    ({ data, error } = await supabaseClient
      .from('resource_category')
      .select(sel)
      .eq('tenant_id', tenantId)
      .order('display_order', { ascending: true }));
    if (!error || error.code !== '42703') break;
  }
  if (error) throw error;
  return data || [];
}
