// AI Design Studio V2 — Phase 1 code-first section generation (Task #2905).
//
// POST /api/ai-compositions/generate-v2
//   body (start):    { pageId, brief, direction?, creativity?, styleReference?, compositionId? }
//   body (advance):  { jobId }
//
// Staged, resumable (same ai_composition_job table as V1, options.rendererVersion=2):
//   context → code (ONE LLM attempt per invocation, retry state on the job)
// On success the sanitised V2 document (Phase 0 pipeline output) is persisted
// as ai_composition (renderer_version 2) + one immutable ai_composition_version.
// Any failure leaves the page and any existing composition untouched.

import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { canUseAiFeature, AI_FEATURE_GENERATE } from '../_lib/aiStudioAccess.js';
import { buildTenantBrandingPayload } from '../_lib/tenantBranding.js';
import { normalizeBrief, normalizeOptions } from '../_lib/aiCompositionPipeline.js';
import { tenantPublicAssetPrefix } from '../_lib/aiCompositionAssetStore.js';
import { loadStudioSettings, buildGuidanceSummary } from '../_lib/aiDesignStudioSettings.js';
import { checkAiUsageAllowance, recordAiUsageEvent } from '../_lib/aiUsage.js';
import {
  runCodeAttempt,
  MAX_CODE_RETRIES,
  AI_CODE_GENERATION_MODEL,
} from '../_lib/aiCodeGeneration.js';

const STAGE_LABELS = {
  context: 'Reading your brand and page',
  code: 'Designing your section',
};

function getOpenAIClient() {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (!apiKey) return null;
  return new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
}

// Same caller shape as V1 generate.js — style-reference screenshots ride
// along as vision inputs; the response is a JSON object.
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
        temperature: 0.5,
        max_completion_tokens: maxTokens || 12000,
      });
    } catch (err) {
      throw Object.assign(
        new Error('The AI service is temporarily unavailable. Nothing was changed — please try again.'),
        { httpStatus: 502, providerError: true },
      );
    }
    return completion.choices?.[0]?.message?.content || '';
  };
}

// Structured surrounding-page context (same contract as V1): block types +
// visible text only, strictly the requesting tenant's page.
async function buildPageContext(pageId, tenantId) {
  if (!pageId) return { blockCount: 0, blocks: [] };
  const { data: page } = await supabase
    .from('i_edit_page')
    .select('id, tenant_id, builder_type, canvas_design, name')
    .eq('id', pageId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!page || page.builder_type !== 'canvas') return { blockCount: 0, blocks: [] };
  const blocks = [];
  const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const walk = (children) => {
    for (const b of children || []) {
      if (!b || typeof b !== 'object') continue;
      const c = b.content || {};
      const text = stripTags(c.html || c.headline || c.label || c.heading || c.text || '');
      if (b.type) blocks.push({ type: b.type, text: text.slice(0, 200) });
      if (Array.isArray(b.children)) walk(b.children);
    }
  };
  for (const s of page.canvas_design?.root?.sections || []) walk(s.children);
  return { blockCount: blocks.length, blocks, pageName: page.name || null };
}

async function buildBrandContext(tenantId) {
  const { data: tenantData } = await supabase
    .from('tenant')
    .select('*')
    .eq('id', tenantId)
    .maybeSingle();
  if (!tenantData) return null;
  const payload = buildTenantBrandingPayload(tenantData);
  const { data: fonts } = await supabase
    .from('installed_font')
    .select('family')
    .eq('tenant_id', tenantId)
    .limit(20);
  return {
    name: payload.name,
    primaryColor: payload.primaryColor,
    secondaryColor: payload.secondaryColor || null,
    tagline: payload.tagline || null,
    tone: payload.description || null,
    fonts: Array.isArray(fonts) ? fonts.map((f) => f.family).filter(Boolean) : [],
    buttonStyles: payload.buttonStyles || {},
  };
}

async function updateJob(jobId, tenantId, patch) {
  await supabase
    .from('ai_composition_job')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('tenant_id', tenantId);
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

  // Same permission split as V1: 404 (not 403) so page existence is not leaked.
  if (!(await canUseAiFeature(context, AI_FEATURE_GENERATE))) {
    return res.status(404).json({ error: 'Not found' });
  }

  const tenantId = context.tenantId;
  const body = req.body || {};

  // ---- Load or create the job -------------------------------------------
  let job;
  if (body.jobId) {
    const { data } = await supabase
      .from('ai_composition_job')
      .select('*')
      .eq('id', body.jobId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!data) return res.status(404).json({ error: 'Generation not found' });
    job = data;
    if (job.status === 'complete' || job.status === 'failed') {
      return res.status(200).json({
        jobId: job.id,
        stage: job.stage,
        status: job.status,
        label: STAGE_LABELS[job.stage] || null,
        compositionId: job.composition_id || job.state?.targetCompositionId || null,
        versionId: job.state?.versionId || null,
        error: job.error || null,
      });
    }
  } else {
    const brief = normalizeBrief(body.brief);
    if (!brief) return res.status(400).json({ error: 'A brief is required' });
    const options = normalizeOptions(
      { ...body, mode: 'section' },
      { screenshotPrefix: tenantPublicAssetPrefix(tenantId) },
    );
    options.rendererVersion = 2;

    // ---- Governance gate (shared with V1) --------------------------------
    const studioSettings = await loadStudioSettings(supabase, tenantId);
    const allowance = await checkAiUsageAllowance(supabase, {
      tenantId,
      memberId: context.memberId || null,
      settings: studioSettings,
      operation: 'generation',
      prompt: brief,
      creativity: options.creativity,
    });
    if (!allowance.ok) {
      await recordAiUsageEvent(supabase, {
        tenantId,
        memberId: context.memberId || null,
        pageId: body.pageId || null,
        operation: 'generation',
        units: { promptChars: brief.length },
        status: 'blocked',
        dedupeHash: allowance.dedupeHash,
      });
      return res.status(allowance.status).json(allowance.body);
    }
    options.usageWarning = allowance.warning || null;
    options.dedupeHash = allowance.dedupeHash;

    // Regeneration targets an existing V2 composition — verify ownership AND
    // renderer generation (a V1 scene-graph composition can never be
    // regenerated through the code path).
    let compositionId = null;
    if (body.compositionId) {
      const { data: comp } = await supabase
        .from('ai_composition')
        .select('id, renderer_version')
        .eq('id', body.compositionId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!comp) return res.status(404).json({ error: 'Composition not found' });
      if (comp.renderer_version !== 2) {
        return res.status(400).json({ error: 'This composition was made with the previous AI renderer and cannot be regenerated here.' });
      }
      compositionId = comp.id;
    }

    // In-flight lock: refuse a second concurrent run for the same page scope.
    const { data: running } = await supabase
      .from('ai_composition_job')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('status', 'running')
      .eq('page_id', body.pageId || null)
      .gte('updated_at', new Date(Date.now() - 3 * 60 * 1000).toISOString())
      .limit(1);
    if (Array.isArray(running) && running.length > 0) {
      return res.status(409).json({ error: 'A generation is already running for this page.' });
    }

    const { data: created, error: createErr } = await supabase
      .from('ai_composition_job')
      .insert({
        tenant_id: tenantId,
        page_id: body.pageId || null,
        composition_id: compositionId,
        brief,
        options,
        stage: 'context',
        status: 'running',
        state: {},
        created_by: context.memberId || null,
      })
      .select('*')
      .single();
    if (createErr) return res.status(500).json({ error: 'Failed to start generation' });
    job = created;
  }

  const options = normalizeOptions(job.options || {}, { screenshotPrefix: tenantPublicAssetPrefix(tenantId) });
  options.dedupeHash = job.options?.dedupeHash || null;
  options.usageWarning = job.options?.usageWarning || null;
  const brief = job.brief;
  const state = job.state || {};
  const stage = job.stage;

  const fail = async (err) => {
    await updateJob(job.id, tenantId, {
      status: 'failed',
      error: err.message || 'Generation failed',
    });
    return res.status(err.httpStatus === 502 ? 200 : (err.httpStatus || 500)).json({
      jobId: job.id,
      stage,
      status: 'failed',
      error: err.message || 'Generation failed',
      rejectionReasons: err.rejectionReasons || undefined,
    });
  };

  try {
    if (stage === 'context') {
      const [brand, pageContext, ctxSettings] = await Promise.all([
        buildBrandContext(tenantId),
        buildPageContext(job.page_id, tenantId),
        loadStudioSettings(supabase, tenantId),
      ]);
      const guidance = buildGuidanceSummary(ctxSettings);
      if (brand && guidance) brand.guidance = guidance;
      // The CSS scope is keyed on the composition uuid, so a NEW composition
      // gets its id minted up front; rows are only inserted on success.
      const targetCompositionId = job.composition_id || randomUUID();
      await updateJob(job.id, tenantId, {
        stage: 'code',
        state: { ...state, brand, pageContext, targetCompositionId, isNewComposition: !job.composition_id },
      });
      return res.status(200).json({ jobId: job.id, stage: 'code', status: 'running', label: STAGE_LABELS.code });
    }

    if (stage === 'code') {
      const client = getOpenAIClient();
      if (!client) {
        return fail(Object.assign(new Error('AI generation is not configured on this server.'), { httpStatus: 503 }));
      }
      const callLlm = makeCallLlm(client);

      const attempt = state.codeAttempt || 0;
      const lastErrors = state.codeErrors || [];
      let result;
      try {
        result = await runCodeAttempt({
          callLlm,
          compositionId: state.targetCompositionId,
          brief,
          brand: state.brand,
          options,
          pageContext: state.pageContext,
          attempt,
          lastErrors,
          allowedImageHosts: [], // Phase 1: inline SVG only, no raster imagery
        });
      } catch (err) {
        if (err.providerError) return fail(err);
        throw err;
      }

      if (!result.ok) {
        if (attempt >= MAX_CODE_RETRIES) {
          return fail(Object.assign(
            new Error('The design did not pass our quality checks after several attempts. Try rephrasing your brief or adding more detail.'),
            { rejectionReasons: result.errors.slice(0, 12) },
          ));
        }
        await updateJob(job.id, tenantId, {
          state: { ...state, codeAttempt: attempt + 1, codeErrors: result.errors.slice(0, 12) },
        });
        return res.status(200).json({
          jobId: job.id,
          stage: 'code',
          status: 'running',
          label: 'Refining the design',
          progress: { attempt: attempt + 1, maxAttempts: MAX_CODE_RETRIES + 1 },
        });
      }

      // ---- Persist: composition (renderer_version 2) + immutable version ---
      const compId = state.targetCompositionId;
      if (state.isNewComposition) {
        const { error: compErr } = await supabase.from('ai_composition').insert({
          id: compId,
          tenant_id: tenantId,
          page_id: job.page_id || null,
          name: result.document.title || 'AI section',
          composition_type: 'section',
          status: 'draft',
          renderer_version: 2,
          created_by: context.memberId || null,
        });
        if (compErr) return fail(new Error('Failed to save the composition.'));
      }

      const { data: version, error: verErr } = await supabase
        .from('ai_composition_version')
        .insert({
          composition_id: compId,
          tenant_id: tenantId,
          document: result.document,
          change_summary: state.isNewComposition ? 'Initial generation' : 'Regenerated from brief',
          operation_type: 'generation',
          validation_result: { pipeline: 'aiCodePipeline', ok: true, report: result.report },
          generation_metadata: {
            model: AI_CODE_GENERATION_MODEL,
            rendererVersion: 2,
            attempts: attempt + 1,
            creativity: options.creativity,
            direction: options.direction || null,
            referenceInfluenceLevel: options.styleReference?.influence || null,
            referenceImagesSentCount: result.imagesAttached || 0,
            designDnaIncluded: !!options.styleReference?.designDna,
          },
          created_by: context.memberId || null,
        })
        .select('id')
        .single();
      if (verErr) return fail(new Error('Failed to save the generated version.'));

      await supabase
        .from('ai_composition')
        .update({
          current_version_id: version.id,
          name: result.document.title || 'AI section',
          updated_at: new Date().toISOString(),
        })
        .eq('id', compId)
        .eq('tenant_id', tenantId);

      await recordAiUsageEvent(supabase, {
        tenantId,
        memberId: context.memberId || null,
        pageId: job.page_id || null,
        compositionId: compId,
        operation: 'generation',
        model: AI_CODE_GENERATION_MODEL,
        units: { promptChars: brief.length, textCalls: attempt + 1 },
        dedupeHash: options.dedupeHash,
      });

      await updateJob(job.id, tenantId, {
        status: 'complete',
        composition_id: compId,
        state: { ...state, versionId: version.id },
      });
      return res.status(200).json({
        jobId: job.id,
        stage: 'code',
        status: 'complete',
        compositionId: compId,
        versionId: version.id,
        usageWarning: options.usageWarning || null,
      });
    }

    return fail(new Error(`Unknown generation stage "${stage}".`));
  } catch (err) {
    return fail(err);
  }
}
