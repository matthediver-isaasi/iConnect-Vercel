import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { getLatestMandateDiscoveryBatch, runMandateDiscovery } from '../_lib/gocardlessMandateDiscovery.js';

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  try {
    const context = await getTenantContext(req);
    if (!context?.isAuthenticated || !context.tenantId) return res.status(401).json({ error: 'Unauthorized' });
    if (!(await hasAdminAccess(context))) return res.status(403).json({ error: 'Admin access required' });
    const tenantId = context.tenantId;
    if (req.method === 'GET') {
      return res.json({ success: true, batch: await getLatestMandateDiscoveryBatch({ db: supabase, tenantId }) });
    }
    if (req.method === 'POST') {
      const batch = await runMandateDiscovery({
        db: supabase, tenantId,
        actorEmail: context.member?.email || context.email || null,
      });
      return res.status(batch.status === 'complete' ? 200 : 207).json({ success: batch.status !== 'failed', batch });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    const status = /already running/.test(error.message) ? 409
      : /tenant-specific|connection is required/.test(error.message) ? 400 : 500;
    return res.status(status).json({ error: error.message || 'Mandate discovery failed' });
  }
}