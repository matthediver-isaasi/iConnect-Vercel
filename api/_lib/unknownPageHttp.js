import { supabase } from './database.js';
import { resolvePageTenant } from './pageTenantResolver.js';
import { excludedRoute, normalizeRoutePath, resolveUnknownPagePolicy } from './unknownPagePolicy.js';

export function originalPagePath(req) {
  const original = req.headers['x-original-uri'] || req.headers['x-vercel-original-pathname']
    || req.headers['x-forwarded-uri'];
  const path = original || req.originalUrl || req.url || '/';
  return !original && /^\/api\/render(?:\?|$)/i.test(path) ? '/' : path;
}

// Used by both Vercel's HTML function and Express before its SPA fallback.
// Unknown tenant/database failures keep their URL and the SPA can show an error.
export function createUnknownPageHttpPolicy({ database = supabase, resolveTenant = resolvePageTenant } = {}) {
return async function applyUnknownPageHttpPolicy(req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  try {
    const path = normalizeRoutePath(originalPagePath(req));
    if (excludedRoute(path)) return false;
    const tenant = await resolveTenant(req);
    if (!tenant || !database) return false;
    const result = await resolveUnknownPagePolicy(database, tenant, path);
    if (!result.found) {
      if (result.route_outcome === 'missing') {
        req.pageRouteOutcome = 'missing';
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(404);
      }
      return false;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Location', result.target_url);
    res.status(result.status_code).end();
    return true;
  } catch (error) {
    console.error('[Page routing] Resolution failed:', error.message);
    res.setHeader('Cache-Control', 'private, no-store');
    // Keep the app shell, rather than replacing every custom route with a
    // plain-text error when legacy optional schema is missing. The client can
    // display its normal error/retry state; no lookup failure redirects.
    req.pageRouteOutcome = 'error';
    return false;
  }
};
}

export const applyUnknownPageHttpPolicy = createUnknownPageHttpPolicy();