// Canvas page version history: list, snapshot, and restore.
//
// Routes:
//   GET    /api/canvas-versions/:pageId            → list versions (no design payload)
//   GET    /api/canvas-versions/:pageId?full=1     → list versions with full design payloads
//   GET    /api/canvas-versions/:pageId?versionId= → single version with design
//   POST   /api/canvas-versions/:pageId            → snapshot the current design (body: {label, source})
//   POST   /api/canvas-versions/:pageId?restore=1  → restore (body: {versionId}) - copies version.design onto the page
//
// Tenant hard-fail on every request — version data is authoring-only.

import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

const MAX_KEEP = 50;

async function loadCanvasPage(pageId, tenantId) {
  const { data, error } = await supabase
    .from('i_edit_page')
    .select('id, tenant_id, builder_type, canvas_design')
    .eq('id', pageId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) return { error };
  if (!data) return { notFound: true };
  if (data.builder_type !== 'canvas') return { wrongBuilder: true };
  return { page: data };
}

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  const { pageId } = req.query;
  if (!pageId || typeof pageId !== 'string') return res.status(400).json({ error: 'pageId required' });

  let context;
  try { context = await getTenantContext(req); }
  catch (err) { return res.status(500).json({ error: 'Failed to resolve tenant context' }); }
  if (!context?.tenantId) return res.status(403).json({ error: 'Tenant context required' });
  if (!context.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
  const tenantId = context.tenantId;

  const pageCheck = await loadCanvasPage(pageId, tenantId);
  if (pageCheck.error) return res.status(500).json({ error: 'Failed to load page' });
  if (pageCheck.notFound) return res.status(404).json({ error: 'Page not found' });
  if (pageCheck.wrongBuilder) return res.status(409).json({ error: 'Page is not a Canvas Builder page' });

  if (req.method === 'GET') {
    const versionId = req.query.versionId;
    const full = req.query.full === '1';
    if (versionId) {
      const { data, error } = await supabase
        .from('canvas_page_version')
        .select('*')
        .eq('id', versionId)
        .eq('page_id', pageId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (error) return res.status(500).json({ error: 'Failed to load version' });
      if (!data) return res.status(404).json({ error: 'Version not found' });
      return res.status(200).json({ version: data });
    }
    const cols = full
      ? 'id, page_id, design, label, source, created_by, created_at'
      : 'id, page_id, label, source, created_by, created_at';
    const { data, error } = await supabase
      .from('canvas_page_version')
      .select(cols)
      .eq('page_id', pageId)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(MAX_KEEP);
    if (error) return res.status(500).json({ error: 'Failed to load versions' });
    return res.status(200).json({ versions: data || [] });
  }

  if (req.method === 'POST') {
    const restore = req.query.restore === '1';
    const body = req.body || {};

    if (restore) {
      if (!body.versionId) return res.status(400).json({ error: 'versionId required' });
      const { data: version, error: vErr } = await supabase
        .from('canvas_page_version')
        .select('id, design')
        .eq('id', body.versionId)
        .eq('page_id', pageId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (vErr) return res.status(500).json({ error: 'Failed to load version' });
      if (!version) return res.status(404).json({ error: 'Version not found' });

      // Snapshot the current design first so the rollback itself is undoable.
      await supabase.from('canvas_page_version').insert({
        page_id: pageId,
        tenant_id: tenantId,
        design: pageCheck.page.canvas_design || { version: 1, root: { sections: [{ id: 'root-section', children: [] }] } },
        label: 'Auto-snapshot before restore',
        source: 'pre-restore',
        created_by: context.memberId || null,
      });

      const { data: updated, error: uErr } = await supabase
        .from('i_edit_page')
        .update({ canvas_design: version.design })
        .eq('id', pageId)
        .eq('tenant_id', tenantId)
        .select('id, canvas_design')
        .single();
      if (uErr) return res.status(500).json({ error: 'Failed to restore version' });
      return res.status(200).json({ page: updated });
    }

    // Plain snapshot — captures the current page design with a label.
    const design = body.design ?? pageCheck.page.canvas_design;
    if (!design || typeof design !== 'object') {
      return res.status(400).json({ error: 'No design to snapshot' });
    }
    const { data, error } = await supabase
      .from('canvas_page_version')
      .insert({
        page_id: pageId,
        tenant_id: tenantId,
        design,
        label: body.label || null,
        source: body.source || 'manual',
        created_by: context.memberId || null,
      })
      .select('id, label, source, created_at, created_by')
      .single();
    if (error) return res.status(500).json({ error: 'Failed to snapshot version' });

    // Trim history beyond MAX_KEEP to keep the table tidy.
    const { data: all } = await supabase
      .from('canvas_page_version')
      .select('id, created_at')
      .eq('page_id', pageId)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });
    if (Array.isArray(all) && all.length > MAX_KEEP) {
      const toDelete = all.slice(MAX_KEEP).map((r) => r.id);
      if (toDelete.length > 0) {
        await supabase.from('canvas_page_version').delete().in('id', toDelete);
      }
    }

    return res.status(201).json({ version: data });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
