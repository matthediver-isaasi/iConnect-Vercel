// Clean up one or more Canvas Builder pages: spacing/rhythm normalization,
// sample-content removal, and per-row card-height equalization — with a
// pre-write backup and content-preservation verification per page.
//
// POST /api/admin/canvas-cleanup
//   body (JSON): { pageIds: string[] }
//
// For each page:
//   1. Load the current canvas_design (tenant-scoped, canvas builder only).
//   2. Snapshot it to canvas_page_version (source 'pre-cleanup') BEFORE any write.
//   3. Run cleanupDesign (idempotent). If verification fails, the page is left
//      untouched and reported as an error.
//   4. If anything changed, write the cleaned design back; otherwise report
//      "already clean".
//
// Returns { results: [{ pageId, status, ... }] }. Gated by `site-builder.pages`.

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';
import { cleanupDesign } from '../../scripts/lib/canvasSpacing.mjs';

const MAX_KEEP = 50;
const MAX_PAGES = 50;

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

async function cleanupOne(pageId, tenantId, memberId) {
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

  let result;
  try {
    result = cleanupDesign(design);
  } catch (e) {
    return { pageId, title: page.title, status: 'error', message: 'Cleanup failed: ' + (e?.message || 'unknown') };
  }

  if (!result.verify?.ok) {
    return {
      pageId,
      title: page.title,
      status: 'error',
      message: 'Content-preservation check failed: ' + (result.verify?.reason || 'unknown'),
    };
  }

  if (result.changes.length === 0) {
    return { pageId, title: page.title, status: 'unchanged', message: 'Already clean', removed: 0, changes: 0 };
  }

  // Backup BEFORE writing.
  const { error: bkErr } = await supabase.from('canvas_page_version').insert({
    page_id: pageId,
    tenant_id: tenantId,
    design,
    label: 'Auto-snapshot before cleanup',
    source: 'pre-cleanup',
    created_by: memberId || null,
  });
  if (bkErr) {
    return { pageId, title: page.title, status: 'error', message: 'Failed to back up page before cleanup' };
  }

  const { error: updErr } = await supabase
    .from('i_edit_page')
    .update({ canvas_design: result.design })
    .eq('id', pageId)
    .eq('tenant_id', tenantId);
  if (updErr) {
    return { pageId, title: page.title, status: 'error', message: 'Failed to save cleaned page' };
  }

  await trimVersions(pageId, tenantId);

  return {
    pageId,
    title: page.title,
    status: 'cleaned',
    removed: result.removed.length,
    changes: result.changes.length,
  };
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
    results.push(await cleanupOne(pageId, context.tenantId, context.memberId));
  }

  return res.status(200).json({ results });
}
