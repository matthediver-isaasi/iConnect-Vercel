import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { checkRoleDuplicationAccess, duplicateTenantRole } from '../../_lib/roleDuplication.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const context = await getTenantContext(req);
    const access = await checkRoleDuplicationAccess(context, { hasAdminAccess });
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }

    const result = await duplicateTenantRole({
      db: supabase,
      tenantId: context.tenantId,
      sourceRoleId: req.body?.sourceRoleId,
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error('[role-duplicate] error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}