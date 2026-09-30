import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { clearZohoCrmModuleFieldsCache } from '../../_lib/zohoCrmClient.js';
import { clearZohoCrmDerivedFlagSetsCache } from '../../_lib/zohoCrmSync.js';

/**
 * Invalidate the in-memory caches that read Zoho CRM mappings + field
 * type metadata for one tenant (optionally scoped to one zoho_module).
 *
 * Why this exists: a few caches in the API process memo expensive Zoho
 * metadata for 5 minutes. When an operator re-points a mapping out of
 * band — for example via `scripts/migrate-zoho-overview.mjs
 * --update-mapping --apply` — the next sync would otherwise still see
 * the old derived-flag tuple until the TTL elapses (or the workflow
 * restarts). This endpoint flushes those caches immediately so the
 * mapping change takes effect on the very next sync.
 *
 * Auth: admin session (the standard pattern used by every other
 * endpoint in this folder) OR a `Bearer ${CRON_SECRET}` header so the
 * one-off migration script can call this without a session cookie.
 * Mirrors the cron auth pattern in `api/cron/*.js`.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  const isCronCall = cronSecret && authHeader === `Bearer ${cronSecret}`;

  let tenantId;
  let zohoModule;

  if (isCronCall) {
    // Service-style call — tenant + module must come from the body
    // because there's no session.
    tenantId = req.body?.tenantId;
    zohoModule = req.body?.zohoModule || null;
    if (!tenantId || typeof tenantId !== 'string') {
      return res.status(400).json({ error: 'tenantId required when calling with CRON_SECRET' });
    }
  } else {
    // Admin-session call — derive tenant from the session, accept an
    // optional module override from the body.
    let ctx;
    try {
      ctx = await getTenantContext(req);
    } catch (err) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!ctx?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
    if (!(await hasAdminAccess(ctx))) return res.status(403).json({ error: 'Admin access required' });
    tenantId = ctx.tenantId;
    if (!tenantId) return res.status(400).json({ error: 'Tenant context missing' });
    zohoModule = req.body?.zohoModule || null;
  }

  try {
    clearZohoCrmDerivedFlagSetsCache(tenantId, zohoModule);
    clearZohoCrmModuleFieldsCache(tenantId, zohoModule);
    return res.status(200).json({
      success: true,
      tenantId,
      zohoModule: zohoModule || '(all modules)',
      cleared: ['derivedFlagSetsCache', 'moduleFieldsCache']
    });
  } catch (err) {
    console.error('[invalidate-mapping-cache] Failed:', err);
    return res.status(500).json({ error: err?.message || 'Cache invalidation failed' });
  }
}
