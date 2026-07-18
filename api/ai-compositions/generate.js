// AI Composition generation — staged, resumable endpoint (Task #2849).
//
// POST /api/ai-compositions/generate
//   body (start):    { pageId, brief, mode?, direction?, creativity?, compositionId? }
//   body (advance):  { jobId }
//
// Each invocation advances the job ONE stage (context → plan → copy →
// document) and returns { jobId, stage, status, label, compositionId?,
// versionId?, error? }. The client loops until status is 'complete' or
// 'failed'. Stage state persists on the job row so each call stays well
// inside the serverless time budget. Any failure leaves the page and any
// existing composition untouched.

import OpenAI from 'openai';
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';
import { buildTenantBrandingPayload } from '../_lib/tenantBranding.js';
import {
  GENERATION_STAGES,
  STAGE_LABELS,
  normalizeBrief,
  normalizeOptions,
  resolveCompositionType,
  runPlanStage,
  runCopyStage,
  runDocumentStage,
  assertAssetOwnership,
} from '../_lib/aiCompositionPipeline.js';

function getOpenAIClient() {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (!apiKey) return null;
  return new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
}

function makeCallLlm(client) {
  return async ({ system, user, maxTokens }) => {
    let completion;
    try {
      completion = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
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

  // Editors only. 404 (not 403) so page/composition existence is not leaked.
  let canEdit = !!context.tenantUserId;
  if (!canEdit && context.roleId) {
    canEdit = await hasFeatureAccess(context.roleId, 'site-builder.page-editor');
  }
  if (!canEdit) return res.status(404).json({ error: 'Not found' });

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
  } else {
    const brief = normalizeBrief(body.brief);
    if (!brief) return res.status(400).json({ error: 'A brief is required' });
    const options = normalizeOptions(body);
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

  const options = normalizeOptions(job.options || {});
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
      const [brand, pageContext] = await Promise.all([
        buildBrandContext(tenantId),
        buildPageContext(job.page_id, tenantId),
      ]);
      const compositionType = resolveCompositionType(options.mode, pageContext);
      await updateJob(job.id, tenantId, {
        stage: 'plan',
        state: { ...state, brand, pageContext, compositionType },
      });
      return res.status(200).json({ jobId: job.id, stage: 'plan', status: 'running', label: STAGE_LABELS.plan });
    }

    const client = getOpenAIClient();
    if (!client) {
      return fail(Object.assign(new Error('AI generation is not configured on this server.'), { httpStatus: 503 }));
    }
    const callLlm = makeCallLlm(client);

    if (stage === 'plan') {
      const plan = await runPlanStage({
        callLlm, brief, options,
        brand: state.brand, pageContext: state.pageContext,
        compositionType: state.compositionType,
      });
      await updateJob(job.id, tenantId, { stage: 'copy', state: { ...state, plan } });
      return res.status(200).json({ jobId: job.id, stage: 'copy', status: 'running', label: STAGE_LABELS.copy });
    }

    if (stage === 'copy') {
      const copy = await runCopyStage({ callLlm, brief, plan: state.plan, brand: state.brand });
      await updateJob(job.id, tenantId, { stage: 'document', state: { ...state, copy } });
      return res.status(200).json({ jobId: job.id, stage: 'document', status: 'running', label: STAGE_LABELS.document });
    }

    if (stage === 'document') {
      const { doc, attempts } = await runDocumentStage({
        callLlm,
        plan: state.plan,
        copy: state.copy,
        brand: state.brand,
        compositionType: state.compositionType,
        brief,
      });
      // Asset ownership guard (Phase 1 docs normally reference no assets).
      await assertAssetOwnership(doc, tenantId, async (fileId) => {
        const { data } = await supabase
          .from('file_repository')
          .select('tenant_id')
          .eq('id', fileId)
          .maybeSingle();
        return data?.tenant_id || null;
      });

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
      const { data: version, error: verErr } = await supabase
        .from('ai_composition_version')
        .insert({
          composition_id: compositionId,
          tenant_id: tenantId,
          parent_version_id: parent?.current_version_id || null,
          document: doc,
          change_summary: job.composition_id ? 'Regenerated from brief' : 'Initial generation',
          operation_type: 'generation',
          validation_result: { ok: true, attempts },
          generation_metadata: {
            model: 'gpt-4o-mini',
            creativity: options.creativity,
            mode: options.mode,
            attempts,
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

      await updateJob(job.id, tenantId, {
        status: 'complete',
        composition_id: compositionId,
        state: { ...state, versionId: version.id },
      });
      return res.status(200).json({
        jobId: job.id,
        stage: 'document',
        status: 'complete',
        compositionId,
        versionId: version.id,
      });
    }

    return res.status(400).json({ error: `Unknown stage "${stage}"` });
  } catch (err) {
    return fail(err);
  }
}
