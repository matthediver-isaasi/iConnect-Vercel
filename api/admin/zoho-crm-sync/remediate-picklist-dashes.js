import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { remediatePicklistDashes } from '../../_lib/zohoCrmSync.js';

// Admin-only #463 remediation. Re-pushes iConnect picklist values to Zoho
// for organisations whose stored picklist value differs from iConnect by
// dash style only (or is empty after a previous failed overwrite).
//
// Dry-run by default — caller must explicitly pass `dryRun: false` to
// commit the change. Honours the same UUID-shaped startAfterId resume
// cursor as `relink-organisations.js` so a large tenant can be processed
// across multiple invocations under the Vercel time budget.
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

    let startAfterId = null;
    const rawCursor = req.body?.startAfterId;
    if (rawCursor !== undefined && rawCursor !== null) {
      if (typeof rawCursor !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(rawCursor)) {
        return res.status(400).json({
          error: 'startAfterId must be a UUID-shaped id string'
        });
      }
      startAfterId = rawCursor;
    }

    // Strict opt-in: only the literal boolean `false` flips off dry-run.
    // Anything else (missing, true, "false" string, etc.) keeps dry-run
    // on so an accidental click in the admin UI cannot accidentally
    // overwrite production data.
    const dryRun = req.body?.dryRun === false ? false : true;

    const result = await remediatePicklistDashes(tenantId, {
      source: 'admin_remediate_picklist_dash',
      startAfterId,
      dryRun
    });
    return res.status(200).json({
      success: true,
      dry_run: dryRun,
      summary: result.summary,
      samples: result.samples,
      truncated: !!result.truncated,
      completed: !!result.completed,
      last_processed_id: result.last_processed_id ?? null
    });
  } catch (err) {
    console.error('[ZohoCrmSync remediate-picklist-dashes] Error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
