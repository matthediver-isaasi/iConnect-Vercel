import { authorizeGroupAdminResourceWrite } from './groupAdminResourceWrite.js';

export function createGroupResourcePinHandler({ db, getTenantContext, hasAdminAccess }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const ctx = await getTenantContext(req);
      if (!ctx?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
      if (!ctx.tenantId || ctx.tenantMismatch) return res.status(403).json({ error: 'Tenant access required' });
      const { id, is_group_pinned } = req.body || {};
      // The action cannot change ownership or global metadata in the same request.
      if (typeof id !== 'string' || !id || typeof is_group_pinned !== 'boolean' ||
          Object.keys(req.body).some(key => !['id', 'is_group_pinned'].includes(key))) {
        return res.status(400).json({ error: 'Only resource id and boolean is_group_pinned are accepted' });
      }
      if (!db) return res.status(503).json({ error: 'Database not configured' });
      const { data: row, error: readError } = await db.from('resource').select('*')
        .eq('tenant_id', ctx.tenantId).eq('id', id).maybeSingle();
      if (readError) return res.status(503).json({ error: 'Unable to verify resource' });
      if (!row) return res.status(404).json({ error: 'Resource not found' });
      if (!row.member_group_id) return res.status(403).json({ error: 'Only group-owned resources can be pinned here' });
      const access = await authorizeGroupAdminResourceWrite({
        op: 'update', existingRow: row, tenantCtx: ctx, db, checkAdmin: hasAdminAccess,
      });
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const { data, error } = await db.from('resource').update({ is_group_pinned })
        .eq('tenant_id', ctx.tenantId).eq('id', id).eq('member_group_id', row.member_group_id)
        .select('id, member_group_id, is_group_pinned').maybeSingle();
      if (error) return res.status(503).json({ error: 'Unable to save group pin. The group pin migration must be installed before use.' });
      if (!data) return res.status(409).json({ error: 'Resource ownership changed. Reload and try again.' });
      return res.status(200).json(data);
    } catch {
      return res.status(503).json({ error: 'Unable to save group pin' });
    }
  };
}
