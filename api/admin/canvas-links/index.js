// Canvas Links Manager admin endpoints.
//
// GET  -> list every CanvasBuilder page (i_edit_page where builder_type =
//         'canvas') for the tenant, each with the flat list of links extracted
//         from its canvas_design document.
// PUT  -> apply a single link update: given { pageId, blockId, path, value },
//         load that page's canvas_design, set the value at the addressable
//         path (including rewriting inline <a> hrefs in rich-text html), and
//         persist. Reuses the same minimal shape validation as the dedicated
//         canvas-design CRUD endpoint so stored documents stay valid.
//
// Tenant safety: TENANT-scoped, never anonymous. RBAC mirrors other admin
// endpoints — platform/admin (tenant_user) sessions bypass per-feature RBAC;
// member sessions must hold the `admin.canvas-links-manager` feature.

import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasFeatureAccess, hasAdminAccess } from '../../_lib/tenantContext.js';
import {
  extractCanvasLinks,
  applyCanvasLinkUpdate,
} from '../../../client/src/lib/canvasLinks.js';

const FEATURE_ID = 'admin.canvas-links-manager';

async function authorize(req, res) {
  const context = await getTenantContext(req);
  if (!context.isAuthenticated) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  if (!context.tenantId) {
    res.status(400).json({ error: 'Tenant context not found' });
    return null;
  }
  if (await hasAdminAccess(context)) {
    return context;
  }
  if (!context.roleId) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  const allowed = await hasFeatureAccess(context.roleId, FEATURE_ID);
  if (!allowed) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  return context;
}

async function listLinks(req, res, context) {
  const { data, error } = await supabase
    .from('i_edit_page')
    .select('id, title, slug, status, layout_type, builder_type, canvas_design')
    .eq('tenant_id', context.tenantId)
    .eq('builder_type', 'canvas')
    .order('title', { ascending: true });

  if (error) {
    console.error('[CanvasLinks] list error:', error);
    return res.status(500).json({ error: 'Failed to load canvas pages' });
  }

  const pages = (data || []).map((page) => {
    let links = [];
    try {
      links = extractCanvasLinks(page.canvas_design);
    } catch (err) {
      console.error('[CanvasLinks] extract error for page', page.id, err);
      links = [];
    }
    return {
      id: page.id,
      title: page.title,
      slug: page.slug,
      status: page.status,
      layout_type: page.layout_type,
      links,
    };
  });

  // Lightweight internal-page picker list (title + slug), same tenant scope.
  const internalPages = pages.map((p) => ({ id: p.id, title: p.title, slug: p.slug }));

  return res.json({ pages, internalPages });
}

async function updateLink(req, res, context) {
  const body = req.body || {};
  const { pageId, blockId, path, value } = body;

  if (!pageId || typeof pageId !== 'string') {
    return res.status(400).json({ error: 'pageId is required' });
  }
  if (!blockId || typeof blockId !== 'string') {
    return res.status(400).json({ error: 'blockId is required' });
  }
  if (!path || typeof path !== 'object' || !Array.isArray(path.contentPath) || !path.contentPath.length) {
    return res.status(400).json({ error: 'A valid path.contentPath is required' });
  }
  if (typeof value !== 'string') {
    return res.status(400).json({ error: 'value (string) is required' });
  }

  // Load the page (tenant-scoped) and confirm it is a canvas page.
  const { data: page, error: readErr } = await supabase
    .from('i_edit_page')
    .select('id, builder_type, canvas_design')
    .eq('id', pageId)
    .eq('tenant_id', context.tenantId)
    .maybeSingle();

  if (readErr) {
    console.error('[CanvasLinks] update read error:', readErr);
    return res.status(500).json({ error: 'Failed to load page' });
  }
  if (!page) return res.status(404).json({ error: 'Page not found' });
  if (page.builder_type !== 'canvas') {
    return res.status(409).json({ error: 'Page is not a Canvas Builder page' });
  }

  const design = page.canvas_design;
  if (!design || typeof design !== 'object' || Array.isArray(design)) {
    return res.status(409).json({ error: 'Page has no canvas design to update' });
  }

  // Apply on a deep clone so a failure mid-way never leaves a partial doc.
  let nextDesign;
  try {
    nextDesign = JSON.parse(JSON.stringify(design));
    applyCanvasLinkUpdate(nextDesign, blockId, path, value);
  } catch (err) {
    console.error('[CanvasLinks] apply error:', err);
    return res.status(400).json({ error: err.message || 'Failed to apply link update' });
  }

  // Mirror the canvas-design endpoint's minimal shape validation.
  if (typeof nextDesign.version !== 'number') {
    return res.status(409).json({ error: 'Resulting canvas_design.version is invalid' });
  }
  if (!nextDesign.root || typeof nextDesign.root !== 'object' || Array.isArray(nextDesign.root)) {
    return res.status(409).json({ error: 'Resulting canvas_design.root is invalid' });
  }
  if (!Array.isArray(nextDesign.root.sections)) {
    return res.status(409).json({ error: 'Resulting canvas_design.root.sections is invalid' });
  }

  const { error: updateErr } = await supabase
    .from('i_edit_page')
    .update({ canvas_design: nextDesign })
    .eq('id', pageId)
    .eq('tenant_id', context.tenantId);

  if (updateErr) {
    console.error('[CanvasLinks] update write error:', updateErr);
    return res.status(500).json({ error: 'Failed to save link update' });
  }

  // Return the freshly extracted links for this page so the UI can refresh.
  let links = [];
  try {
    links = extractCanvasLinks(nextDesign);
  } catch (err) {
    console.error('[CanvasLinks] re-extract error:', err);
  }
  return res.json({ ok: true, pageId, links });
}

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const context = await authorize(req, res);
  if (!context) return;

  try {
    if (req.method === 'GET') {
      return await listLinks(req, res, context);
    }
    if (req.method === 'PUT' || req.method === 'PATCH') {
      return await updateLink(req, res, context);
    }
    res.setHeader('Allow', 'GET, PUT, PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[CanvasLinks] handler error', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
