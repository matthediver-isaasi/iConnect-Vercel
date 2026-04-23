import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { relinkOrganizationsToZoho } from '../../_lib/zohoCrmSync.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const ctx = await getTenantContext(req);
    if (!ctx?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
    if (!(await hasAdminAccess(ctx))) return res.status(403).json({ error: 'Admin access required' });
    const tenantId = ctx.tenantId;
    if (!tenantId) return res.status(400).json({ error: 'Tenant context missing' });

    const result = await relinkOrganizationsToZoho(tenantId, { source: 'admin_relink' });
    return res.status(200).json({
      success: true,
      summary: result.summary,
      config: result.config,
      samples: result.samples,
      truncated: !!result.truncated,
      budget_exceeded: !!result.budget_exceeded
    });
  } catch (err) {
    console.error('[ZohoCrmSync relink-organisations] Error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
