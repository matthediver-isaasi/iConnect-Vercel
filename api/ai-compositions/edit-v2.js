// AI Design Studio V2 — Phase 4 prompt-led editing endpoint (Task #2908).
//
// Routes (V2 native-code compositions only — renderer_version 2):
//   GET  /api/ai-compositions/edit-v2?compositionId=…   → conversation history
//   POST /api/ai-compositions/edit-v2  { action, ... }
//     action 'propose': { compositionId, instruction, target?, breakpoint? }
//       Runs the V2 edit pipeline (element-scoped patch or full revision) and
//       stores the proposal server-side. Returns the preview document,
//       summary and protected-content warnings.
//     action 'accept':  { conversationId, confirmProtected? } → re-applies the
//       STORED proposal against the CURRENT document server-side (never a
//       client-sent document) and creates a version. Patches become the
//       current version; revisions are saved as ALTERNATIVES without
//       switching the current version.
//     action 'reject':  { conversationId }
//     action 'undo':    { compositionId } → revert current_version_id to the
//       current version's parent.
//
// Editors only; 404 (not 403) so composition existence never leaks. Same
// governance gates as V1 edit: usage allowance, allowAiCopy strict-copy rule,
// requireFactualApproval confirm bypass.

import OpenAI from 'openai';
import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { canUseAiFeature, AI_FEATURE_GENERATE, AI_FEATURE_APPROVE } from '../_lib/aiStudioAccess.js';
import { AI_CODE_GENERATION_MODEL } from '../_lib/aiCodeGeneration.js';
import {
  normalizeV2Instruction,
  normalizeV2Breakpoint,
  resolveV2Target,
  runV2EditProposal,
  assessV2Accept,
  newCriticalIssues,
} from '../_lib/aiCodeEdit.js';
import { loadStudioSettings } from '../_lib/aiDesignStudioSettings.js';
import { checkAiUsageAllowance, recordAiUsageEvent } from '../_lib/aiUsage.js';

function getOpenAIClient() {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (!apiKey) return null;
  return new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
}

// Vision-capable caller — revisions may ride screenshots along.
function makeCallLlm(client) {
  return async ({ system, user, maxTokens, images }) => {
    const userContent = Array.isArray(images) && images.length
      ? [
          { type: 'text', text: user },
          ...images.map((img) => (typeof img === 'string'
            ? { type: 'image_url', image_url: { url: img, detail: 'low' } }
            : { type: 'image_url', image_url: { url: img.url, detail: img.detail || 'low' } })),
        ]
      : user;
    let completion;
    try {
      completion = await client.chat.completions.create({
        model: AI_CODE_GENERATION_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.4,
        max_completion_tokens: maxTokens || 6000,
      });
    } catch {
      throw Object.assign(
        new Error('The AI service is temporarily unavailable. Nothing was changed — please try again.'),
        { httpStatus: 502, providerError: true },
      );
    }
    return completion.choices?.[0]?.message?.content || '';
  };
}

async function buildBrandContext(tenantId) {
  const { data: tenantData } = await supabase
    .from('tenant')
    .select('name, primary_color, secondary_color, description')
    .eq('id', tenantId)
    .maybeSingle();
  if (!tenantData) return null;
  return {
    name: tenantData.name,
    primaryColor: tenantData.primary_color || null,
    secondaryColor: tenantData.secondary_color || null,
    tone: tenantData.description || null,
  };
}

/** Load a V2 composition + its current version. Null when not V2 / missing. */
async function loadComposition(id, tenantId) {
  const { data: comp } = await supabase
    .from('ai_composition')
    .select('id, tenant_id, page_id, name, composition_type, renderer_version, current_version_id')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!comp || comp.renderer_version !== 2 || !comp.current_version_id) return null;
  const { data: version } = await supabase
    .from('ai_composition_version')
    .select('id, parent_version_id, document, validation_result')
    .eq('id', comp.current_version_id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!version?.document || version.document.schemaVersion !== '2.0') return null;
  return { comp, version, doc: version.document };
}

/**
 * Current-design screenshot context for the model: the Phase 3 validation
 * screenshots stored on the current version (media-library URLs captured by
 * generate-v2). Nothing is captured live at propose time — no Browserless
 * budget spent on edits; a version without stored screenshots (e.g. one
 * created by an accepted edit, where Phase 3 is pending) simply yields [].
 */
function versionScreenshots(version, limit = 3) {
  const shots = version?.validation_result?.phase3?.screenshots;
  if (!Array.isArray(shots)) return [];
  return shots
    .filter((s) => s && typeof s.url === 'string' && /^https:\/\//.test(s.url))
    .slice(0, limit)
    .map((s) => ({ url: s.url, breakpoint: s.breakpoint || null }));
}

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  let context;
  try { context = await getTenantContext(req); }
  catch { return res.status(500).json({ error: 'Failed to resolve tenant context' }); }
  if (!context?.tenantId) return res.status(403).json({ error: 'Tenant context required' });
  if (!context.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });

  const requestedAction = req.method === 'POST' ? (req.body?.action || '') : '';
  const neededFeature = (requestedAction === 'accept' || requestedAction === 'undo')
    ? AI_FEATURE_APPROVE
    : AI_FEATURE_GENERATE;
  if (!(await canUseAiFeature(context, neededFeature))) {
    return res.status(404).json({ error: 'Not found' });
  }
  const tenantId = context.tenantId;

  // ---- GET: conversation history -----------------------------------------
  if (req.method === 'GET') {
    const compositionId = req.query?.compositionId;
    if (!compositionId) return res.status(400).json({ error: 'compositionId required' });
    const { data: comp } = await supabase
      .from('ai_composition')
      .select('id')
      .eq('id', compositionId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!comp) return res.status(404).json({ error: 'Not found' });
    const { data: rows } = await supabase
      .from('ai_composition_conversation')
      .select('id, instruction, target, breakpoint, kind, summary, warnings, status, version_id, created_by, created_at')
      .eq('composition_id', compositionId)
      .eq('tenant_id', tenantId)
      .in('kind', ['v2_patch', 'v2_revision'])
      .order('created_at', { ascending: false })
      .limit(50);
    return res.status(200).json({ conversation: rows || [] });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const action = body.action;

  try {
    // ---- propose ----------------------------------------------------------
    if (action === 'propose') {
      const loaded = await loadComposition(body.compositionId, tenantId);
      if (!loaded) return res.status(404).json({ error: 'Composition not found' });
      const { comp, version, doc } = loaded;

      const instruction = normalizeV2Instruction(body.instruction);
      if (!instruction) return res.status(400).json({ error: 'An instruction is required' });

      const studioSettings = await loadStudioSettings(supabase, tenantId);
      const allowance = await checkAiUsageAllowance(supabase, {
        tenantId,
        memberId: context.memberId || null,
        settings: studioSettings,
        operation: 'edit',
        prompt: instruction,
      });
      if (!allowance.ok) {
        await recordAiUsageEvent(supabase, {
          tenantId,
          memberId: context.memberId || null,
          compositionId: body.compositionId || null,
          operation: 'edit',
          units: { promptChars: instruction.length },
          status: 'blocked',
          dedupeHash: allowance.dedupeHash,
        });
        return res.status(allowance.status).json(allowance.body);
      }

      const target = resolveV2Target(doc, body.target || {});
      if (target.error) return res.status(409).json({ error: target.error });
      const breakpoint = normalizeV2Breakpoint(body.breakpoint);

      const client = getOpenAIClient();
      if (!client) return res.status(503).json({ error: 'AI editing is not configured on this server.' });
      let brand = await buildBrandContext(tenantId);
      if (studioSettings.allowAiCopy === false) {
        const copyRule = 'STRICT COPY POLICY: never write new marketing copy, claims or slogans — reuse only the existing wording in the document; trimming and re-ordering is allowed.';
        brand = { ...(brand || {}), tone: [brand?.tone, copyRule].filter(Boolean).join(' ') };
      }

      const result = await runV2EditProposal({
        callLlm: makeCallLlm(client),
        doc,
        instruction,
        target,
        breakpoint,
        brand,
        compositionId: comp.id,
        screenshots: versionScreenshots(version),
      });

      const warnings = (result.warnings || []).map((v) => ({
        type: v.type,
        key: v.key || null,
        label: v.label || null,
        before: v.before,
        after: v.after,
        reason: v.reason,
      }));

      const { data: row, error: insErr } = await supabase
        .from('ai_composition_conversation')
        .insert({
          tenant_id: tenantId,
          composition_id: comp.id,
          base_version_id: version.id,
          instruction,
          target,
          breakpoint,
          kind: result.kind,
          summary: result.summary,
          proposal: result.kind === 'v2_revision'
            ? { document: result.doc, rawCss: result.rawCss || null }
            : { patch: result.patch },
          warnings: warnings.length ? warnings : null,
          status: 'proposed',
          created_by: context.memberId || null,
        })
        .select('id')
        .single();
      if (insErr) return res.status(500).json({ error: 'Failed to save the proposal' });

      return res.status(200).json({
        status: 'proposed',
        conversationId: row.id,
        kind: result.kind,
        summary: result.summary,
        isAlternative: !!result.isAlternative,
        warnings,
        previewDocument: result.doc,
      });
    }

    // ---- accept -----------------------------------------------------------
    if (action === 'accept') {
      const { data: row } = await supabase
        .from('ai_composition_conversation')
        .select('*')
        .eq('id', body.conversationId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!row || !['v2_patch', 'v2_revision'].includes(row.kind)) {
        return res.status(404).json({ error: 'Proposal not found' });
      }
      if (row.status !== 'proposed') return res.status(409).json({ error: 'This proposal was already resolved.' });

      const loaded = await loadComposition(row.composition_id, tenantId);
      if (!loaded) return res.status(404).json({ error: 'Composition not found' });
      const { comp, version, doc } = loaded;

      const acceptSettings = await loadStudioSettings(supabase, tenantId);
      const gate = assessV2Accept({
        kind: row.kind,
        proposal: row.proposal,
        baseVersionId: row.base_version_id,
        currentVersionId: comp.current_version_id,
        currentDoc: doc,
        breakpoint: row.breakpoint || 'all',
        confirmProtected: !!body.confirmProtected || acceptSettings.requireFactualApproval === false,
      });
      if (!gate.ok) {
        return res.status(gate.status).json({
          error: gate.error,
          details: gate.details || undefined,
          warnings: gate.warnings || undefined,
          requiresConfirmation: gate.requiresConfirmation || undefined,
        });
      }
      const nextDoc = gate.doc;

      // Approval gate: deterministic accessibility criticals. Only issues
      // INTRODUCED by this change block — pre-existing debt never blocks a
      // fix (V1 parity). The full Phase 3 browser validation runs on the
      // next generation/regeneration cycle.
      const newCritical = newCriticalIssues(doc.html, nextDoc.html);
      if (newCritical.length > 0) {
        return res.status(422).json({
          error: 'This change introduces critical accessibility issues and cannot be approved.',
          code: 'AI_VALIDATION_CRITICAL',
          validation: { critical: newCritical.slice(0, 10) },
        });
      }

      const isAlternative = row.kind === 'v2_revision';
      const { data: inserted, error: insErr } = await supabase
        .from('ai_composition_version')
        .insert({
          composition_id: comp.id,
          tenant_id: tenantId,
          parent_version_id: version.id,
          document: nextDoc,
          change_summary: row.summary || row.instruction.slice(0, 200),
          operation_type: isAlternative ? 'redesign' : 'edit',
          is_alternative: isAlternative,
          validation_result: {
            pipeline: 'aiCodeEdit',
            ok: true,
            accessibility: { newCritical: [] },
            phase3: { status: 'pending' },
          },
          generation_metadata: {
            model: AI_CODE_GENERATION_MODEL,
            rendererVersion: 2,
            conversationId: row.id,
            kind: row.kind,
            breakpoint: row.breakpoint,
          },
          created_by: context.memberId || null,
        })
        .select('id')
        .single();
      if (insErr) return res.status(500).json({ error: 'Failed to save the new version' });

      // Alternatives are kept side by side; the user switches explicitly.
      if (!isAlternative) {
        await supabase
          .from('ai_composition')
          .update({ current_version_id: inserted.id, updated_at: new Date().toISOString() })
          .eq('id', comp.id)
          .eq('tenant_id', tenantId);
      }

      await supabase
        .from('ai_composition_conversation')
        .update({ status: 'accepted', version_id: inserted.id, updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('tenant_id', tenantId);

      await recordAiUsageEvent(supabase, {
        tenantId,
        memberId: context.memberId || null,
        compositionId: comp.id,
        operation: isAlternative ? 'redesign' : 'edit',
        model: AI_CODE_GENERATION_MODEL,
        units: { textCalls: 1, promptChars: (row.instruction || '').length },
      });

      return res.status(200).json({
        status: 'accepted',
        versionId: inserted.id,
        isAlternative,
        currentVersionId: isAlternative ? version.id : inserted.id,
      });
    }

    // ---- reject -----------------------------------------------------------
    if (action === 'reject') {
      const { data: row } = await supabase
        .from('ai_composition_conversation')
        .select('id, status, kind')
        .eq('id', body.conversationId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!row || !['v2_patch', 'v2_revision'].includes(row.kind)) {
        return res.status(404).json({ error: 'Proposal not found' });
      }
      await supabase
        .from('ai_composition_conversation')
        .update({ status: 'rejected', updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('tenant_id', tenantId);
      return res.status(200).json({ status: 'rejected' });
    }

    // ---- undo -------------------------------------------------------------
    if (action === 'undo') {
      const loaded = await loadComposition(body.compositionId, tenantId);
      if (!loaded) return res.status(404).json({ error: 'Composition not found' });
      const { comp, version } = loaded;
      if (!version.parent_version_id) {
        return res.status(409).json({ error: 'Nothing to undo — this is the first version.' });
      }
      const { data: parent } = await supabase
        .from('ai_composition_version')
        .select('id')
        .eq('id', version.parent_version_id)
        .eq('composition_id', comp.id)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!parent) return res.status(409).json({ error: 'The previous version no longer exists.' });
      await supabase
        .from('ai_composition')
        .update({ current_version_id: parent.id, updated_at: new Date().toISOString() })
        .eq('id', comp.id)
        .eq('tenant_id', tenantId);
      return res.status(200).json({ status: 'undone', currentVersionId: parent.id });
    }

    return res.status(400).json({ error: `Unknown action "${action}"` });
  } catch (err) {
    const status = err.httpStatus === 502 ? 502 : (err.httpStatus || 500);
    return res.status(status).json({
      error: err.message || 'Edit failed',
      validationErrors: err.validationErrors || undefined,
    });
  }
}
