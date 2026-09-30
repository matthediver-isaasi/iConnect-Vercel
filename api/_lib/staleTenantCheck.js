/**
 * Stale-tab / cross-tenant mismatch guard — standalone, adapter-level helper.
 *
 * Called by the Vercel API adapter BEFORE any handler runs so that ALL API
 * endpoints (not just the entity API) are protected.
 *
 * Returns true and sends a 409 TENANT_CONTEXT_CHANGED response when the
 * authenticated session's tenant differs from the "intended" tenant for the
 * request.  Returns false (no response sent) for all other cases.
 *
 * Exemptions (returns false immediately):
 *   - /api/auth/*  — login, logout, tenant-switch must always be allowed
 *   - /api/webhooks/*  — Stripe / external webhooks have no session tenant
 *   - /api/cron/*  — server-side cron jobs
 *   - Unauthenticated requests (no session)
 *   - Bearer / mobile sessions (authMethod === 'bearer')
 *   - Requests where no "intended tenant" can be determined
 */

import { getSession } from './session.js';

const EXEMPT_PREFIXES = [
  '/api/auth/',        // login, logout, tenant-switch, me, tenant-user-me
  '/api/webhooks/',    // Stripe and external webhooks
  '/api/cron/',        // server-side cron jobs
  '/api/admin/portal-session', // Open Portal handoff — session switch in flight
];

export async function checkStaleTenantMismatch(req, res) {
  try {
    // Skip exempt paths
    const urlPath = req.path ? '/api' + req.path : (req.url || '');
    for (const prefix of EXEMPT_PREFIXES) {
      if (urlPath.startsWith(prefix)) return false;
    }

    // Only check sessions that have a tenantId
    const rawSession = await getSession(req);
    if (!rawSession?.data) return false;
    if (rawSession.data.authMethod === 'bearer') return false;

    const sessionTenantId = rawSession.data.tenantId || null;
    if (!sessionTenantId) return false;

    // Determine the "intended" tenant for this request:
    //   1. Hostname-based (subdomain / custom domain) — most reliable
    //   2. X-Tenant-Id request header (shared admin host iconn.app)
    let intendedTenantId = null;

    const host = req.headers?.host || req.headers?.['x-forwarded-host'] || '';
    const hostname = host.split(':')[0];

    // Only attempt hostname-based resolution for non-localhost/non-Replit hosts
    if (hostname && hostname !== 'localhost' && !hostname.endsWith('.replit.dev') && !hostname.endsWith('.repl.co')) {
      try {
        const { resolveTenantFromRequest } = await import('./tenantResolver.js');
        const tenantFromHost = await resolveTenantFromRequest(req);
        if (tenantFromHost?.id) {
          intendedTenantId = tenantFromHost.id;
        }
      } catch (_) {
        // resolver unavailable — fall through to header check
      }
    }

    // Header-based fallback (shared admin host)
    if (!intendedTenantId) {
      intendedTenantId = req.headers?.['x-tenant-id'] || null;
    }

    if (!intendedTenantId) return false;

    if (sessionTenantId !== intendedTenantId) {
      console.log(`[StaleTenantCheck] Mismatch: session=${sessionTenantId} intended=${intendedTenantId} path=${urlPath}`);
      res.status(409).json({ code: 'TENANT_CONTEXT_CHANGED', message: 'Session tenant changed — please reload.' });
      return true;
    }

    return false;
  } catch (err) {
    // Guard must never break request handling
    console.warn('[StaleTenantCheck] Error (skipped):', err.message);
    return false;
  }
}
