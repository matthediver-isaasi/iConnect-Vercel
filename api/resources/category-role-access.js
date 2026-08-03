// Task #3306: apply per-role resource category access changes atomically.
// POST { roleId, changes: [{ categoryId, hasAccess }] }
// Each change runs through the resource_category_set_role_access() SQL
// function, which adds/removes ONLY the given role id inside
// excluded_role_ids in a single UPDATE — concurrent edits by other admins to
// other roles' exclusions are never clobbered (unlike a client
// read-modify-write of the full array).
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
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
    const canManage = !!ctx.tenantUserId
      || await hasAdminAccess(ctx)
      || (ctx.roleId ? await hasFeatureAccess(ctx.roleId, 'content.resource-management') : false);
    if (!canManage) {
      return res.status(403).json({ error: 'Not authorized to change resource category access' });
    }

    const { roleId, changes } = req.body || {};
    if (!roleId || typeof roleId !== 'string' || !Array.isArray(changes) || changes.length === 0) {
      return res.status(400).json({ error: 'roleId and a non-empty changes array are required' });
    }
    if (changes.length > 200) {
      return res.status(400).json({ error: 'Too many changes in one request' });
    }

    const applied = [];
    const failed = [];
    for (const change of changes) {
      const categoryId = change?.categoryId;
      const hasAccess = change?.hasAccess === true;
      if (!categoryId || typeof categoryId !== 'string') {
        failed.push({ categoryId, error: 'Invalid categoryId' });
        continue;
      }
      const { data, error } = await supabase.rpc('resource_category_set_role_access', {
        p_category_id: categoryId,
        p_tenant_id: ctx.tenantId,
        p_role_id: roleId,
        p_has_access: hasAccess,
      });
      if (error) {
        console.error('[category-role-access] rpc failed:', categoryId, error.message);
        failed.push({ categoryId, error: error.message });
      } else {
        applied.push({ categoryId, excluded_role_ids: data });
      }
    }

    // Partial failures are reported explicitly so the client can keep the
    // remaining toggles pending and retry (retrying an applied change is a
    // no-op thanks to the idempotent SQL function).
    return res.status(failed.length > 0 ? 207 : 200).json({ applied, failed });
  } catch (error) {
    console.error('[category-role-access] error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
