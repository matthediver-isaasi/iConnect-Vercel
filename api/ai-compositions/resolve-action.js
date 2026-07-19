// AI Design Studio V2 Phase 2 (Task #2906) — editor action resolution.
//
// POST /api/ai-compositions/resolve-action
//   { compositionId, actionKey, target }
//
// An unresolved data-ai-action in a stored V2 document is connected to a real
// tenant record picked by the editor (via /api/ai-compositions/destinations).
// The server verifies the target belongs to this tenant, builds the canonical
// href itself (the client never invents internal URLs) and writes a NEW
// immutable ai_composition_version — the stored document history is never
// mutated in place.

import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { canUseAiFeature, AI_FEATURE_GENERATE } from '../_lib/aiStudioAccess.js';
import {
  resolveActionWithTarget,
  makeSupabaseActionLookupsById,
} from '../_lib/aiCodeActions.js';

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
  if (!(await canUseAiFeature(context, AI_FEATURE_GENERATE))) {
    return res.status(404).json({ error: 'Not found' });
  }
  const tenantId = context.tenantId;

  const { compositionId, actionKey, target } = req.body || {};
  if (!compositionId || !actionKey) {
    return res.status(400).json({ error: 'compositionId and actionKey are required' });
  }

  // Load the V2 composition + current version (tenant-scoped).
  const { data: comp } = await supabase
    .from('ai_composition')
    .select('id, name, renderer_version, current_version_id')
    .eq('id', compositionId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!comp) return res.status(404).json({ error: 'Composition not found' });
  if (comp.renderer_version !== 2 || !comp.current_version_id) {
    return res.status(400).json({ error: 'Actions can only be resolved on V2 compositions.' });
  }
  const { data: version } = await supabase
    .from('ai_composition_version')
    .select('id, document')
    .eq('id', comp.current_version_id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  const doc = version?.document;
  if (!doc) return res.status(404).json({ error: 'Composition version not found' });

  const actions = Array.isArray(doc.actions) ? doc.actions : [];
  const idx = actions.findIndex((a) => a && a.key === actionKey);
  if (idx === -1) return res.status(404).json({ error: 'Action not found on this composition' });

  const result = await resolveActionWithTarget(
    actions[idx],
    target || {},
    makeSupabaseActionLookupsById(supabase, tenantId),
  );
  if (result.error) return res.status(400).json({ error: result.error });

  const nextActions = actions.slice();
  nextActions[idx] = result.action;
  const nextDoc = { ...doc, actions: nextActions };

  const { data: inserted, error: insErr } = await supabase
    .from('ai_composition_version')
    .insert({
      composition_id: comp.id,
      tenant_id: tenantId,
      parent_version_id: version.id,
      document: nextDoc,
      change_summary: `Linked "${result.action.label || result.action.key}" to ${result.action.recordTitle || result.action.href}`,
      operation_type: 'edit',
      generation_metadata: { kind: 'resolve_action', actionKey },
      created_by: context.memberId || null,
    })
    .select('id')
    .single();
  if (insErr) return res.status(500).json({ error: 'Failed to save the updated version' });

  await supabase
    .from('ai_composition')
    .update({ current_version_id: inserted.id, updated_at: new Date().toISOString() })
    .eq('id', comp.id)
    .eq('tenant_id', tenantId);

  return res.status(200).json({
    versionId: inserted.id,
    action: result.action,
  });
}
