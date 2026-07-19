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
  buildContentPlanPrompt,
  parsePlanResponse,
  runPlanChecks,
} from '../_lib/aiCodeGeneration.js';
import {
  resolveV2AssetRequests,
  collectPendingAssetRequests,
  requiredAssetFailures,
} from '../_lib/aiCodeAssets.js';
import { resolveCodeActions, makeSupabaseActionLookups } from '../_lib/aiCodeActions.js';
import { resolveCodeSlots, makeSupabaseSlotLookups } from '../_lib/aiCodeSlots.js';
import { storeGeneratedAsset } from '../_lib/aiCompositionAssetStore.js';
import { ASPECT_SIZES } from '../_lib/aiCompositionImages.js';
import { styleReferenceImageInputs } from '../_lib/styleReference.js';
import { buildSignedPreviewUrl, appOrigin } from '../_lib/aiCodePreviewSign.js';
import { captureValidationEvidence } from '../_lib/aiCodeVisualValidation.js';
import { inspectCodeLayout, scoreQuality } from '../_lib/aiCodeLayoutInspector.js';
import { runVisualReview } from '../_lib/aiCodeVisualReview.js';
import {
  MAX_REPAIR_CYCLES,
  decideValidationOutcome,
  buildRejectionCleanup,
  runRepairAttempt,
} from '../_lib/aiCodeRepair.js';
import {
  VISUAL_CONCEPT_BREAKPOINTS,
  MAX_VISUAL_REVISIONS,
  VISUAL_SIMILARITY_THRESHOLD,
  MAX_VISUAL_REPAIR_CYCLES,
  normalizeRevisionInstruction,
  buildVisualConceptPrompt,
  buildDeconstructionPrompt,
  parseDeconstructionResponse,
  runSimilarityCompare,
  decideSimilarityOutcome,
  buildVisualWarning,
} from '../_lib/aiDesignFirst.js';

const STAGE_LABELS = {
  context: 'Reading your brand and page',
  plan: 'Planning the page content',
  visual: 'Painting a visual concept',
  deconstruct: 'Turning the approved visual into a build plan',
  code: 'Designing your section',
  assets: 'Creating imagery for your design',
  validate: 'Checking the design in a real browser',
  repair: 'Fixing issues we found',
};

const MAX_PLAN_RETRIES = 2;
// One retry pass over failed asset requests (per-asset isolation inside).
const MAX_ASSET_ATTEMPTS = 2;
// Wall-clock budget per assets invocation — the stage is resumable, so we
// stop starting new provider calls near the limit and resume next call.
const ASSET_STAGE_BUDGET_MS = 45000;

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

/** Provider image call — gpt-image-1 via the shared OpenAI client (as V1). */
function makeGenerateImage(client) {
  return async ({ prompt, aspectRatio }) => {
    let result;
    try {
      result = await client.images.generate({
        model: 'gpt-image-1',
        prompt,
        size: ASPECT_SIZES[aspectRatio] || ASPECT_SIZES.landscape,
        n: 1,
      });
    } catch (err) {
      throw new Error('Image generation failed — the image service was unavailable.');
    }
    const b64 = result?.data?.[0]?.b64_json;
    if (!b64) throw new Error('Image generation returned no image.');
    return { buffer: Buffer.from(b64, 'base64'), model: 'gpt-image-1' };
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
    // Design-first (Phase 6): the job pauses after the visual proposal until
    // the author approves or asks for a revision. Any other poll returns the
    // current proposal + conversation history.
    if (job.status === 'awaiting_visual') {
      const proposal = job.state?.visualProposal || null;
      if (body.visualAction === 'revise') {
        const instruction = normalizeRevisionInstruction(body.instruction);
        if (!instruction) return res.status(400).json({ error: 'Describe the change you want to see in the visual.' });
        const revisions = [...(job.state?.visualRevisions || []), instruction].slice(-MAX_VISUAL_REVISIONS);
        job = { ...job, status: 'running', stage: 'visual', state: { ...(job.state || {}), visualRevisions: revisions } };
        await updateJob(job.id, tenantId, { status: 'running', stage: 'visual', state: job.state });
        return res.status(200).json({ jobId: job.id, stage: 'visual', status: 'running', label: 'Revising the visual concept' });
      }
      if (body.visualAction === 'approve') {
        if (!proposal?.desktopUrl || !proposal?.mobileUrl) {
          return res.status(409).json({ error: 'There is no visual proposal to approve yet.' });
        }
        job = { ...job, status: 'running', stage: 'deconstruct', state: { ...(job.state || {}), approvedVisual: proposal } };
        await updateJob(job.id, tenantId, { status: 'running', stage: 'deconstruct', state: job.state });
        return res.status(200).json({ jobId: job.id, stage: 'deconstruct', status: 'running', label: STAGE_LABELS.deconstruct });
      }
      return res.status(200).json({
        jobId: job.id,
        stage: job.stage,
        status: 'awaiting_visual',
        label: 'Review the visual concept',
        visualProposal: proposal,
        visualRevisions: job.state?.visualRevisions || [],
      });
    }
  } else {
    const brief = normalizeBrief(body.brief);
    if (!brief) return res.status(400).json({ error: 'A brief is required' });
    const compositionType = body.compositionType === 'page_body' ? 'page_body' : 'section';
    const options = normalizeOptions(
      { ...body, mode: 'section' },
      { screenshotPrefix: tenantPublicAssetPrefix(tenantId) },
    );
    options.rendererVersion = 2;
    options.compositionType = compositionType;
    // Phase 6 design-first: opt-in visual-concept-before-build workflow.
    options.designFirst = body.designFirst === true;

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
  // normalizeOptions whitelists keys — re-read the composition type raw.
  const compositionType = job.options?.compositionType === 'page_body' ? 'page_body' : 'section';
  const designFirst = job.options?.designFirst === true;
  const brief = job.brief;
  const state = job.state || {};
  const stage = job.stage;

  // Design-first (Phase 6): similarity alone must NEVER reject. When a
  // similarity-driven repair chain fails technically (or a repaired document
  // regresses functionally), fall back to the last candidate that PASSED
  // functional validation and deliver it with a visual-similarity WARNING.
  // Returns the response, or null when the fallback candidate is unavailable
  // (caller proceeds with its normal rejection).
  const completeWithVisualWarning = async () => {
    const versionId = state.lastFunctionalPassVersionId;
    if (!designFirst || !versionId) return null;
    const compId = state.targetCompositionId;
    const { data: v } = await supabase
      .from('ai_composition_version')
      .select('id, document, validation_result')
      .eq('id', versionId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!v?.document) return null;
    const warning = buildVisualWarning(state.lastFunctionalPassSimilarity);
    const vr = v.validation_result || {};
    await supabase
      .from('ai_composition_version')
      .update({ validation_result: { ...vr, phase3: { ...(vr.phase3 || {}), status: 'passed', visualSimilarity: warning } } })
      .eq('id', versionId)
      .eq('tenant_id', tenantId);
    const defaultName = compositionType === 'page_body' ? 'AI page' : 'AI section';
    await supabase
      .from('ai_composition')
      .update({
        current_version_id: versionId,
        name: v.document.title || defaultName,
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
      units: {
        promptChars: brief.length,
        textCalls: (state.codeCalls || 1) + (state.repairCalls || 0),
      },
      dedupeHash: options.dedupeHash,
    });
    await updateJob(job.id, tenantId, {
      status: 'complete',
      composition_id: compId,
      state: { ...state, versionId },
    });
    return res.status(200).json({
      jobId: job.id,
      stage: 'validate',
      status: 'complete',
      compositionId: compId,
      versionId,
      qualityScore: state.lastFunctionalPassScore || 0,
      validationStatus: 'passed',
      repairCycles: state.repairCycle || 0,
      visualSimilarity: warning,
      usageWarning: options.usageWarning || null,
    });
  };

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
      qualityScore: typeof err.qualityScore === 'number' ? err.qualityScore : undefined,
    });
  };

  // Hard-rejection cleanup: delete ONLY this job's candidate versions and (if
  // the composition was created by this job) the empty shell. The
  // composition's current version — if any — is never touched.
  const rejectCandidates = async ({ tenantId: tid, compId, state: st }) => {
    try {
      const { data: comp } = await supabase
        .from('ai_composition')
        .select('current_version_id')
        .eq('id', compId)
        .eq('tenant_id', tid)
        .maybeSingle();
      const cleanup = buildRejectionCleanup({
        isNewComposition: !!st.isNewComposition,
        candidateVersionIds: st.candidateVersionIds || [],
        currentVersionId: comp?.current_version_id || null,
      });
      if (cleanup.versionIdsToDelete.length) {
        await supabase
          .from('ai_composition_version')
          .delete()
          .in('id', cleanup.versionIdsToDelete)
          .eq('tenant_id', tid);
      }
      if (cleanup.deleteComposition) {
        await supabase
          .from('ai_composition')
          .delete()
          .eq('id', compId)
          .eq('tenant_id', tid)
          .is('current_version_id', null);
      }
    } catch (err) {
      console.error('[generate-v2] rejection cleanup failed (non-fatal):', err.message);
    }
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
      const nextStage = compositionType === 'page_body' ? 'plan' : (designFirst ? 'visual' : 'code');
      await updateJob(job.id, tenantId, {
        stage: nextStage,
        state: { ...state, brand, pageContext, targetCompositionId, isNewComposition: !job.composition_id },
      });
      return res.status(200).json({ jobId: job.id, stage: nextStage, status: 'running', label: STAGE_LABELS[nextStage] });
    }

    // ---- Plan stage (page_body only): content manifest + creative plan ----
    if (stage === 'plan') {
      const client = getOpenAIClient();
      if (!client) {
        return fail(Object.assign(new Error('AI generation is not configured on this server.'), { httpStatus: 503 }));
      }
      const callLlm = makeCallLlm(client);
      const attempt = state.planAttempt || 0;
      const lastErrors = state.planErrors || [];
      const prompt = buildContentPlanPrompt({ brief, brand: state.brand, options, attempt, lastErrors });
      let raw;
      try {
        raw = await callLlm({ system: prompt.system, user: prompt.user, maxTokens: 4000 });
      } catch (err) {
        if (err.providerError) return fail(err);
        throw err;
      }
      const parsed = parsePlanResponse(raw);
      const checks = parsed.ok ? runPlanChecks(parsed.plan) : parsed;
      if (!parsed.ok || !checks.ok) {
        const errors = (parsed.ok ? checks.errors : parsed.errors).slice(0, 8);
        if (attempt >= MAX_PLAN_RETRIES) {
          return fail(Object.assign(
            new Error('We could not build a solid content plan for this page. Try adding more detail to your brief.'),
            { rejectionReasons: errors },
          ));
        }
        await updateJob(job.id, tenantId, {
          state: { ...state, planAttempt: attempt + 1, planErrors: errors },
        });
        return res.status(200).json({
          jobId: job.id,
          stage: 'plan',
          status: 'running',
          label: 'Rethinking the page plan',
          progress: { attempt: attempt + 1, maxAttempts: MAX_PLAN_RETRIES + 1 },
        });
      }
      const afterPlan = designFirst ? 'visual' : 'code';
      await updateJob(job.id, tenantId, {
        stage: afterPlan,
        state: { ...state, plan: parsed.plan, planAttempts: attempt + 1 },
      });
      return res.status(200).json({
        jobId: job.id,
        stage: afterPlan,
        status: 'running',
        label: afterPlan === 'visual' ? STAGE_LABELS.visual : 'Designing your page',
      });
    }

    // ---- Visual proposal stage (Phase 6, design-first only) ----------------
    // gpt-image-1 paints a desktop + mobile concept from the brief, brand,
    // content plan and revision history; the images are stored as job
    // artefacts (tenant media library) and the job pauses for approval.
    if (stage === 'visual') {
      const client = getOpenAIClient();
      if (!client) {
        return fail(Object.assign(new Error('AI image generation is not configured on this server.'), { httpStatus: 503 }));
      }
      const generateImage = makeGenerateImage(client);
      const revisions = state.visualRevisions || [];
      const round = (state.visualRound || 0) + 1;
      const urls = {};
      for (const { breakpoint, aspectRatio } of VISUAL_CONCEPT_BREAKPOINTS) {
        const prompt = buildVisualConceptPrompt({
          brief, brand: state.brand, plan: state.plan || null, options, breakpoint, revisions,
        });
        let img;
        try {
          img = await generateImage({ prompt, aspectRatio });
        } catch {
          return fail(Object.assign(
            new Error('The visual concept could not be created — the image service was unavailable. Please try again.'),
            { httpStatus: 502 },
          ));
        }
        const stored = await storeGeneratedAsset({
          tenantId,
          memberId: context.memberId || null,
          compositionId: state.targetCompositionId,
          elementId: `visual-concept-${breakpoint}-r${round}`,
          buffer: img.buffer,
          prompt,
          model: img.model,
          provider: 'openai',
          aspectRatio,
          usageStatus: 'in_use',
        });
        if (!stored?.url) return fail(new Error('The visual concept image could not be stored.'));
        urls[breakpoint] = stored.url;
      }
      const visualProposal = {
        desktopUrl: urls.desktop,
        mobileUrl: urls.mobile,
        round,
        createdAt: new Date().toISOString(),
      };
      const history = [...(state.visualProposalHistory || []), visualProposal].slice(-6);
      await updateJob(job.id, tenantId, {
        status: 'awaiting_visual',
        stage: 'visual',
        state: {
          ...state,
          visualProposal,
          visualProposalHistory: history,
          visualRound: round,
          visualRevisions: revisions,
        },
      });
      return res.status(200).json({
        jobId: job.id,
        stage: 'visual',
        status: 'awaiting_visual',
        label: 'Review the visual concept',
        visualProposal,
        visualRevisions: revisions,
      });
    }

    // ---- Deconstruction stage (Phase 6): approved visual → layout intent ---
    // The approved visual is authoritative ONLY for layout/style intent; the
    // sanitizer strips all wording/link carriers so copy, facts, actions and
    // slots keep coming exclusively from the structured manifests.
    if (stage === 'deconstruct') {
      const client = getOpenAIClient();
      if (!client) {
        return fail(Object.assign(new Error('AI generation is not configured on this server.'), { httpStatus: 503 }));
      }
      const approved = state.approvedVisual || state.visualProposal;
      if (!approved?.desktopUrl || !approved?.mobileUrl) {
        return fail(new Error('The approved visual could not be loaded.'));
      }
      const callLlm = makeCallLlm(client);
      const prompt = buildDeconstructionPrompt({ plan: state.plan || null });
      let raw;
      try {
        raw = await callLlm({
          system: prompt.system,
          user: prompt.user,
          images: [
            { url: approved.desktopUrl, detail: 'high' },
            { url: approved.mobileUrl, detail: 'high' },
          ],
          maxTokens: 4000,
        });
      } catch (err) {
        if (err.providerError) return fail(err);
        throw err;
      }
      const parsed = parseDeconstructionResponse(raw);
      if (!parsed.ok) {
        const attempt = (state.deconstructAttempt || 0) + 1;
        if (attempt > 1) {
          // Deconstruction is an accelerator, not a gate: fall back to the
          // normal code path with the concept images as the only visual guide.
          await updateJob(job.id, tenantId, {
            stage: 'code',
            state: { ...state, approvedVisual: approved, designBlueprint: null, deconstructSkipped: true },
          });
          return res.status(200).json({ jobId: job.id, stage: 'code', status: 'running', label: STAGE_LABELS.code });
        }
        await updateJob(job.id, tenantId, { state: { ...state, deconstructAttempt: attempt } });
        return res.status(200).json({
          jobId: job.id,
          stage: 'deconstruct',
          status: 'running',
          label: STAGE_LABELS.deconstruct,
          progress: { attempt: attempt + 1, maxAttempts: 2 },
        });
      }
      await updateJob(job.id, tenantId, {
        stage: 'code',
        state: { ...state, approvedVisual: approved, designBlueprint: parsed.blueprint },
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
          // Phase 5: fulfilled asset srcs live under the tenant's public
          // media-library prefix — the only host generated markup may use.
          allowedImageHosts: [tenantPublicAssetPrefix(tenantId)].filter(Boolean),
          compositionType,
          plan: state.plan || null,
          // Design-first (Phase 6): approved-visual blueprint + concept
          // images guide layout/style; manifests remain the content contract.
          designBlueprint: state.designBlueprint || null,
          conceptImages: state.approvedVisual
            ? [
                { url: state.approvedVisual.desktopUrl, label: 'approved desktop concept' },
                { url: state.approvedVisual.mobileUrl, label: 'approved mobile concept' },
              ]
            : [],
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

      // ---- Resolve actions (hints → real records) and slots BEFORE persist —
      // the stored document carries server-built hrefs / sourceIds; the client
      // never builds internal URLs itself. Unresolved actions stay flagged and
      // are surfaced in the editor + blocked at publish time.
      let documentToStore = result.document;
      try {
        const actions = await resolveCodeActions(
          result.document.actions,
          makeSupabaseActionLookups(supabase, tenantId),
        );
        const slots = await resolveCodeSlots(
          result.document.slots,
          makeSupabaseSlotLookups(supabase, tenantId),
        );
        documentToStore = { ...result.document, actions, slots };
      } catch {
        // Resolution is best-effort at generation time: a lookup failure
        // leaves actions unresolved (still publishable-gated), never fails
        // the whole generation.
      }

      // ---- Persist a CANDIDATE version (Phase 3) ---------------------------
      // The composition shell (for a new composition) and the version row are
      // written now so the CSP-locked preview can render it for validation —
      // but current_version_id is NOT touched until validation passes. A
      // failed generation can therefore never replace a valid current
      // version.
      const compId = state.targetCompositionId;
      const defaultName = compositionType === 'page_body' ? 'AI page' : 'AI section';
      if (state.isNewComposition) {
        const { error: compErr } = await supabase.from('ai_composition').insert({
          id: compId,
          tenant_id: tenantId,
          page_id: job.page_id || null,
          name: documentToStore.title || defaultName,
          composition_type: compositionType,
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
          document: documentToStore,
          change_summary: state.isNewComposition ? 'Initial generation' : 'Regenerated from brief',
          operation_type: 'generation',
          validation_result: {
            pipeline: 'aiCodePipeline',
            ok: true,
            report: result.report,
            phase3: { status: 'pending' },
          },
          generation_metadata: {
            model: AI_CODE_GENERATION_MODEL,
            rendererVersion: 2,
            compositionType,
            attempts: attempt + 1,
            planAttempts: state.planAttempts || 0,
            ...(state.plan ? { plan: state.plan } : {}),
            creativity: options.creativity,
            direction: options.direction || null,
            referenceInfluenceLevel: options.styleReference?.influence || null,
            referenceImagesSentCount: result.imagesAttached || 0,
            designDnaIncluded: !!options.styleReference?.designDna,
            // Final-attempt reconciliation warning: these data-ai-action keys
            // were used in the HTML but not declared by the model; they were
            // auto-declared as unresolved anchor actions.
            ...(result.autoDeclaredActionKeys?.length
              ? { warnings: [`Auto-declared undeclared action key(s): ${result.autoDeclaredActionKeys.join(', ')}`], autoDeclaredActionKeys: result.autoDeclaredActionKeys }
              : {}),
          },
          created_by: context.memberId || null,
        })
        .select('id')
        .single();
      if (verErr) return fail(new Error('Failed to save the generated version.'));

      // Image asset requests (Phase 5) are fulfilled in their own resumable
      // stage BEFORE validation, so the browser screenshots judge the design
      // with its real imagery in place.
      const hasAssetRequests = collectPendingAssetRequests(documentToStore).length > 0;
      const nextStage = hasAssetRequests ? 'assets' : 'validate';
      await updateJob(job.id, tenantId, {
        stage: nextStage,
        composition_id: compId,
        state: {
          ...state,
          candidateVersionId: version.id,
          candidateVersionIds: [version.id],
          candidateRawCss: result.rawCss || null,
          codeCalls: attempt + 1,
          assetAttempt: 0,
          repairCycle: 0,
          repairCalls: 0,
          validationHistory: [],
        },
      });
      return res.status(200).json({
        jobId: job.id,
        stage: nextStage,
        status: 'running',
        label: STAGE_LABELS[nextStage],
      });
    }

    // ---- Assets stage: fulfil image_request entries (Phase 5) --------------
    // Library-first when the request names an existing image, otherwise
    // gpt-image-1 → storeGeneratedAsset (file_repository + ai_generated_asset,
    // tenant-owned). Per-asset failure isolation: failed requests keep their
    // brief, one retry pass; only REQUIRED failures hard-reject.
    if (stage === 'assets') {
      const compId = state.targetCompositionId;
      const candidateId = state.candidateVersionId;
      const { data: candidate } = await supabase
        .from('ai_composition_version')
        .select('id, document, generation_metadata')
        .eq('id', candidateId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!candidate?.document) return fail(new Error('The generated version could not be loaded for imagery.'));

      // Library-first fulfilment must not depend on the image provider being
      // configured: only requests that actually need GENERATION require the
      // client. Missing provider surfaces as a per-asset failure (retryable,
      // and hard-rejecting only when the request is required).
      const client = getOpenAIClient();
      const generateImage = client
        ? makeGenerateImage(client)
        : async () => { throw new Error('AI image generation is not configured on this server.'); };

      const searchLibrary = async ({ query }) => {
        const q = String(query || '').trim();
        if (!q) return null;
        const { data: rows } = await supabase
          .from('file_repository')
          .select('id, file_url')
          .eq('tenant_id', tenantId)
          .eq('file_type', 'image')
          .or(`file_name.ilike.%${q.replace(/[%,()]/g, ' ')}%,description.ilike.%${q.replace(/[%,()]/g, ' ')}%`)
          .limit(1);
        const hit = rows?.[0];
        return hit?.file_url ? { fileRepositoryId: hit.id, url: hit.file_url } : null;
      };

      const resolved = await resolveV2AssetRequests({
        doc: candidate.document,
        brand: state.brand,
        generateImage,
        storeAsset: async ({ buffer, request, prompt, model, cost, aspectRatio }) => storeGeneratedAsset({
          tenantId,
          memberId: context.memberId || null,
          compositionId: compId,
          elementId: request.key,
          buffer,
          prompt,
          model,
          provider: 'openai',
          aspectRatio,
          brief: { ...request, accessibilityDescription: request.alt },
          usageStatus: 'in_use',
          cost,
        }),
        searchLibrary,
        deadline: Date.now() + ASSET_STAGE_BUDGET_MS,
      });

      // Persist the (partially) fulfilled document + per-version provenance.
      const priorResults = candidate.generation_metadata?.assetResults || [];
      const assetResults = [
        ...priorResults.filter((r) => !resolved.results.some((n) => n.key === r.key)),
        ...resolved.results,
      ];
      await supabase
        .from('ai_composition_version')
        .update({
          document: resolved.doc,
          generation_metadata: { ...(candidate.generation_metadata || {}), assetResults },
        })
        .eq('id', candidateId)
        .eq('tenant_id', tenantId);

      // Deadline hit with work left — resume in the next invocation.
      if (resolved.remaining > 0) {
        await updateJob(job.id, tenantId, { state: { ...state } });
        return res.status(200).json({
          jobId: job.id,
          stage: 'assets',
          status: 'running',
          label: STAGE_LABELS.assets,
          progress: { assetsRemaining: resolved.remaining },
        });
      }

      const stillPending = collectPendingAssetRequests(resolved.doc);
      if (stillPending.length) {
        const attemptNo = (state.assetAttempt || 0) + 1;
        if (attemptNo < MAX_ASSET_ATTEMPTS) {
          // Failed requests kept their brief — retry pass.
          await updateJob(job.id, tenantId, { state: { ...state, assetAttempt: attemptNo } });
          return res.status(200).json({
            jobId: job.id,
            stage: 'assets',
            status: 'running',
            label: 'Retrying imagery that failed',
            progress: { assetAttempt: attemptNo + 1, maxAttempts: MAX_ASSET_ATTEMPTS },
          });
        }
        const requiredFailed = requiredAssetFailures(resolved.doc.assets);
        if (requiredFailed.length) {
          await rejectCandidates({ tenantId, compId, state });
          return fail(Object.assign(
            new Error('A required image could not be created after retries. Nothing was changed — please try again.'),
            { rejectionReasons: requiredFailed.map((a) => `Image "${a.key}" (${a.subject}) failed: ${a.fulfilment?.error || 'unknown error'}`).slice(0, 12) },
          ));
        }
        // Optional failures: proceed — placeholders have no src and simply
        // don't render; the failed request keeps its brief for later retry.
      }

      await updateJob(job.id, tenantId, { stage: 'validate', state: { ...state } });
      return res.status(200).json({
        jobId: job.id,
        stage: 'validate',
        status: 'running',
        label: STAGE_LABELS.validate,
      });
    }

    // ---- Validate stage: screenshots + geometry + AI review ----------------
    if (stage === 'validate') {
      const compId = state.targetCompositionId;
      const candidateId = state.candidateVersionId;
      const { data: candidate } = await supabase
        .from('ai_composition_version')
        .select('id, document, validation_result, generation_metadata')
        .eq('id', candidateId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!candidate?.document) return fail(new Error('The generated version could not be loaded for validation.'));
      const doc = candidate.document;

      const previewUrl = buildSignedPreviewUrl(appOrigin(req), compId, candidateId);
      const shotBuffers = new Map();
      const evidence = await captureValidationEvidence({
        previewUrl,
        responsiveTargets: doc.responsiveTargets,
        storeShot: async ({ buffer, breakpoint, width }) => {
          const stored = await storeGeneratedAsset({
            tenantId,
            memberId: context.memberId || null,
            compositionId: compId,
            buffer,
            prompt: `Phase 3 validation screenshot (${breakpoint} ${width}px, cycle ${state.repairCycle || 0})`,
            provider: 'browserless',
            model: 'screenshot',
            usageStatus: 'in_use',
          });
          shotBuffers.set(breakpoint, buffer);
          return stored;
        },
      });

      // Deterministic browser-geometry checks.
      const layout = inspectCodeLayout(evidence.metricsCaptures, { document: doc });

      // AI visual review — advisory unless a finding is blocking; skipped is
      // never blocking. Same-invocation buffers ride along as data URLs so
      // the vision call does not depend on media-library URL reachability.
      const client = getOpenAIClient();
      const review = await runVisualReview({
        callVision: client ? makeCallLlm(client) : null,
        screenshots: evidence.screenshots.map((s) => ({
          ...s,
          url: shotBuffers.has(s.breakpoint)
            ? `data:image/jpeg;base64,${shotBuffers.get(s.breakpoint).toString('base64')}`
            : s.url,
        })),
        // The customer's style-reference screenshots ride along as labelled
        // reference evidence so the reviewer judges the render against the
        // requested direction, not just in isolation.
        referenceImages: styleReferenceImageInputs(options.styleReference),
        brief,
        brand: state.brand,
        plan: state.plan || null,
      });
      const reviewRecord = review.status === 'reviewed'
        ? { status: 'reviewed', ...review.review }
        : { status: 'skipped', skipReason: review.skipReason };

      const qualityScore = scoreQuality({
        layoutIssues: layout.issues,
        review: review.status === 'reviewed' ? review.review : null,
      });

      let decision = decideValidationOutcome({
        layoutIssues: layout.issues,
        review,
        breakpointsInspected: layout.breakpointsInspected,
        repairCycle: state.repairCycle || 0,
        maxRepairCycles: MAX_REPAIR_CYCLES,
      });

      // ---- Design-first similarity gate (Phase 6) --------------------------
      // Only a build that already PASSED functional validation is compared
      // against the approved visual. Below threshold → bounded repair cycles;
      // budget exhausted → deliver with a WARNING (similarity alone never
      // rejects); skipped compare never blocks.
      let visualSimilarity = null;
      let similarityReasons = [];
      if (decision.outcome === 'pass' && designFirst && state.approvedVisual) {
        const compare = await runSimilarityCompare({
          callVision: client ? makeCallLlm(client) : null,
          renderedShots: evidence.screenshots.map((s) => ({
            breakpoint: s.breakpoint,
            url: shotBuffers.has(s.breakpoint)
              ? `data:image/jpeg;base64,${shotBuffers.get(s.breakpoint).toString('base64')}`
              : s.url,
          })),
          conceptImages: {
            desktop: state.approvedVisual.desktopUrl,
            mobile: state.approvedVisual.mobileUrl,
          },
        });
        const simDecision = decideSimilarityOutcome({
          status: compare.status,
          similarity: compare.similarity || 0,
          differences: compare.differences || [],
          repairCycle: state.visualRepairCycle || 0,
          maxRepairCycles: MAX_VISUAL_REPAIR_CYCLES,
        });
        visualSimilarity = compare.status === 'compared'
          ? {
              status: simDecision.outcome === 'pass' ? 'met'
                : simDecision.outcome === 'warn' ? 'warning' : 'below_threshold',
              similarity: compare.similarity,
              threshold: VISUAL_SIMILARITY_THRESHOLD,
              differences: compare.differences || [],
              repairCycle: state.visualRepairCycle || 0,
            }
          : { status: 'skipped', skipReason: compare.skipReason, threshold: VISUAL_SIMILARITY_THRESHOLD };
        if (simDecision.outcome === 'repair') {
          similarityReasons = simDecision.reasons;
          decision = { outcome: 'repair', reasons: simDecision.reasons };
        }
      }

      // Record the full evidence on the candidate version (audit trail) —
      // screenshots use the STORED media-library URLs.
      const validationSkipped = decision.outcome === 'pass'
        && (decision.skippedValidation || evidence.status === 'skipped');
      // A skipped validation must never masquerade as a perfect score: when
      // nothing was inspected the score is unknown (null), and the skip is
      // surfaced as an explicit warning on the version metadata and in the
      // completion response so the editor can show it.
      const reportedQualityScore = validationSkipped ? null : qualityScore;
      const validationWarning = validationSkipped
        ? `Visual quality checks were skipped (${evidence.skipReason || 'no breakpoints could be inspected'}) — this design has NOT been visually verified.`
        : null;
      const phase3 = {
        status: decision.outcome === 'pass'
          ? (validationSkipped ? 'skipped' : 'passed')
          : decision.outcome === 'repair' ? 'needs_repair' : 'rejected',
        repairCycle: state.repairCycle || 0,
        breakpointsInspected: layout.breakpointsInspected,
        layoutIssues: layout.issues,
        captureErrors: [...(layout.captureErrors || []), ...(evidence.failures || [])],
        review: reviewRecord,
        qualityScore: reportedQualityScore,
        ...(visualSimilarity ? { visualSimilarity } : {}),
        ...(evidence.skipReason ? { skipReason: evidence.skipReason } : {}),
      };
      await supabase
        .from('ai_composition_version')
        .update({
          validation_result: { ...(candidate.validation_result || {}), phase3 },
          generation_metadata: {
            ...(candidate.generation_metadata || {}),
            ...(evidence.screenshots.length ? { screenshots: evidence.screenshots } : {}),
            ...(validationWarning
              ? {
                  warnings: [
                    ...((candidate.generation_metadata || {}).warnings || []).filter((w) => w?.kind !== 'validation_skipped'),
                    { kind: 'validation_skipped', message: validationWarning },
                  ],
                }
              : {}),
          },
        })
        .eq('id', candidateId)
        .eq('tenant_id', tenantId);

      const history = [...(state.validationHistory || []), {
        repairCycle: state.repairCycle || 0,
        versionId: candidateId,
        outcome: decision.outcome,
        qualityScore: reportedQualityScore,
        blockingReasons: decision.reasons.slice(0, 12),
        screenshots: evidence.screenshots.map((s) => ({ breakpoint: s.breakpoint, url: s.url })),
        reviewStatus: reviewRecord.status,
      }];

      if (decision.outcome === 'pass') {
        // Promote — this is the ONLY place current_version_id changes.
        const defaultName = compositionType === 'page_body' ? 'AI page' : 'AI section';
        await supabase
          .from('ai_composition')
          .update({
            current_version_id: candidateId,
            name: doc.title || defaultName,
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
          units: {
            promptChars: brief.length,
            textCalls: (state.codeCalls || 1) + (state.repairCalls || 0)
              + (reviewRecord.status === 'reviewed' ? history.length : 0),
          },
          dedupeHash: options.dedupeHash,
        });

        await updateJob(job.id, tenantId, {
          status: 'complete',
          composition_id: compId,
          state: { ...state, versionId: candidateId, validationHistory: history },
        });
        return res.status(200).json({
          jobId: job.id,
          stage: 'validate',
          status: 'complete',
          compositionId: compId,
          versionId: candidateId,
          qualityScore: reportedQualityScore,
          validationStatus: phase3.status,
          ...(validationWarning ? { validationWarning } : {}),
          repairCycles: state.repairCycle || 0,
          ...(visualSimilarity ? { visualSimilarity } : {}),
          usageWarning: options.usageWarning || null,
        });
      }

      if (decision.outcome === 'repair') {
        await updateJob(job.id, tenantId, {
          stage: 'repair',
          state: {
            ...state,
            validationHistory: history,
            // Similarity-driven repairs consume their OWN bounded budget, and
            // remember the functionally-valid candidate + its similarity so
            // any later technical failure falls back to it with a WARNING
            // instead of rejecting (similarity alone never rejects).
            ...(similarityReasons.length
              ? {
                  visualRepairCycle: (state.visualRepairCycle || 0) + 1,
                  lastFunctionalPassVersionId: candidateId,
                  lastFunctionalPassScore: qualityScore,
                  lastFunctionalPassSimilarity: visualSimilarity,
                }
              : {}),
            repairEvidence: {
              layoutIssues: layout.issues.slice(0, 24),
              reviewFindings: [
                ...(reviewRecord.status === 'reviewed' ? (reviewRecord.findings || []) : []),
                ...similarityReasons.map((message) => ({
                  breakpoint: 'all',
                  severity: 'blocking',
                  message: `${message} (divergence from the customer-approved visual concept)`,
                })),
              ],
              screenshots: evidence.screenshots.map((s) => ({ breakpoint: s.breakpoint, width: s.width, url: s.url })),
            },
          },
        });
        return res.status(200).json({
          jobId: job.id,
          stage: 'repair',
          status: 'running',
          label: STAGE_LABELS.repair,
          progress: { repairCycle: (state.repairCycle || 0) + 1, maxRepairCycles: MAX_REPAIR_CYCLES },
        });
      }

      // ---- Hard rejection: remove only OUR candidates, never the current ---
      // Design-first: if a functionally-valid candidate exists (the rejection
      // stems from a similarity-driven repair chain), deliver it with a
      // WARNING instead — similarity alone never rejects.
      const fallback = await completeWithVisualWarning();
      if (fallback) return fallback;
      await rejectCandidates({ tenantId, compId, state });
      await updateJob(job.id, tenantId, { state: { ...state, validationHistory: history } });
      return fail(Object.assign(
        new Error('The design did not pass visual validation after automated repairs. Nothing was changed — try rephrasing your brief.'),
        { rejectionReasons: decision.reasons.slice(0, 12), qualityScore },
      ));
    }

    // ---- Repair stage: one LLM repair attempt per invocation ---------------
    if (stage === 'repair') {
      const client = getOpenAIClient();
      if (!client) {
        await rejectCandidates({ tenantId, compId: state.targetCompositionId, state });
        return fail(Object.assign(new Error('AI generation is not configured on this server.'), { httpStatus: 503 }));
      }
      const compId = state.targetCompositionId;
      const { data: candidate } = await supabase
        .from('ai_composition_version')
        .select('id, document')
        .eq('id', state.candidateVersionId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!candidate?.document) return fail(new Error('The version to repair could not be loaded.'));

      const cycle = state.repairCycle || 0;
      const ev = state.repairEvidence || {};
      let repaired;
      try {
        repaired = await runRepairAttempt({
          callLlm: makeCallLlm(client),
          compositionId: compId,
          document: candidate.document,
          rawCss: state.candidateRawCss || null,
          brief,
          brand: state.brand,
          options,
          plan: state.plan || null,
          layoutIssues: ev.layoutIssues || [],
          reviewFindings: ev.reviewFindings || [],
          screenshots: ev.screenshots || [],
          repairCycle: cycle,
          maxRepairCycles: MAX_REPAIR_CYCLES,
          previousRepairErrors: state.repairErrors || [],
          // Fulfilled asset srcs (tenant media library) must survive the
          // repair re-run of the sanitising pipeline.
          allowedImageHosts: [tenantPublicAssetPrefix(tenantId)].filter(Boolean),
        });
      } catch (err) {
        if (err.providerError) return fail(err);
        throw err;
      }

      if (!repaired.ok) {
        // The repair itself failed the safety pipeline/gates — that consumes
        // a repair cycle. Retry with the errors if budget remains, else
        // reject (leaving any existing current version untouched).
        if (cycle + 1 >= MAX_REPAIR_CYCLES) {
          // Design-first: a similarity-driven repair chain that fails
          // technically must not discard the functionally-valid build —
          // deliver it with a WARNING instead.
          const fallback = await completeWithVisualWarning();
          if (fallback) return fallback;
          const lastScore = (state.validationHistory || []).slice(-1)[0]?.qualityScore ?? 0;
          await rejectCandidates({ tenantId, compId, state });
          return fail(Object.assign(
            new Error('The design did not pass visual validation after automated repairs. Nothing was changed — try rephrasing your brief.'),
            { rejectionReasons: repaired.errors.slice(0, 12), qualityScore: lastScore },
          ));
        }
        await updateJob(job.id, tenantId, {
          state: {
            ...state,
            repairCycle: cycle + 1,
            repairCalls: (state.repairCalls || 0) + 1,
            repairErrors: repaired.errors.slice(0, 12),
          },
        });
        return res.status(200).json({
          jobId: job.id,
          stage: 'repair',
          status: 'running',
          label: STAGE_LABELS.repair,
          progress: { repairCycle: cycle + 2, maxRepairCycles: MAX_REPAIR_CYCLES },
        });
      }

      // Re-resolve actions/slots on the repaired document (same best-effort
      // policy as generation).
      let documentToStore = repaired.document;
      try {
        const actions = await resolveCodeActions(
          repaired.document.actions,
          makeSupabaseActionLookups(supabase, tenantId),
        );
        const slots = await resolveCodeSlots(
          repaired.document.slots,
          makeSupabaseSlotLookups(supabase, tenantId),
        );
        documentToStore = { ...repaired.document, actions, slots };
      } catch {}

      const { data: repairedVersion, error: repErr } = await supabase
        .from('ai_composition_version')
        .insert({
          composition_id: compId,
          tenant_id: tenantId,
          parent_version_id: state.candidateVersionId,
          document: documentToStore,
          change_summary: `Automated repair (cycle ${cycle + 1})`,
          operation_type: 'repair',
          validation_result: {
            pipeline: 'aiCodePipeline',
            ok: true,
            report: repaired.report,
            phase3: { status: 'pending', repairCycle: cycle + 1 },
          },
          generation_metadata: {
            model: AI_CODE_GENERATION_MODEL,
            rendererVersion: 2,
            compositionType,
            repairCycle: cycle + 1,
            repairedFrom: state.candidateVersionId,
            repairEvidence: {
              layoutIssueCount: (ev.layoutIssues || []).length,
              reviewFindingCount: (ev.reviewFindings || []).length,
              beforeScreenshots: ev.screenshots || [],
            },
          },
          created_by: context.memberId || null,
        })
        .select('id')
        .single();
      if (repErr) return fail(new Error('Failed to save the repaired version.'));

      await updateJob(job.id, tenantId, {
        stage: 'validate',
        state: {
          ...state,
          candidateVersionId: repairedVersion.id,
          candidateVersionIds: [...(state.candidateVersionIds || []), repairedVersion.id],
          candidateRawCss: repaired.rawCss || null,
          repairCycle: cycle + 1,
          repairCalls: (state.repairCalls || 0) + 1,
          repairErrors: [],
        },
      });
      return res.status(200).json({
        jobId: job.id,
        stage: 'validate',
        status: 'running',
        label: 'Re-checking the repaired design',
        progress: { repairCycle: cycle + 1, maxRepairCycles: MAX_REPAIR_CYCLES },
      });
    }

    return fail(new Error(`Unknown generation stage "${stage}".`));
  } catch (err) {
    return fail(err);
  }
}
