// Tenant-scoped Canvas Builder theme tokens (colours, typography, spacing).
//
// Public render-time consumption: the public renderer can request these
// tokens via GET with a Host header — we resolve tenant by host first, then
// fall back to authenticated context so admin previews keep working.

import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

const EMPTY_THEME = {
  colors: {},
  typography: {},
  spacing: {},
};

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  if (req.method === 'GET') {
    // Allow unauthenticated public reads by host so the public renderer
    // can apply tenant theming. Falls back to authenticated tenant context
    // for editor previews and admin sessions.
    let tenantId = null;
    try {
      const ctx = await getTenantContext(req);
      tenantId = ctx?.tenantId || null;
    } catch {}
    if (!tenantId) {
      const t = await resolveTenantFromRequest(req).catch(() => null);
      tenantId = t?.id || null;
    }
    if (!tenantId) return res.status(200).json({ theme: EMPTY_THEME, source: 'fallback' });

    const { data } = await supabase
      .from('tenant_canvas_theme')
      .select('theme, updated_at')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=30');
    return res.status(200).json({
      theme: data?.theme || EMPTY_THEME,
      updated_at: data?.updated_at || null,
      source: 'tenant',
    });
  }

  if (req.method === 'PUT' || req.method === 'PATCH') {
    let context;
    try { context = await getTenantContext(req); }
    catch (err) { return res.status(500).json({ error: 'Failed to resolve tenant context' }); }
    if (!context?.tenantId) return res.status(403).json({ error: 'Tenant context required' });
    if (!context.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
    const tenantId = context.tenantId;
    const body = req.body || {};
    if (!body.theme || typeof body.theme !== 'object' || Array.isArray(body.theme)) {
      return res.status(400).json({ error: 'theme (object) required' });
    }
    // upsert
    const { data, error } = await supabase
      .from('tenant_canvas_theme')
      .upsert(
        { tenant_id: tenantId, theme: body.theme, updated_at: new Date().toISOString() },
        { onConflict: 'tenant_id' },
      )
      .select('theme, updated_at')
      .single();
    if (error) return res.status(500).json({ error: 'Failed to save theme' });
    return res.status(200).json({ theme: data.theme, updated_at: data.updated_at });
  }

  res.setHeader('Allow', 'GET, PUT, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
}
