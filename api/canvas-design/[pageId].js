// Dedicated Canvas Builder design CRUD endpoint.
//
// The shared entity API at /api/entities/[entity] already handles IEditPage
// reads/writes (including the canvas_design column) with strict tenant-id
// hard-fails. This route exists alongside it as a focused, tenant-hard-fail
// surface for the Canvas Builder editor so future phases can layer
// design-specific concerns (versioning, partial patches, autosave, etc.)
// without touching the generic entity handler.
//
// Tenant safety: this endpoint refuses any request without a usable tenant
// context (no anonymous public access), and every query is filtered by
// `tenant_id`. Cross-tenant access is impossible because the page must
// match both `id` and the caller's tenant_id.

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';
import { reindexMemberContentEntitySafe } from '../_lib/memberContentReindexHook.js';

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { pageId } = req.query;
  if (!pageId || typeof pageId !== 'string') {
    return badRequest(res, 'pageId is required');
  }

  let context;
  try {
    context = await getTenantContext(req);
  } catch (err) {
    console.error('[CanvasDesign] Failed to resolve tenant context:', err);
    return res.status(500).json({ error: 'Failed to resolve tenant context' });
  }

  // Hard-fail: this endpoint is TENANT-scoped and never serves anonymous
  // requests for either reads or writes. Canvas design documents are
  // authoring data — public consumption happens through the public page
  // endpoint and the prerender, not through this CRUD surface.
  if (!context?.tenantId) {
    return res.status(403).json({ error: 'Tenant context required' });
  }
  if (!context.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // SECURITY: Canvas design documents are authoring data (drafts +
  // published). Only tenant admin users (admin dashboard) or members with
  // the `site-builder.page-editor` feature may read or write them.
  // Returning 404 instead of 403 avoids leaking which page IDs exist.
  const isTenantAdminUser = !!context.tenantUserId;
  let canEditCanvasPages = isTenantAdminUser;
  if (!canEditCanvasPages && context.roleId) {
    canEditCanvasPages = await hasFeatureAccess(context.roleId, 'site-builder.page-editor');
  }
  if (!canEditCanvasPages) {
    return res.status(404).json({ error: 'Page not found' });
  }

  const tenantId = context.tenantId;

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('i_edit_page')
      .select('id, title, slug, status, layout_type, builder_type, canvas_design')
      .eq('id', pageId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) {
      console.error('[CanvasDesign] GET error:', error);
      return res.status(500).json({ error: 'Failed to load page' });
    }
    if (!data) return res.status(404).json({ error: 'Page not found' });
    if (data.builder_type !== 'canvas') {
      return res.status(409).json({ error: 'Page is not a Canvas Builder page' });
    }
    return res.status(200).json({ page: data });
  }

  if (req.method === 'PUT' || req.method === 'PATCH') {
    const body = req.body || {};
    const design = body.canvas_design;
    if (!design || typeof design !== 'object' || Array.isArray(design)) {
      return badRequest(res, 'canvas_design (object) is required');
    }
    // Minimal shape validation — keep the door narrow on what enters
    // storage so later phases can rely on at least { version, root.sections }.
    if (typeof design.version !== 'number') {
      return badRequest(res, 'canvas_design.version (number) is required');
    }
    if (!design.root || typeof design.root !== 'object' || Array.isArray(design.root)) {
      return badRequest(res, 'canvas_design.root (object) is required');
    }
    if (!Array.isArray(design.root.sections)) {
      return badRequest(res, 'canvas_design.root.sections (array) is required');
    }

    // Re-read the page first to confirm tenant ownership and that this is
    // actually a Canvas page. The builder_type immutability DB trigger
    // ensures we cannot accidentally flip an iEdit page to Canvas via this
    // endpoint.
    const { data: existing, error: readErr } = await supabase
      .from('i_edit_page')
      .select('id, tenant_id, builder_type')
      .eq('id', pageId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (readErr) {
      console.error('[CanvasDesign] PUT preflight error:', readErr);
      return res.status(500).json({ error: 'Failed to load page' });
    }
    if (!existing) return res.status(404).json({ error: 'Page not found' });
    if (existing.builder_type !== 'canvas') {
      return res.status(409).json({ error: 'Page is not a Canvas Builder page' });
    }

    const { data: updated, error: updateErr } = await supabase
      .from('i_edit_page')
      .update({ canvas_design: body.canvas_design })
      .eq('id', pageId)
      .eq('tenant_id', tenantId)
      .select('id, canvas_design')
      .single();

    if (updateErr) {
      console.error('[CanvasDesign] PUT error:', updateErr);
      return res.status(500).json({ error: 'Failed to save canvas design' });
    }

    // Best-effort: keep the member AI knowledge base in sync with the new
    // design text. This endpoint bypasses the generic entity API (which
    // triggers the same hook), so trigger it explicitly here. Never blocks or
    // fails the save; the nightly cron reconciles anything missed.
    reindexMemberContentEntitySafe('IEditPage', { id: pageId, tenant_id: tenantId }).catch(() => {});

    return res.status(200).json({ page: updated });
  }

  res.setHeader('Allow', 'GET, PUT, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
}
