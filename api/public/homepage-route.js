import { supabase } from '../_lib/database.js';
import { resolvePageTenant } from '../_lib/pageTenantResolver.js';
import { homepageRoute } from '../_lib/homepage.js';
import { normalizeRoutePath, excludedRoute } from '../_lib/unknownPagePolicy.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const path = normalizeRoutePath(req.query.path);
    if (path !== '/' && excludedRoute(path)) return res.json({ target: null });
    const tenant = await resolvePageTenant(req);
    if (!tenant || !supabase) return res.json({ target: null });
    const result = await homepageRoute(supabase, tenant, req.query.path);
    if (result.state === 'error') return res.status(503).json({ error: 'Homepage unavailable' });
    return res.json({ target: result.target || null });
  } catch {
    return res.status(503).json({ error: 'Homepage unavailable' });
  }
}
