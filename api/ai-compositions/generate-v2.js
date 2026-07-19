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
import { resolveCodeActions, makeSupabaseActionLookups } from '../_lib/aiCodeActions.js';
import { resolveCodeSlots, makeSupabaseSlotLookups } from '../_lib/aiCodeSlots.js';
import { storeGeneratedAsset } from '../_lib/aiCompositionAssetStore.js';
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

const STAGE_LABELS = {
  context: 'Reading your brand and page',
  plan: 'Planning the page content',
  code: 'Designing your section',
  validate: 'Checking the design in a real browser',
  repair: 'Fixing issues we found',
};

const MAX_PLAN_RETRIES = 2;

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
    const compositionType = body.compositionType === 'page_body' ? 'page_body' : 'section';
    const options = normalizeOptions(
      { ...body, mode: 'section' },
      { screenshotPrefix: tenantPublicAssetPrefix(tenantId) },
    );
    options.rendererVersion = 2;
    options.compositionType = compositionType;

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
      const nextStage = compositionType === 'page_body' ? 'plan' : 'code';
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
      await updateJob(job.id, tenantId, {
        stage: 'code',
        state: { ...state, plan: parsed.plan, planAttempts: attempt + 1 },
      });
      return res.status(200).json({ jobId: job.id, stage: 'code', status: 'running', label: 'Designing your page' });
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
          compositionType,
          plan: state.plan || null,
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
          },
          created_by: context.memberId || null,
        })
        .select('id')
        .single();
      if (verErr) return fail(new Error('Failed to save the generated version.'));

      await updateJob(job.id, tenantId, {
        stage: 'validate',
        composition_id: compId,
        state: {
          ...state,
          candidateVersionId: version.id,
          candidateVersionIds: [version.id],
          candidateRawCss: result.rawCss || null,
          codeCalls: attempt + 1,
          repairCycle: 0,
          repairCalls: 0,
          validationHistory: [],
        },
      });
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

      const decision = decideValidationOutcome({
        layoutIssues: layout.issues,
        review,
        breakpointsInspected: layout.breakpointsInspected,
        repairCycle: state.repairCycle || 0,
        maxRepairCycles: MAX_REPAIR_CYCLES,
      });

      // Record the full evidence on the candidate version (audit trail) —
      // screenshots use the STORED media-library URLs.
      const phase3 = {
        status: decision.outcome === 'pass'
          ? (decision.skippedValidation || evidence.status === 'skipped' ? 'skipped' : 'passed')
          : decision.outcome === 'repair' ? 'needs_repair' : 'rejected',
        repairCycle: state.repairCycle || 0,
        breakpointsInspected: layout.breakpointsInspected,
        layoutIssues: layout.issues,
        captureErrors: [...(layout.captureErrors || []), ...(evidence.failures || [])],
        review: reviewRecord,
        qualityScore,
        ...(evidence.skipReason ? { skipReason: evidence.skipReason } : {}),
      };
      await supabase
        .from('ai_composition_version')
        .update({
          validation_result: { ...(candidate.validation_result || {}), phase3 },
          generation_metadata: {
            ...(candidate.generation_metadata || {}),
            ...(evidence.screenshots.length ? { screenshots: evidence.screenshots } : {}),
          },
        })
        .eq('id', candidateId)
        .eq('tenant_id', tenantId);

      const history = [...(state.validationHistory || []), {
        repairCycle: state.repairCycle || 0,
        versionId: candidateId,
        outcome: decision.outcome,
        qualityScore,
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
          qualityScore,
          validationStatus: phase3.status,
          repairCycles: state.repairCycle || 0,
          usageWarning: options.usageWarning || null,
        });
      }

      if (decision.outcome === 'repair') {
        await updateJob(job.id, tenantId, {
          stage: 'repair',
          state: {
            ...state,
            validationHistory: history,
            repairEvidence: {
              layoutIssues: layout.issues.slice(0, 24),
              reviewFindings: reviewRecord.status === 'reviewed' ? (reviewRecord.findings || []) : [],
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
