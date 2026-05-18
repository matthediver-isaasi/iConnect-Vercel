// Canvas page audit history (Task #919)
//
// Routes:
//   GET    /api/canvas-page-audits/:pageId            → list recent runs (no issues payload)
//   GET    /api/canvas-page-audits/:pageId?runId=     → single run with full issues payload
//   POST   /api/canvas-page-audits/:pageId            → record a new run
//
// Tenant hard-fail on every request. Page must exist, be canvas-typed,
// and belong to the calling tenant. Access is restricted to authors with
// the `site-builder.page-editor` feature (or tenant admins) — same gate
// used by canvas-versions.

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';

const MAX_KEEP = 20;
const DEFAULT_LIST_LIMIT = 10;

async function loadCanvasPage(pageId, tenantId) {
  const { data, error } = await supabase
    .from('i_edit_page')
    .select('id, tenant_id, builder_type')
    .eq('id', pageId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) return { error };
  if (!data) return { notFound: true };
  if (data.builder_type !== 'canvas') return { wrongBuilder: true };
  return { page: data };
}

function summarizeIssues(issues) {
  let error = 0, warning = 0, info = 0;
  for (const i of issues) {
    if (i?.severity === 'error') error += 1;
    else if (i?.severity === 'warning') warning += 1;
    else info += 1;
  }
  return { error_count: error, warning_count: warning, info_count: info, total_count: issues.length };
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

  let canEditCanvasPages = !!context.tenantUserId;
  if (!canEditCanvasPages && context.roleId) {
    canEditCanvasPages = await hasFeatureAccess(context.roleId, 'site-builder.page-editor');
  }
  if (!canEditCanvasPages) return res.status(404).json({ error: 'Page not found' });

  const tenantId = context.tenantId;

  const pageCheck = await loadCanvasPage(pageId, tenantId);
  if (pageCheck.error) return res.status(500).json({ error: 'Failed to load page' });
  if (pageCheck.notFound) return res.status(404).json({ error: 'Page not found' });
  if (pageCheck.wrongBuilder) return res.status(409).json({ error: 'Page is not a Canvas Builder page' });

  if (req.method === 'GET') {
    const runId = typeof req.query.runId === 'string' ? req.query.runId : null;
    if (runId) {
      const { data, error } = await supabase
        .from('canvas_page_audit_run')
        .select('*')
        .eq('id', runId)
        .eq('page_id', pageId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (error) return res.status(500).json({ error: 'Failed to load audit run' });
      if (!data) return res.status(404).json({ error: 'Audit run not found' });
      return res.status(200).json({ run: data });
    }

    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIST_LIMIT, 1),
      MAX_KEEP,
    );
    const { data, error } = await supabase
      .from('canvas_page_audit_run')
      .select('id, page_id, run_by_name, run_by_member_id, run_by_tenant_user_id, total_count, error_count, warning_count, info_count, created_at')
      .eq('page_id', pageId)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: 'Failed to load audit runs' });
    return res.status(200).json({ runs: data || [] });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (!Array.isArray(body.issues)) {
      return res.status(400).json({ error: 'issues must be an array' });
    }
    // Defensive clamp — drawer only stores its own findings, so any
    // pathologically large payload signals a bug, not legitimate data.
    if (body.issues.length > 10000) {
      return res.status(413).json({ error: 'Too many issues to persist' });
    }
    const counts = summarizeIssues(body.issues);
    const runByName =
      (typeof body.runByName === 'string' && body.runByName.trim()) ||
      (context.tenantUserId ? 'Admin user' : 'Member');

    const { data, error } = await supabase
      .from('canvas_page_audit_run')
      .insert({
        tenant_id: tenantId,
        page_id: pageId,
        run_by_member_id: context.memberId || null,
        run_by_tenant_user_id: context.tenantUserId || null,
        run_by_name: runByName,
        ...counts,
        issues: body.issues,
      })
      .select('id, page_id, run_by_name, run_by_member_id, run_by_tenant_user_id, total_count, error_count, warning_count, info_count, created_at')
      .single();
    if (error) return res.status(500).json({ error: 'Failed to save audit run' });

    // Trim history beyond MAX_KEEP per page to keep the table tidy.
    const { data: all } = await supabase
      .from('canvas_page_audit_run')
      .select('id')
      .eq('page_id', pageId)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });
    if (Array.isArray(all) && all.length > MAX_KEEP) {
      const toDelete = all.slice(MAX_KEEP).map((r) => r.id);
      if (toDelete.length > 0) {
        await supabase.from('canvas_page_audit_run').delete().in('id', toDelete);
      }
    }

    return res.status(201).json({ run: data });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
