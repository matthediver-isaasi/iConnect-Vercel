// AI Composition visual review endpoint — Phase 4 (Task #2852, spec §13 stage 9).
//
// POST /api/ai-compositions/review  { compositionId, screenshots? }
//   screenshots: optional [{ breakpoint: 'desktop'|'tablet'|'mobile', dataUrl }]
//   captured client-side from the rendered preview. The vision model reviews
//   the render + the structured document; bounded correction cycles apply
//   ONLY safe update_style patches. A corrected result is saved as a new
//   version (operation_type 'visual_review'); otherwise nothing changes.
//
// Editors only; 404 (not 403) so composition existence never leaks.

import OpenAI from 'openai';
import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { canUseAiFeature, AI_FEATURE_GENERATE } from '../_lib/aiStudioAccess.js';
import { runVisualReview } from '../_lib/aiCompositionReview.js';
import { runCompositionValidation, summarizeValidation } from '../_lib/aiCompositionValidation.js';
import { loadStudioSettings } from '../_lib/aiDesignStudioSettings.js';
import { checkAiUsageAllowance, recordAiUsageEvent } from '../_lib/aiUsage.js';

function getOpenAIClient() {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (!apiKey) return null;
  return new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
}

const MAX_SCREENSHOTS = 3;
const MAX_DATA_URL_CHARS = 2_000_000; // ~1.5MB per image

function sanitizeScreenshots(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const s of input.slice(0, MAX_SCREENSHOTS)) {
    if (!s || typeof s.dataUrl !== 'string') continue;
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(s.dataUrl)) continue;
    if (s.dataUrl.length > MAX_DATA_URL_CHARS) continue;
    out.push({
      breakpoint: ['desktop', 'tablet', 'mobile'].includes(s.breakpoint) ? s.breakpoint : 'desktop',
      dataUrl: s.dataUrl,
    });
  }
  return out;
}

function makeCallVision(client) {
  return async ({ system, user, images }) => {
    const content = [{ type: 'text', text: user }];
    for (const img of images || []) {
      content.push({ type: 'text', text: `Screenshot (${img.breakpoint}):` });
      content.push({ type: 'image_url', image_url: { url: img.dataUrl, detail: 'low' } });
    }
    let completion;
    try {
      completion = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_completion_tokens: 2000,
      });
    } catch {
      throw Object.assign(
        new Error('The visual review service is temporarily unavailable. Nothing was changed.'),
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
  // Permission split (spec §29): visual review is a generation-side action.
  if (!(await canUseAiFeature(context, AI_FEATURE_GENERATE))) {
    return res.status(404).json({ error: 'Not found' });
  }
  const tenantId = context.tenantId;
  const memberId = context.memberId || null;

  const body = req.body || {};
  const compositionId = String(body.compositionId || '');
  if (!compositionId) return res.status(400).json({ error: 'compositionId is required' });

  try {
    const { data: comp } = await supabase
      .from('ai_composition')
      .select('id, tenant_id, page_id, name, composition_type, current_version_id')
      .eq('id', compositionId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!comp?.current_version_id) return res.status(404).json({ error: 'Composition not found' });
    const { data: version } = await supabase
      .from('ai_composition_version')
      .select('id, document')
      .eq('id', comp.current_version_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!version?.document) return res.status(404).json({ error: 'Composition not found' });
    const doc = version.document;

    const client = getOpenAIClient();
    if (!client) return res.status(503).json({ error: 'Visual review is not configured on this server.' });

    // Governance gate (Phase 4).
    const settings = await loadStudioSettings(supabase, tenantId);
    const allowance = await checkAiUsageAllowance(supabase, {
      tenantId,
      memberId,
      settings,
      operation: 'visual_review',
      prompt: `review:${compositionId}:${version.id}`,
    });
    if (!allowance.ok) {
      await recordAiUsageEvent(supabase, {
        tenantId,
        memberId,
        compositionId,
        operation: 'visual_review',
        units: {},
        status: 'blocked',
        dedupeHash: allowance.dedupeHash,
      });
      return res.status(allowance.status).json(allowance.body);
    }

    const images = sanitizeScreenshots(body.screenshots);
    const brand = await buildBrandContext(tenantId);
    const result = await runVisualReview({
      doc,
      brand,
      images,
      callVision: makeCallVision(client),
      maxCycles: settings.maxReviewCycles,
    });

    let newVersionId = null;
    let validation = null;
    if (result.changed) {
      validation = runCompositionValidation(result.doc);
      const { data: inserted, error: insErr } = await supabase
        .from('ai_composition_version')
        .insert({
          composition_id: comp.id,
          tenant_id: tenantId,
          parent_version_id: version.id,
          document: result.doc,
          change_summary: 'Visual review corrections',
          operation_type: 'visual_review',
          validation_result: validation,
          generation_metadata: { cycles: result.cycles },
          created_by: memberId,
        })
        .select('id')
        .single();
      if (insErr) throw new Error('Failed to save the reviewed version');
      newVersionId = inserted.id;
      await supabase
        .from('ai_composition')
        .update({ current_version_id: newVersionId, updated_at: new Date().toISOString() })
        .eq('id', comp.id)
        .eq('tenant_id', tenantId);
    } else {
      validation = runCompositionValidation(doc);
    }

    await recordAiUsageEvent(supabase, {
      tenantId,
      memberId,
      compositionId,
      operation: 'visual_review',
      model: 'gpt-4o-mini',
      units: { reviewCycles: result.cycles.length },
      dedupeHash: allowance.dedupeHash,
    });

    return res.status(200).json({
      status: result.changed ? 'corrected' : 'reviewed',
      versionId: newVersionId || version.id,
      changed: result.changed,
      cycles: result.cycles,
      document: result.doc,
      validation: {
        ok: validation.ok,
        summary: summarizeValidation(validation),
        critical: validation.critical.slice(0, 10),
        warnings: validation.warnings.slice(0, 10),
      },
      usageWarning: allowance.warning || undefined,
    });
  } catch (err) {
    const status = err.httpStatus || 500;
    return res.status(status).json({ error: err.message || 'Visual review failed' });
  }
}
