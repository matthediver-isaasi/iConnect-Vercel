import { supabase } from '../_lib/database.js';
import { pollLocalOutboundDrift } from '../_lib/zohoCrmSync.js';

/**
 * Outbound reconcile cron: scans `member` and `organization` rows for each
 * tenant with at least one enabled outbound (or bidirectional) Zoho CRM
 * mapping, finds rows whose local `updated_at` watermark is newer than the
 * last successful outbound sync, and re-pushes them through the existing
 * `syncEntityToZohoCrm` engine. After the entity passes it drains pending
 * tombstones (rows captured by the `member` / `organization` AFTER DELETE
 * triggers) by calling Zoho's DELETE endpoint.
 *
 * Acts as a safety net for the 67 runtime write paths that bypass the
 * inline `triggerZohoCrmSync` calls (see docs/zoho-sync-coverage-audit.md
 * and docs/zoho-sync-reconcile-design.md).
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
  let aggregate = {
    tenants: 0,
    candidates: 0,
    synced: 0,
    noop: 0,
    failed: 0,
    tombstones_processed: 0,
    tombstones_failed: 0
  };

  try {
    const { data: mappings, error } = await supabase
      .from('zoho_crm_sync_mapping')
      .select('tenant_id, sync_direction, is_enabled')
      .eq('is_enabled', true)
      .in('sync_direction', ['outbound', 'bidirectional']);
    if (error) throw error;

    const tenantIds = [...new Set((mappings || []).map(m => m.tenant_id))];
    aggregate.tenants = tenantIds.length;

    for (const tenantId of tenantIds) {
      try {
        const summary = await pollLocalOutboundDrift(tenantId, { source: 'reconcile-outbound' });
        results.push(summary);
        for (const c of summary.entities || []) {
          aggregate.candidates += c.candidates || 0;
          aggregate.synced += c.synced || 0;
          aggregate.noop += c.noop || 0;
          aggregate.failed += c.failed || 0;
        }
        if (summary.tombstones) {
          aggregate.tombstones_processed += summary.tombstones.processed || 0;
          aggregate.tombstones_failed += summary.tombstones.failed || 0;
        }
      } catch (err) {
        console.error('[cron/zoho-crm-reconcile-outbound] Tenant error:', tenantId, err);
        results.push({ tenant_id: tenantId, error: err.message });
      }
    }

    const duration_ms = Date.now() - startTime;
    console.log(
      `[cron/zoho-crm-reconcile-outbound] aggregate ` +
      `tenants=${aggregate.tenants} candidates=${aggregate.candidates} ` +
      `synced=${aggregate.synced} noop=${aggregate.noop} failed=${aggregate.failed} ` +
      `tombstones_processed=${aggregate.tombstones_processed} ` +
      `tombstones_failed=${aggregate.tombstones_failed} ` +
      `duration_ms=${duration_ms}`
    );

    return res.status(200).json({
      success: true,
      ...aggregate,
      duration_ms,
      results
    });
  } catch (err) {
    console.error('[cron/zoho-crm-reconcile-outbound] Fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
