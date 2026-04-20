import { supabase } from '../_lib/database.js';
import { pollZohoCrmReconciliation } from '../_lib/zohoCrmSync.js';

/**
 * Reconciliation cron: polls Zoho CRM for records modified since each
 * tenant/mapping cursor and runs them through the inbound sync pipeline.
 * Acts as a safety net for missed webhooks.
 */
export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!supabase) return res.status(500).json({ error: 'Database not configured' });

  const startTime = Date.now();
  const results = [];

  try {
    const { data: mappings, error } = await supabase
      .from('zoho_crm_sync_mapping')
      .select('tenant_id, sync_direction, is_enabled')
      .eq('is_enabled', true)
      .in('sync_direction', ['inbound', 'bidirectional']);
    if (error) throw error;

    const tenantIds = [...new Set((mappings || []).map(m => m.tenant_id))];
    for (const tenantId of tenantIds) {
      try {
        const summary = await pollZohoCrmReconciliation(tenantId, { source: 'poller' });
        results.push(summary);
      } catch (err) {
        console.error('[cron/zoho-crm-reconcile] Tenant error:', tenantId, err);
        results.push({ tenant_id: tenantId, error: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      tenants: tenantIds.length,
      duration_ms: Date.now() - startTime,
      results
    });
  } catch (err) {
    console.error('[cron/zoho-crm-reconcile] Fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
