import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { retryZohoCrmSyncLog, syncEntityToZohoCrm } from '../../_lib/zohoCrmSync.js';

export default async function handler(req, res) {
  try {
    const ctx = await getTenantContext(req);
    if (!ctx?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
    if (!(await hasAdminAccess(ctx))) return res.status(403).json({ error: 'Admin access required' });
    const tenantId = ctx.tenantId;

    if (req.method === 'GET') {
      const { entity_type, status, entity_id, limit = '50' } = req.query;
      let q = supabase
        .from('zoho_crm_sync_log')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(Math.min(parseInt(limit, 10) || 50, 200));
      if (entity_type) q = q.eq('entity_type', entity_type);
      if (status) q = q.eq('status', status);
      if (entity_id) q = q.eq('entity_id', entity_id);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ logs: data || [] });
    }

    if (req.method === 'POST') {
      const { action, log_id, entity_type, entity_id } = req.body || {};
      if (action === 'retry' && log_id) {
        try {
          const result = await retryZohoCrmSyncLog(tenantId, log_id);
          return res.status(200).json({ result });
        } catch (err) {
          if ((err.message || '').includes('not found')) {
            return res.status(404).json({ error: 'Log entry not found' });
          }
          throw err;
        }
      }
      if (action === 'sync' && entity_type && entity_id) {
        const result = await syncEntityToZohoCrm(tenantId, entity_type, entity_id, { action: 'manual' });
        return res.status(200).json({ result });
      }
      return res.status(400).json({ error: 'Invalid action / parameters' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[ZohoCrmSync logs] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
