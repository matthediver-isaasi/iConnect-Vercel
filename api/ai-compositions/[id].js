// AI Composition read / versions / restore / discard (Task #2849).
//
// Routes:
//   GET    /api/ai-compositions/:id                → current document (public: any
//                                                    visitor of the owning tenant may
//                                                    read — the composition renders on
//                                                    public pages)
//   GET    /api/ai-compositions/:id?versions=1     → version list (editors only)
//   GET    /api/ai-compositions/:id?versionId=…    → one version with document (editors)
//   POST   /api/ai-compositions/:id?restore=1      → restore (body: {versionId}) (editors)
//   DELETE /api/ai-compositions/:id                → discard the composition (editors)
//
// Tenant hard-fail on every request. Editor-only routes return 404 (not 403)
// so composition existence is never leaked.

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';
import {
  selectVersionsToPrune,
  buildRestoreVersion,
} from '../_lib/aiCompositionVersioning.js';

async function canEditPages(context) {
  if (context.tenantUserId) return true;
  if (context.roleId) return hasFeatureAccess(context.roleId, 'site-builder.page-editor');
  return false;
}

async function pruneVersions(compositionId, tenantId, currentVersionId) {
  const { data: versions } = await supabase
    .from('ai_composition_version')
    .select('id, created_at, locked')
    .eq('composition_id', compositionId)
    .eq('tenant_id', tenantId);
  const toDelete = selectVersionsToPrune(versions || [], currentVersionId);
  if (toDelete.length > 0) {
    await supabase.from('ai_composition_version').delete().in('id', toDelete);
  }
}

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  const { id } = req.query;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id required' });

  let context;
  try { context = await getTenantContext(req); }
  catch { return res.status(500).json({ error: 'Failed to resolve tenant context' }); }
  if (!context?.tenantId) return res.status(403).json({ error: 'Tenant context required' });
  const tenantId = context.tenantId;

  const { data: comp, error: compErr } = await supabase
    .from('ai_composition')
    .select('id, tenant_id, page_id, name, composition_type, status, current_version_id, created_at')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (compErr) return res.status(500).json({ error: 'Failed to load composition' });
  if (!comp) return res.status(404).json({ error: 'Not found' });

  if (req.method === 'GET') {
    const wantVersions = req.query.versions === '1';
    const versionId = req.query.versionId;

    if (!wantVersions && !versionId) {
      // Public read of the CURRENT document only (tenant-scoped above).
      if (!comp.current_version_id) {
        return res.status(200).json({ composition: comp, document: null });
      }
      const { data: version, error } = await supabase
        .from('ai_composition_version')
        .select('id, document, created_at')
        .eq('id', comp.current_version_id)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (error) return res.status(500).json({ error: 'Failed to load document' });
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
      return res.status(200).json({
        composition: comp,
        document: version?.document || null,
        versionId: version?.id || null,
      });
    }

    // Editor-only surfaces below.
    if (!context.isAuthenticated) return res.status(404).json({ error: 'Not found' });
    if (!(await canEditPages(context))) return res.status(404).json({ error: 'Not found' });

    if (versionId) {
      const { data, error } = await supabase
        .from('ai_composition_version')
        .select('*')
        .eq('id', versionId)
        .eq('composition_id', id)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (error) return res.status(500).json({ error: 'Failed to load version' });
      if (!data) return res.status(404).json({ error: 'Version not found' });
      return res.status(200).json({ version: data });
    }

    const { data: versions, error } = await supabase
      .from('ai_composition_version')
      .select('id, parent_version_id, change_summary, operation_type, is_alternative, locked, created_by, created_at')
      .eq('composition_id', id)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed to load versions' });
    return res.status(200).json({
      composition: comp,
      versions: versions || [],
      currentVersionId: comp.current_version_id,
    });
  }

  // Mutations require an authenticated editor.
  if (!context.isAuthenticated) return res.status(404).json({ error: 'Not found' });
  if (!(await canEditPages(context))) return res.status(404).json({ error: 'Not found' });

  if (req.method === 'POST' && req.query.restore === '1') {
    const versionId = req.body?.versionId;
    if (!versionId) return res.status(400).json({ error: 'versionId required' });
    const { data: source, error: srcErr } = await supabase
      .from('ai_composition_version')
      .select('*')
      .eq('id', versionId)
      .eq('composition_id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (srcErr) return res.status(500).json({ error: 'Failed to load version' });
    if (!source) return res.status(404).json({ error: 'Version not found' });

    const row = buildRestoreVersion(source, {
      tenantId,
      compositionId: id,
      createdBy: context.memberId || null,
    });
    const { data: inserted, error: insErr } = await supabase
      .from('ai_composition_version')
      .insert(row)
      .select('id')
      .single();
    if (insErr) return res.status(500).json({ error: 'Failed to restore version' });

    await supabase
      .from('ai_composition')
      .update({ current_version_id: inserted.id, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('tenant_id', tenantId);
    await pruneVersions(id, tenantId, inserted.id);
    return res.status(200).json({ versionId: inserted.id });
  }

  if (req.method === 'DELETE') {
    // Discard the whole composition (versions cascade).
    const { error } = await supabase
      .from('ai_composition')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);
    if (error) return res.status(500).json({ error: 'Failed to discard composition' });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
