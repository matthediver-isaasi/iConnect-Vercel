import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { importEntityFromZoho } from '../../_lib/zohoCrmSync.js';

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

    const summary = await importEntityFromZoho(tenantId, 'member', { source: 'one_time_import' });
    return res.status(200).json({ success: true, summary });
  } catch (err) {
    console.error('[ZohoCrmSync import-members] Error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
