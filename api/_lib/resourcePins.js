export async function canManageResourcePins(ctx, { hasAdminAccess, hasFeatureAccess }) {
  if (!ctx?.isAuthenticated || !ctx.tenantId || ctx.tenantMismatch) return false;
  return !!(await hasAdminAccess(ctx) ||
    (ctx.roleId && await hasFeatureAccess(ctx.roleId, 'content.resource-management', ctx.memberExcludedFeatures || [])));
}

// Generic editor saves may round-trip a pin but must never overwrite a newer
// editorial decision. Only the dedicated action changes the shared field.
export async function guardGenericResourcePin({ entity, req, res, ctx, db, id, ...access }) {
  if (String(entity).replace(/[-_]/g, '').toLowerCase() !== 'resource' ||
      !['POST', 'PATCH', 'PUT'].includes(req.method)) return false;
  if (Array.isArray(req.body)) {
    for (const body of req.body) {
      if (await guardGenericResourcePin({ entity, req: { ...req, body }, res, ctx, db, id, ...access })) return true;
    }
    return false;
  }
  if (!Object.hasOwn(req.body || {}, 'is_pinned')) return false;
  const requested = req.body.is_pinned;
  if (typeof requested !== 'boolean') {
    res.status(400).json({ error: 'is_pinned must be a boolean' });
    return true;
  }
  if (!await canManageResourcePins(ctx, access)) {
    let current = false;
    if (id && ctx?.isAuthenticated && ctx.tenantId && !ctx.tenantMismatch) {
      const { data, error } = await db.from('resource').select('*')
        .eq('tenant_id', ctx.tenantId).eq('id', id).maybeSingle();
      if (error) {
        res.status(503).json({ error: 'Unable to verify resource pin' });
        return true;
      }
      if (!data) {
        res.status(404).json({ error: 'Resource not found' });
        return true;
      }
      current = data.is_pinned === true;
    }
    if (!ctx?.isAuthenticated || requested !== current) {
      res.status(403).json({ error: 'Resource-management access is required to change shared pins' });
      return true;
    }
  }
  delete req.body.is_pinned;
  return false;
}

export function createResourcePinHandler({ db, getTenantContext, hasAdminAccess, hasFeatureAccess }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const ctx = await getTenantContext(req);
      if (!ctx?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
      if (!await canManageResourcePins(ctx, { hasAdminAccess, hasFeatureAccess })) {
        return res.status(403).json({ error: 'Resource-management access required' });
      }
      const { id, is_pinned } = req.body || {};
      if (typeof id !== 'string' || !id || typeof is_pinned !== 'boolean') {
        return res.status(400).json({ error: 'Resource id and boolean is_pinned are required' });
      }
      if (!db) return res.status(503).json({ error: 'Database not configured' });
      // Never accept tenant, release dates, content or group changes here.
      const { data, error } = await db.from('resource').update({ is_pinned })
        .eq('tenant_id', ctx.tenantId).eq('id', id).is('member_group_id', null)
        .select('id, is_pinned').maybeSingle();
      if (error) return res.status(503).json({ error: 'Unable to save resource pin. The resource pin migration must be installed before use.' });
      if (!data) return res.status(404).json({ error: 'Resource not found' });
      return res.status(200).json(data);
    } catch {
      return res.status(503).json({ error: 'Unable to save resource pin' });
    }
  };
}
