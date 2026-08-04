// Task #3306: resource categories visible to the authenticated caller, plus
// the subcategory names hidden from them. The /resources page uses this both
// to build the filter sidebar (visible categories only) and to hide resources
// exclusively tagged with restricted-category subcategories. The generic
// entity list already filters categories server-side; this endpoint exists so
// the client also knows WHICH subcategory names are hidden (only the names of
// removed subcategories are exposed, never the categories or resources).
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import {
  fetchCategoriesWithAccess,
  filterCategoriesForViewer,
  filterCategorySubcategoriesForViewer,
  computeHiddenSubcategories,
  stripCategoryAccessFields,
} from '../_lib/resourceCategoryAccess.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const ctx = await getTenantContext(req);
    if (!ctx?.tenantId || ctx.isAuthenticated !== true || ctx.tenantMismatch) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const categories = await fetchCategoriesWithAccess(supabase, ctx.tenantId);

    const isPrivileged = !!ctx.tenantUserId
      || await hasAdminAccess(ctx)
      || (ctx.roleId ? await hasFeatureAccess(ctx.roleId, 'content.resource-management') : false);
    const viewer = { roleId: ctx.roleId, isPrivileged };

    // Task #3320: also remove role-excluded subcategory names from each
    // visible category so hidden filter chips never render, and strip the
    // per-subcategory exclusion map alongside excluded_role_ids.
    const visible = filterCategoriesForViewer(categories, viewer)
      .map((c) => stripCategoryAccessFields(filterCategorySubcategoriesForViewer(c, viewer)));
    const hiddenSubcategories = Array.from(computeHiddenSubcategories(categories, viewer));

    return res.status(200).json({ categories: visible, hiddenSubcategories });
  } catch (error) {
    console.error('[resources/visible-categories] error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
