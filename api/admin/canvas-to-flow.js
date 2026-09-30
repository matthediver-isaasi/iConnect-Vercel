// Convert (opt-in migrate) one or more Canvas Builder pages from the v1
// (absolute-positioned) design model to the v2 (flow / auto-layout) model —
// with a pre-write backup and content-preservation verification per page.
//
// POST /api/admin/canvas-to-flow
//   body (JSON): { pageIds: string[] }
//
// For each page:
//   1. Load the current canvas_design (tenant-scoped, canvas builder only).
//   2. If it is already a v2 flow design, report "already flow" (no write).
//   3. Convert with convertDesignToFlow (deterministic, React-free).
//   4. Verify EVERY authored leaf block survives the conversion (same id set);
//      on failure the page is left untouched and reported as an error.
//   5. Snapshot the original to canvas_page_version (source 'pre-flow-migration')
//      BEFORE any write, then write the converted design back.
//
// Returns { results: [{ pageId, status, ... }] }. Gated by `site-builder.pages`.

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';
import {
  convertDesignToFlow,
  isFlowDesign,
  isFlowContainerType,
  forEachFlowNode,
} from '../../client/src/lib/canvasDesign.js';

const MAX_KEEP = 50;
const MAX_PAGES = 50;

// Collect the set of leaf (non-container) block ids from a v1 design's flat
// section children. These are the authored content blocks that MUST survive.
function v1LeafIds(design) {
  const ids = new Set();
  const sections = design?.root?.sections || [];
  for (const section of sections) {
    for (const b of section.children || []) {
      if (b && b.id) ids.add(b.id);
    }
  }
  return ids;
}

// Collect the set of leaf (non-container) block ids from a v2 flow design.
function flowLeafIds(design) {
  const ids = new Set();
  forEachFlowNode(design, (node) => {
    if (node && node.id && !isFlowContainerType(node.type)) ids.add(node.id);
  });
  return ids;
}

// Every authored leaf must appear exactly once in the converted design.
function verifyLeavesPreserved(before, after) {
  const beforeIds = v1LeafIds(before);
  const afterIds = flowLeafIds(after);
  const missing = [...beforeIds].filter((id) => !afterIds.has(id));
  const added = [...afterIds].filter((id) => !beforeIds.has(id));
  if (missing.length) return { ok: false, reason: `dropped ${missing.length} block(s): ${missing.slice(0, 5).join(', ')}` };
  if (added.length) return { ok: false, reason: `introduced ${added.length} unexpected block(s): ${added.slice(0, 5).join(', ')}` };
  return { ok: true };
}

async function trimVersions(pageId, tenantId) {
  const { data: all } = await supabase
    .from('canvas_page_version')
    .select('id, created_at')
    .eq('page_id', pageId)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  if (Array.isArray(all) && all.length > MAX_KEEP) {
    const toDelete = all.slice(MAX_KEEP).map((r) => r.id);
    if (toDelete.length) await supabase.from('canvas_page_version').delete().in('id', toDelete);
  }
}

async function convertOne(pageId, tenantId, memberId) {
  const { data: page, error } = await supabase
    .from('i_edit_page')
    .select('id, title, builder_type, canvas_design')
    .eq('id', pageId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (error) return { pageId, status: 'error', message: 'Failed to load page' };
  if (!page) return { pageId, status: 'skipped', message: 'Page not found' };
  if (page.builder_type !== 'canvas') {
    return { pageId, title: page.title, status: 'skipped', message: 'Not a Canvas Builder page' };
  }
  const design = page.canvas_design;
  if (!design || typeof design !== 'object' || !design.root) {
    return { pageId, title: page.title, status: 'skipped', message: 'Page has no canvas design' };
  }
  if (isFlowDesign(design)) {
    return { pageId, title: page.title, status: 'unchanged', message: 'Already a flow (v2) design' };
  }

  let converted;
  try {
    converted = convertDesignToFlow(design);
  } catch (e) {
    return { pageId, title: page.title, status: 'error', message: 'Conversion failed: ' + (e?.message || 'unknown') };
  }

  const verify = verifyLeavesPreserved(design, converted);
  if (!verify.ok) {
    return {
      pageId,
      title: page.title,
      status: 'error',
      message: 'Content-preservation check failed: ' + verify.reason,
    };
  }

  // Backup BEFORE writing.
  const { error: bkErr } = await supabase.from('canvas_page_version').insert({
    page_id: pageId,
    tenant_id: tenantId,
    design,
    label: 'Auto-snapshot before flow migration',
    source: 'pre-flow-migration',
    created_by: memberId || null,
  });
  if (bkErr) {
    return { pageId, title: page.title, status: 'error', message: 'Failed to back up page before migration' };
  }

  const { error: updErr } = await supabase
    .from('i_edit_page')
    .update({ canvas_design: converted })
    .eq('id', pageId)
    .eq('tenant_id', tenantId);
  if (updErr) {
    return { pageId, title: page.title, status: 'error', message: 'Failed to save converted page' };
  }

  await trimVersions(pageId, tenantId);

  return { pageId, title: page.title, status: 'converted', message: 'Migrated to flow (v2)' };
}

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let context;
  try { context = await getTenantContext(req); }
  catch { return res.status(500).json({ error: 'Failed to resolve tenant context' }); }
  if (!context?.tenantId) return res.status(403).json({ error: 'Tenant context required' });
  if (!context.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });

  let canEdit = !!context.tenantUserId;
  if (!canEdit && context.roleId) {
    canEdit = await hasFeatureAccess(context.roleId, 'site-builder.pages');
  }
  if (!canEdit) return res.status(404).json({ error: 'Not found' });

  const body = req.body || {};
  const pageIds = Array.isArray(body.pageIds) ? body.pageIds.filter((id) => typeof id === 'string') : [];
  if (pageIds.length === 0) return res.status(400).json({ error: 'pageIds is required' });
  if (pageIds.length > MAX_PAGES) return res.status(400).json({ error: `Too many pages (max ${MAX_PAGES})` });

  const unique = [...new Set(pageIds)];
  const results = [];
  for (const pageId of unique) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await convertOne(pageId, context.tenantId, context.memberId));
  }

  return res.status(200).json({ results });
}
