import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

// Public read of canvas_symbol rows. Restricted to symbols that are
// actually referenced by a published canvas page for the tenant — this
// prevents leaking unpublished authoring content (in-progress symbols)
// to the open web.
function collectSymbolIds(design, out) {
  if (!design || typeof design !== 'object') return;
  const sections = design.root?.sections || [];
  for (const section of sections) {
    const children = section?.children || [];
    for (const b of children) {
      if (b?.type === 'symbol' && b?.content?.symbolId) {
        out.add(b.content.symbolId);
      }
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  let tenant;
  try { tenant = await resolveTenantFromRequest(req); }
  catch { return res.status(500).json({ error: 'Failed to resolve tenant' }); }
  if (!tenant?.id) return res.status(404).json({ error: 'Tenant not found' });

  // Find every published canvas page for the tenant and collect the
  // referenced symbol ids from each design.
  const { data: pages, error: pagesErr } = await supabase
    .from('i_edit_page')
    .select('canvas_design')
    .eq('tenant_id', tenant.id)
    .eq('builder_type', 'canvas')
    .eq('status', 'published')
    .in('layout_type', ['public', 'hybrid']);
  if (pagesErr) return res.status(500).json({ error: 'Failed to load pages' });

  const ids = new Set();
  for (const p of pages || []) collectSymbolIds(p.canvas_design, ids);
  if (ids.size === 0) {
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json({ symbols: [] });
  }

  const { data, error } = await supabase
    .from('canvas_symbol')
    .select('id, name, design, updated_at')
    .eq('tenant_id', tenant.id)
    .in('id', Array.from(ids));
  if (error) return res.status(500).json({ error: 'Failed to load symbols' });
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.status(200).json({ symbols: data || [] });
}
