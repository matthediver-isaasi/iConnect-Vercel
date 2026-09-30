// AI Composition generation — staged, resumable endpoint (Task #2849).
//
// POST /api/ai-compositions/generate
//   body (start):    { pageId, brief, mode?, direction?, creativity?, compositionId? }
//   body (advance):  { jobId }
//
// Each invocation advances the job ONE stage (context → plan → copy →
// document → assets) and returns { jobId, stage, status, label,
// compositionId?, versionId?, error?, progress? }. The client loops until
// status is 'complete' or 'failed'. Stage state persists on the job row so
// each call stays well inside the serverless time budget (Task #2866):
//   - document: ONE LLM attempt per invocation (retry state on the job),
//   - assets: a wall-clock-budgeted chunk of images per invocation with a
//     resume cursor (already-stored images are never regenerated).
// Any failure leaves the page and any existing composition untouched.

import OpenAI from 'openai';
import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { canUseAiFeature, AI_FEATURE_GENERATE, filterBriefsByPolicy } from '../_lib/aiStudioAccess.js';
import { buildTenantBrandingPayload } from '../_lib/tenantBranding.js';
import {
  GENERATION_STAGES,
  STAGE_LABELS,
  normalizeBrief,
  normalizeOptions,
  resolveCompositionType,
  runPlanStage,
  runCopyStage,
  runDocumentAttempt,
  documentExhaustedError,
  MAX_DOCUMENT_RETRIES,
  assertAssetOwnership,
  sanitizePlan,
  reconcilePlaceholderRecords,
  findFirstImageUrl,
} from '../_lib/aiCompositionPipeline.js';
import {
  collectImageBriefs,
  walkElements,
  collectAltTextFlags,
  resolveCompositionAssets,
  ASPECT_SIZES,
} from '../_lib/aiCompositionImages.js';
import { storeGeneratedAsset, tenantPublicAssetPrefix } from '../_lib/aiCompositionAssetStore.js';
import { loadStudioSettings, buildGuidanceSummary } from '../_lib/aiDesignStudioSettings.js';
import { checkAiUsageAllowance, recordAiUsageEvent } from '../_lib/aiUsage.js';
import { runCompositionValidation } from '../_lib/aiCompositionValidation.js';
import { styleReferenceImageInputs, isDesignDnaV2 } from '../_lib/styleReference.js';
import { AI_COMPOSITION_SCHEMA_VERSION } from '../_lib/aiCompositionSchema.js';
import { runScreenshotReview } from '../_lib/aiCompositionScreenshotGate.js';

/**
 * Reference-evidence diagnostics stored on the version (Task #2890).
 * Never includes signed URLs, base64 data or credentials — screenshot
 * identity is the storage-path portion of the public URL.
 */
function buildReferenceDiagnostics(styleReference, state) {
  if (!styleReference) return undefined;
  const inputs = styleReferenceImageInputs(styleReference);
  const assetPath = (url) => {
    try {
      const p = new URL(url).pathname;
      const i = p.indexOf('/public-assets/');
      return i >= 0 ? p.slice(i + '/public-assets/'.length) : p;
    } catch { return null; }
  };
  const dna = styleReference.designDna || null;
  // Capture-stage: everything stored on the reference; generation-stage: the
  // curated subset actually attached to the OpenAI request.
  const captured = Array.isArray(styleReference.screenshots) ? styleReference.screenshots : [];
  return {
    referenceAnalysisId: styleReference.analysisId || null,
    referenceInfluenceLevel: styleReference.influence || null,
    designDnaIncluded: !!dna,
    designDnaSchemaVersion: dna ? (isDesignDnaV2(dna) ? dna.schemaVersion || '2.0' : 'v1') : null,
    referenceScreenshotCount: inputs.length,
    referenceScreenshotLabels: inputs.map((i) => i.label),
    referenceScreenshotViewports: inputs.map((i) => i.viewport),
    referenceScreenshotDetails: inputs.map((i) => i.detail),
    // Screenshots are storage objects (no DB asset rows) — their identity is
    // the storage-path portion of the public URL, never a signed URL.
    referenceScreenshotAssetIds: inputs.map((i) => assetPath(i.url)).filter(Boolean),
    captureScreenshotCount: captured.length,
    captureScreenshotLabels: captured.map((s, i) => s.label || `screenshot ${i + 1}`),
    captureScreenshotAssetIds: captured.map((s) => assetPath(s.url)).filter(Boolean),
    referenceImagesIncludedInOpenAIRequest: (state?.referenceImagesSent || 0) > 0,
    referenceImagesSentCount: state?.referenceImagesSent || 0,
    openAIModel: 'gpt-4o-mini',
  };
}

/** Provider image call — gpt-image-1 via the shared OpenAI client. */
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

function getOpenAIClient() {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (!apiKey) return null;
  return new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
}

// Vision caller for the screenshot quality review stage (Task #2894) —
// same shape as review.js's makeCallVision.
function makeCallVision(client) {
  return async ({ system, user, images }) => {
    const content = [{ type: 'text', text: user }];
    for (const img of images || []) {
      content.push({ type: 'text', text: `Screenshot (${img.breakpoint}):` });
      content.push({ type: 'image_url', image_url: { url: img.dataUrl, detail: 'low' } });
    }
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_completion_tokens: 2000,
    });
    return completion.choices?.[0]?.message?.content || '';
  };
}

function makeCallLlm(client) {
  return async ({ system, user, maxTokens, images }) => {
    // Style-reference screenshots ride along as vision inputs (Task #2873).
    // Text-only calls keep the plain string content exactly as before.
    // Images may be curated inputs ({ url, detail }) or bare URL strings
    // (back-compat). Curated crops ride at their requested detail level so
    // the model can actually study the reference design (Task #2890).
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
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.4,
        max_completion_tokens: maxTokens || 4000,
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

// Structured surrounding-page context: block types + visible text, never raw
// design internals. Strictly the requesting tenant's page.
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

// Verify the author's pinned records against the tenant's own data (Phase 5).
// Only records that exist AND belong to the tenant survive into the prompts;
// verified rows also pick up authoritative titles/slugs/details.
const RECORD_VERIFIERS = {
  page: { table: 'i_edit_page', select: 'id, title, slug', map: (r) => ({ title: r.title || r.slug, slug: r.slug }) },
  event_registration: { table: 'event', select: 'id, title, start_date', map: (r) => ({ title: r.title, detail: r.start_date ? `Event on ${String(r.start_date).slice(0, 10)}` : 'Event' }) },
  form: { table: 'form', select: 'id, name, slug', map: (r) => ({ title: r.name, slug: r.slug || null }) },
  document: { table: 'file_repository', select: 'id, file_name', map: (r) => ({ title: r.file_name }) },
  membership_application: { table: 'membership_tier_config', select: 'id, name', map: (r) => ({ title: r.name }) },
};

async function verifyBriefRecords(records, tenantId) {
  const out = [];
  for (const rec of records || []) {
    const v = RECORD_VERIFIERS[rec.kind];
    if (!v) continue;
    const { data } = await supabase
      .from(v.table)
      .select(v.select)
      .eq('id', rec.id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!data) continue;
    out.push({ kind: rec.kind, id: rec.id, slug: rec.slug || null, ...v.map(data) });
  }
  return out;
}

async function updateJob(jobId, tenantId, patch) {
  await supabase
    .from('ai_composition_job')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('tenant_id', tenantId);
}

// Wall-clock budget for one assets-stage invocation: stop starting new
// images past this point so persistence + response fit inside Vercel's
// function limit even at 60s (see task #2866 / serverless time-budget rule).
const ASSETS_CHUNK_BUDGET_MS = 35 * 1000;

export default async function handler(req, res) {
  const invocationStart = Date.now();
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

  // Permission split (spec §29): generation requires the ai-generate key on
  // top of page-editor. 404 (not 403) so page existence is not leaked.
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
        compositionId: job.composition_id || null,
        versionId: job.state?.versionId || null,
        error: job.error || null,
      });
    }
    // Plan review (Phase 5): the job pauses after planning until the author
    // approves (optionally with an edited plan). Any other poll just returns
    // the current plan snapshot.
    if (job.status === 'awaiting_plan') {
      if (body.approvePlan === true) {
        const edited = body.plan !== undefined
          ? sanitizePlan(body.plan, { records: (job.state || {}).records || [] })
          : sanitizePlan(job.state?.plan, { records: (job.state || {}).records || [] });
        if (!edited) return res.status(400).json({ error: 'The edited plan has no usable sections' });
        job = {
          ...job,
          status: 'running',
          stage: 'copy',
          state: { ...(job.state || {}), plan: edited },
        };
        await updateJob(job.id, tenantId, { status: 'running', stage: 'copy', state: job.state });
        return res.status(200).json({ jobId: job.id, stage: 'copy', status: 'running', label: STAGE_LABELS.copy });
      }
      return res.status(200).json({
        jobId: job.id,
        stage: job.stage,
        status: 'awaiting_plan',
        label: 'Review the page plan',
        plan: job.state?.plan || null,
      });
    }
  } else {
    const brief = normalizeBrief(body.brief);
    if (!brief) return res.status(400).json({ error: 'A brief is required' });
    const options = normalizeOptions(body, { screenshotPrefix: tenantPublicAssetPrefix(tenantId) });

    // ---- Governance gate (Phase 4, spec §27/§28) --------------------------
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
    // Regeneration targets an existing composition — verify ownership.
    let compositionId = null;
    if (body.compositionId) {
      const { data: comp } = await supabase
        .from('ai_composition')
        .select('id')
        .eq('id', body.compositionId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!comp) return res.status(404).json({ error: 'Composition not found' });
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
      validationErrors: err.validationErrors || undefined,
    });
  };

  try {
    if (stage === 'context') {
      const [brand, pageContext, ctxSettings] = await Promise.all([
        buildBrandContext(tenantId),
        buildPageContext(job.page_id, tenantId),
        loadStudioSettings(supabase, tenantId),
      ]);
      // Admin-configured brand guidance rides along with the brand context so
      // every downstream prompt stage sees it (spec §28).
      const guidance = buildGuidanceSummary(ctxSettings);
      if (brand && guidance) brand.guidance = guidance;
      const compositionType = resolveCompositionType(options.mode, pageContext);
      // Phase 5: verify pinned records against the tenant's own data before
      // any prompt sees them.
      const records = options.records.length
        ? await verifyBriefRecords(options.records, tenantId)
        : [];
      await updateJob(job.id, tenantId, {
        stage: 'plan',
        state: { ...state, brand, pageContext, compositionType, records },
      });
      return res.status(200).json({ jobId: job.id, stage: 'plan', status: 'running', label: STAGE_LABELS.plan });
    }

    const client = getOpenAIClient();
    if (!client) {
      return fail(Object.assign(new Error('AI generation is not configured on this server.'), { httpStatus: 503 }));
    }
    const callLlm = makeCallLlm(client);

    if (stage === 'plan') {
      // Prompts only ever see SERVER-VERIFIED records (state.records), never
      // the raw client-supplied list.
      const rawPlan = await runPlanStage({
        callLlm, brief,
        options: { ...options, records: state.records || [] },
        brand: state.brand, pageContext: state.pageContext,
        compositionType: state.compositionType,
      });
      // Sanitize BEFORE persisting so the contract the quality gates enforce
      // is always the bounded one (e.g. requiredAssets capped at the imagery
      // budget) — not just on the plan-review resume path (Task #2900).
      const plan = sanitizePlan(rawPlan, { records: state.records || [] });
      // Phase 5 plan review: pause here and hand the plan to the author.
      if (options.reviewPlan) {
        await updateJob(job.id, tenantId, {
          status: 'awaiting_plan',
          stage: 'plan',
          state: { ...state, plan },
        });
        return res.status(200).json({
          jobId: job.id,
          stage: 'plan',
          status: 'awaiting_plan',
          label: 'Review the page plan',
          plan,
        });
      }
      await updateJob(job.id, tenantId, { stage: 'copy', state: { ...state, plan } });
      return res.status(200).json({ jobId: job.id, stage: 'copy', status: 'running', label: STAGE_LABELS.copy });
    }

    if (stage === 'copy') {
      const copy = await runCopyStage({
        callLlm, brief, plan: state.plan, brand: state.brand,
        generateSeo: options.generateSeo,
      });
      await updateJob(job.id, tenantId, { stage: 'document', state: { ...state, copy } });
      return res.status(200).json({ jobId: job.id, stage: 'document', status: 'running', label: STAGE_LABELS.document });
    }

    if (stage === 'document') {
      // ONE LLM attempt per invocation (Vercel 60s budget). Validation
      // failures persist { documentAttempt, documentErrors } on the job and
      // return `running` so the client re-invokes for the next attempt.
      const attemptIndex = state.documentAttempt || 0;
      const attemptResult = await runDocumentAttempt({
        callLlm,
        plan: state.plan,
        copy: state.copy,
        brand: state.brand,
        compositionType: state.compositionType,
        brief,
        styleReference: options.styleReference || null,
        // Document prompts/links only ever see SERVER-VERIFIED records
        // (state.records), never the raw client-supplied list (Task #2900).
        options: { ...options, records: state.records || [] },
        attempt: attemptIndex,
        lastErrors: state.documentErrors || [],
      });
      if (!attemptResult.ok) {
        if (attemptIndex >= MAX_DOCUMENT_RETRIES) {
          throw documentExhaustedError(attemptResult.errors);
        }
        await updateJob(job.id, tenantId, {
          stage: 'document',
          state: {
            ...state,
            documentAttempt: attemptIndex + 1,
            documentErrors: attemptResult.errors,
          },
        });
        return res.status(200).json({
          jobId: job.id,
          stage: 'document',
          status: 'running',
          label: STAGE_LABELS.document,
          progress: { attempt: attemptIndex + 2, maxAttempts: MAX_DOCUMENT_RETRIES + 1 },
        });
      }
      const doc = attemptResult.doc;
      const attempts = attemptIndex + 1;
      // Phase 5: placeholders may only reference server-verified records.
      reconcilePlaceholderRecords(doc, state.records || []);
      // Asset ownership guard: the model may never reference existing files
      // (only imageBriefs), so any resolved id must belong to this tenant.
      await assertAssetOwnership(doc, tenantId, async (fileId) => {
        const { data } = await supabase
          .from('file_repository')
          .select('tenant_id')
          .eq('id', fileId)
          .maybeSingle();
        return data?.tenant_id || null;
      });

      // Hand the validated document to the assets stage (persistence happens
      // there so a mid-imagery timeout can resume without re-running the LLM).
      const nextState = {
        ...state, doc, attempts,
        // Diagnostics (Task #2890): how many reference images actually rode
        // along on the successful document request.
        referenceImagesSent: attemptResult.imagesAttached || 0,
      };
      delete nextState.documentAttempt;
      delete nextState.documentErrors;
      await updateJob(job.id, tenantId, {
        stage: 'assets',
        state: nextState,
      });
      return res.status(200).json({ jobId: job.id, stage: 'assets', status: 'running', label: STAGE_LABELS.assets });
    }

    if (stage === 'assets') {
      const baseDoc = state.doc;
      if (!baseDoc) throw new Error('Generation state was lost — please start again.');
      const attempts = state.attempts || 1;

      // Generate outstanding imagery with PER-ASSET failure isolation: a
      // failed image flags that one element and the run continues (spec §30).
      let doc = baseDoc;
      let assetResults = [];
      const assetSettings = await loadStudioSettings(supabase, tenantId);
      // Governance (spec §28): when illustration is disallowed, strip
      // generated_illustration briefs so the assets stage never draws them.
      if (assetSettings.allowGeneratedIllustration === false) {
        doc = JSON.parse(JSON.stringify(baseDoc));
        walkElements(doc, (el) => {
          if (el.type === 'generated_illustration' && el.imageBrief) delete el.imageBrief;
        });
      }
      // Results carried over from earlier chunked invocations of this stage.
      const priorResults = Array.isArray(state.assetResults) ? state.assetResults : [];
      const pendingBriefs = filterBriefsByPolicy(collectImageBriefs(doc), assetSettings);
      if (pendingBriefs.length > 0 && assetSettings.allowImageGeneration !== false) {
        const resolved = await resolveCompositionAssets({
          doc,
          brand: state.brand,
          generateImage: makeGenerateImage(client),
          // Wall-clock budget: stop STARTING new images once ~35s of this
          // invocation is spent; progress persists and the client re-invokes.
          deadline: invocationStart + ASSETS_CHUNK_BUDGET_MS,
          storeAsset: (args) => storeGeneratedAsset({
            tenantId,
            memberId: context.memberId || null,
            compositionId: job.composition_id || null,
            elementId: args.elementId,
            buffer: args.buffer,
            prompt: args.prompt,
            model: args.model,
            aspectRatio: args.aspectRatio,
            brief: args.brief,
            cost: args.cost,
          }),
        });
        doc = resolved.doc;
        // Merge with earlier chunks; a retried element replaces its old entry.
        const retriedIds = new Set(resolved.results.map((r) => r.elementId));
        assetResults = priorResults
          .filter((r) => !retriedIds.has(r.elementId))
          .concat(resolved.results);
        if (resolved.remaining > 0) {
          // Budget exhausted with images left: persist the partially-resolved
          // doc + results (updated_at heartbeat keeps the job non-stale) and
          // hand back `running` so the client drives the next chunk. Already
          // stored images carry a fileRepositoryId, so collectImageBriefs
          // skips them on resume — no duplicates, no double metering.
          await updateJob(job.id, tenantId, {
            stage: 'assets',
            state: { ...state, doc, assetResults },
          });
          return res.status(200).json({
            jobId: job.id,
            stage: 'assets',
            status: 'running',
            label: STAGE_LABELS.assets,
            progress: {
              imagesDone: assetResults.length,
              imagesTotal: assetResults.length + resolved.remaining,
            },
          });
        }
      } else {
        assetResults = priorResults;
      }
      // Alt-text workflow: record flags on the document, never block the run.
      const altFlags = collectAltTextFlags(doc);
      doc.accessibility = { ...(doc.accessibility || {}), imageFlags: altFlags };
      doc.generatedAssets = assetResults
        .filter((r) => r.ok)
        .map((r) => ({ elementId: r.elementId, fileRepositoryId: r.fileRepositoryId }));

      // Render-time validation (Phase 4): all breakpoints, stored on the
      // version. Critical a11y failures never discard the run — they gate
      // approval/insertion downstream instead.
      const validation = runCompositionValidation(doc);

      // Persist: composition row (create or reuse) + immutable version.
      let compositionId = job.composition_id;
      if (!compositionId) {
        const { data: comp, error: compErr } = await supabase
          .from('ai_composition')
          .insert({
            tenant_id: tenantId,
            page_id: job.page_id || null,
            name: doc.name || 'AI Composition',
            composition_type: doc.compositionType,
            status: 'draft',
            created_by: context.memberId || null,
          })
          .select('id')
          .single();
        if (compErr) throw new Error('Failed to save the composition');
        compositionId = comp.id;
      }
      const { data: parent } = await supabase
        .from('ai_composition')
        .select('current_version_id')
        .eq('id', compositionId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      // Phase 5: page-level SEO suggestion. The og:image suggestion is the
      // first generated image in the document (tenant-owned asset) — the
      // client applies all of it to i_edit_page only with author consent.
      let seoSuggestion;
      if (state.copy?.seo) {
        const ogImageUrl = findFirstImageUrl(doc);
        seoSuggestion = { ...state.copy.seo, ...(ogImageUrl ? { ogImageUrl } : {}) };
      }
      const { data: version, error: verErr } = await supabase
        .from('ai_composition_version')
        .insert({
          composition_id: compositionId,
          tenant_id: tenantId,
          parent_version_id: parent?.current_version_id || null,
          document: doc,
          change_summary: job.composition_id ? 'Regenerated from brief' : 'Initial generation',
          operation_type: 'generation',
          validation_result: { ...validation, attempts },
          generation_metadata: {
            model: 'gpt-4o-mini',
            imageModel: assetResults.length ? 'gpt-image-1' : undefined,
            creativity: options.creativity,
            mode: options.mode,
            attempts,
            compositionSchemaVersion: AI_COMPOSITION_SCHEMA_VERSION,
            // Style reference (Task #2873): stored for audit/regeneration.
            styleReference: options.styleReference || undefined,
            // Reference-evidence diagnostics (Task #2890): what actually
            // reached the model, auditable per generation.
            reference: buildReferenceDiagnostics(options.styleReference, state),
            // Phase 5: page-level SEO suggestion (applied to i_edit_page by
            // the client with the author's consent — never silently).
            seo: seoSuggestion,
            assetResults: assetResults.length
              ? assetResults.map((r) => ({ elementId: r.elementId, ok: r.ok, error: r.error }))
              : undefined,
          },
          created_by: context.memberId || null,
        })
        .select('id')
        .single();
      if (verErr) throw new Error('Failed to save the composition version');

      await supabase
        .from('ai_composition')
        .update({
          current_version_id: version.id,
          name: doc.name || 'AI Composition',
          composition_type: doc.compositionType,
          updated_at: new Date().toISOString(),
        })
        .eq('id', compositionId)
        .eq('tenant_id', tenantId);

      // Usage/audit event (Phase 4): one per completed generation run —
      // recorded here (the version now exists); the review stage never
      // meters again.
      await recordAiUsageEvent(supabase, {
        tenantId,
        memberId: context.memberId || null,
        pageId: job.page_id || null,
        compositionId,
        operation: 'generation',
        model: 'gpt-4o-mini',
        units: {
          textCalls: 2 + attempts, // plan + copy + document attempt(s)
          images: assetResults.filter((r) => r.ok).length,
          promptChars: (brief || '').length,
        },
        dedupeHash: job.options?.dedupeHash || null,
      });

      // Hand off to the screenshot quality review stage (Task #2894). The
      // heavy doc is dropped; only the completion payload rides along.
      const completion = {
        compositionId,
        versionId: version.id,
        assetResults: assetResults.map((r) => ({ elementId: r.elementId, ok: r.ok, error: r.error || undefined })),
        imageFlags: altFlags,
        seo: seoSuggestion,
        validation: { ok: validation.ok, critical: validation.critical.length, warnings: validation.warnings.length },
      };
      await updateJob(job.id, tenantId, {
        stage: 'review',
        composition_id: compositionId,
        state: { versionId: version.id, completion, brand: state.brand, hasReference: Boolean(options.styleReference) },
      });
      return res.status(200).json({ jobId: job.id, stage: 'review', status: 'running', label: STAGE_LABELS.review });
    }

    if (stage === 'review') {
      // Screenshot quality review (Task #2894): render the saved version at
      // each breakpoint via browserless, judge with the vision model, store
      // the verdict on validation_result.gates.screenshotReview. A failing
      // review NEVER fails the run — it blocks Insert client-side. When the
      // tooling is unconfigured the gate records `skipped` and blocks nothing.
      const versionId = state.versionId;
      const completion = state.completion || {};
      let reviewResult = { status: 'skipped', reason: 'version unavailable', checkedAt: new Date().toISOString() };
      if (versionId) {
        const { data: versionRow } = await supabase
          .from('ai_composition_version')
          .select('id, document, validation_result')
          .eq('id', versionId)
          .eq('tenant_id', tenantId)
          .maybeSingle();
        if (versionRow?.document) {
          reviewResult = await runScreenshotReview({
            doc: versionRow.document,
            brand: state.brand || null,
            hasReference: Boolean(state.hasReference),
            callVision: client ? makeCallVision(client) : null,
          });
          await supabase
            .from('ai_composition_version')
            .update({
              validation_result: {
                ...(versionRow.validation_result || {}),
                gates: {
                  ...(versionRow.validation_result?.gates || {}),
                  screenshotReview: reviewResult,
                },
              },
            })
            .eq('id', versionId)
            .eq('tenant_id', tenantId);
        }
      }
      await updateJob(job.id, tenantId, {
        status: 'complete',
        state: { versionId },
      });
      return res.status(200).json({
        jobId: job.id,
        stage: 'review',
        status: 'complete',
        ...completion,
        screenshotReview: {
          status: reviewResult.status,
          failedBreakpoints: reviewResult.failedBreakpoints || [],
          reason: reviewResult.reason || undefined,
        },
        usageWarning: job.options?.usageWarning || undefined,
      });
    }

    return res.status(400).json({ error: `Unknown stage "${stage}"` });
  } catch (err) {
    return fail(err);
  }
}
