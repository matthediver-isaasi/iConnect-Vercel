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

    // Optional resume cursor: the admin page sends the `lastProcessedId`
    // from the previous partial response so we continue strictly after it.
    // The organization table's primary key is a UUID (varchar), so the
    // cursor is a string of UUID-shaped characters, not an integer.
    let startAfterId = null;
    const raw = req.body?.startAfterId;
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(raw)) {
        return res.status(400).json({
          error: 'startAfterId must be a UUID-shaped id string'
        });
      }
      startAfterId = raw;
    }

    const result = await relinkOrganizationsToZoho(tenantId, {
      source: 'admin_relink',
      startAfterId
    });
    return res.status(200).json({
      success: true,
      summary: result.summary,
      config: result.config,
      samples: result.samples,
      truncated: !!result.truncated,
      completed: !!result.completed,
      budget_exceeded: !!result.budget_exceeded,
      last_processed_id: result.last_processed_id ?? null
    });
  } catch (err) {
    console.error('[ZohoCrmSync relink-organisations] Error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
