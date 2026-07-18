// Style Reference capture & structured Design DNA analysis (Task #2879,
// upgrading Task #2873).
//
// Staged flow (each stage fits a serverless invocation budget):
//   POST { action: 'start', sourceType: 'page'|'url', pageId?, url?, refresh? }
//     → validates the target (SSRF checks), looks up a cached complete
//       analysis (tenant + normalised URL + capture/analyser versions,
//       not expired) and either returns it ({ cached: true, analysis }) or
//       creates a new row → { analysisId, viewports: ['desktop', ...] }.
//   POST { action: 'capture', analysisId, viewport }
//     → runs the browserless capture bundle for ONE viewport (settle,
//       lazy-load scroll, animation freeze, labelled full-page + region
//       crops, DOM/computed-CSS extractor), stores screenshots in tenant
//       storage (quota metered) and merges the evidence into the row.
//   POST { action: 'analyze', analysisId }
//     → runs the strict structured-output Design DNA analysis over the
//       stored screenshots + extracted metrics, applies the quality gate
//       and persists design_dna/quality/status.
//   POST { action: 'analyze', screenshots: [...] }  (legacy/upload path)
//     → creates an upload-sourced analysis row from tenant-owned screenshot
//       URLs and analyses them (no extractor evidence).
//   POST { action: 'get'|'delete', analysisId } / { action: 'list' }
//     → reuse / debug / management. 'get' with debug=true returns the debug
//       payload (admin visibility, spec §18).
//
// Screenshot URLs accepted for analysis MUST live under the calling
// tenant's own public-assets prefix. Gated by the ai-generate feature key;
// every row is tenant-scoped.

import OpenAI from 'openai';
import crypto from 'node:crypto';
import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { canUseAiFeature, AI_FEATURE_GENERATE } from '../_lib/aiStudioAccess.js';
import { checkStorageQuota } from '../_lib/planQuota.js';
import { addTenantStorageBytes } from '../_lib/tenantStorageUsage.js';
import { getTenantBaseUrl } from '../_lib/campaignService.js';
import {
  validateReferenceUrl,
  assertPublicUrlTarget,
  normalizeReferenceUrlForCache,
  MAX_REFERENCE_SCREENSHOTS,
} from '../_lib/styleReference.js';
import {
  CAPTURE_VERSION,
  CAPTURE_VIEWPORTS,
  captureViewportBundle,
  isBrowserlessConfigured,
} from '../_lib/styleReferenceCapture.js';
import {
  ANALYSER_VERSION,
  ANALYSIS_MODEL,
  DESIGN_DNA_SCHEMA_VERSION,
  DESIGN_DNA_JSON_SCHEMA,
  buildDesignDnaAnalysisPrompt,
  buildAnalysisImageInputs,
  normalizeDesignDnaV2,
  runDesignDnaQualityGate,
  selectGenerationCrops,
  QUALITY_GATE_USER_MESSAGE,
} from '../_lib/designDna.js';
import { tenantPublicAssetPrefix } from '../_lib/aiCompositionAssetStore.js';

const BUCKET = 'public-assets';
const CACHE_TTL_DAYS = 30;
const VIEWPORT_ORDER = CAPTURE_VIEWPORTS.map((v) => v.name);

function getOpenAIClient() {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (!apiKey) return null;
  return new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
}

// Client-facing projection of an analysis row (never exposes tokens/keys).
function publicAnalysis(row, { includeDebug = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    sourceUrl: row.source_url,
    sourceType: row.source_type,
    status: row.status,
    schemaVersion: row.schema_version,
    captureVersion: row.capture_version,
    analyserVersion: row.analyser_version,
    screenshots: Array.isArray(row.screenshots) ? row.screenshots : [],
    designDna: row.design_dna || null,
    qualityScore: row.quality_score != null ? Number(row.quality_score) : null,
    qualityWarnings: row.quality_warnings || [],
    generationCrops: selectGenerationCrops(row.screenshots || [], MAX_REFERENCE_SCREENSHOTS),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    error: row.error || null,
  };
  if (includeDebug) {
    out.debug = {
      ...(row.debug || {}),
      finalUrl: row.final_url,
      normalizedUrl: row.normalized_url,
      model: row.model,
      tokenUsage: row.token_usage || null,
      estimatedCost: row.estimated_cost != null ? Number(row.estimated_cost) : null,
      contentHash: row.content_hash,
      extractedMetricsSummary: summarizeMetrics(row.extracted_metrics),
    };
  }
  return out;
}

function summarizeMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  const out = {};
  for (const [vp, m] of Object.entries(metrics)) {
    if (!m || typeof m !== 'object') continue;
    out[vp] = {
      typographySignatures: (m.typography || []).length,
      colours: (m.colours || []).length,
      spacingScale: m.spacing?.scalePx || [],
      surfaces: (m.surfaces || []).length,
      componentFamilies: (m.componentFamilies || []).length,
      sections: (m.sections || []).length,
      images: (m.images || []).length,
      svgs: (m.svgs || []).length,
      pageHeight: m.page?.pageHeight || null,
      truncated: !!m.page?.truncated,
      extractError: m.extractError || null,
    };
  }
  return Object.keys(out).length ? out : null;
}

async function fetchAnalysisRow(tenantId, analysisId) {
  if (!analysisId || !/^[0-9a-f-]{36}$/i.test(String(analysisId))) return null;
  const { data } = await supabase
    .from('ai_style_reference_analysis')
    .select('*')
    .eq('id', analysisId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  return data || null;
}

async function resolveCaptureUrl(body, tenantId) {
  if (body.sourceType === 'page') {
    const pageId = String(body.pageId || '').trim();
    if (!pageId) return { error: 'Pick a page to use as the reference.', status: 400 };
    const { data: page } = await supabase
      .from('i_edit_page')
      .select('id, slug, status, layout_type, microsite_id')
      .eq('id', pageId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!page) return { error: 'Page not found.', status: 404 };
    if (page.status !== 'published') {
      return { error: 'Only published pages can be captured — publish the page first or upload screenshots instead.', status: 400 };
    }
    if (page.microsite_id || !['public', 'hybrid'].includes(page.layout_type)) {
      return { error: 'That page is not publicly viewable at its own address — upload screenshots of it instead.', status: 400 };
    }
    const { data: tenant } = await supabase
      .from('tenant')
      .select('slug')
      .eq('id', tenantId)
      .maybeSingle();
    if (!tenant?.slug) return { error: 'Could not resolve your site address.', status: 500 };
    return { url: `${getTenantBaseUrl(tenant.slug)}/${page.slug}` };
  }
  if (body.sourceType === 'url') {
    const check = validateReferenceUrl(body.url);
    if (!check.ok) return { error: check.error, status: 400 };
    const resolved = await assertPublicUrlTarget(check.url);
    if (!resolved.ok) return { error: resolved.error, status: 400 };
    return { url: check.url };
  }
  return { error: 'Unsupported reference source.', status: 400 };
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function handleStart(body, context, res) {
  if (!isBrowserlessConfigured()) {
    return res.status(503).json({ error: 'Screenshot capture is not configured on this server. You can upload screenshots instead.' });
  }
  const tenantId = context.tenantId;
  const resolved = await resolveCaptureUrl(body, tenantId);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

  const normalizedUrl = normalizeReferenceUrlForCache(resolved.url);

  // Cache lookup (spec §15) unless the caller asked for a refresh.
  if (!body.refresh && normalizedUrl) {
    const { data: cached } = await supabase
      .from('ai_style_reference_analysis')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('normalized_url', normalizedUrl)
      .eq('capture_version', CAPTURE_VERSION)
      .eq('analyser_version', ANALYSER_VERSION)
      .eq('status', 'complete')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cached) {
      supabase
        .from('ai_style_reference_analysis')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', cached.id)
        .then(() => {}, () => {});
      return res.status(200).json({ cached: true, analysis: publicAnalysis(cached) });
    }
  }

  const expires = new Date(Date.now() + CACHE_TTL_DAYS * 24 * 3600 * 1000).toISOString();
  const { data: row, error } = await supabase
    .from('ai_style_reference_analysis')
    .insert({
      tenant_id: tenantId,
      source_url: resolved.url,
      normalized_url: normalizedUrl,
      source_type: body.sourceType,
      status: 'capturing',
      capture_version: CAPTURE_VERSION,
      analyser_version: ANALYSER_VERSION,
      schema_version: DESIGN_DNA_SCHEMA_VERSION,
      created_by: context.memberId || null,
      expires_at: expires,
      debug: { requestedUrl: resolved.url, startedAt: new Date().toISOString(), viewports: [] },
    })
    .select('*')
    .single();
  if (error || !row) {
    console.error('[style-reference] failed to create analysis row:', error?.message);
    return res.status(500).json({ error: 'Could not start the reference analysis.' });
  }
  return res.status(200).json({ analysisId: row.id, viewports: VIEWPORT_ORDER });
}

// ---------------------------------------------------------------------------
// capture (one viewport)
// ---------------------------------------------------------------------------

async function handleCaptureViewport(body, context, res) {
  const tenantId = context.tenantId;
  const row = await fetchAnalysisRow(tenantId, body.analysisId);
  if (!row) return res.status(404).json({ error: 'Analysis not found.' });
  if (row.status !== 'capturing') return res.status(409).json({ error: 'This analysis is not in a capturable state.' });
  const viewport = String(body.viewport || '');
  if (!VIEWPORT_ORDER.includes(viewport)) return res.status(400).json({ error: 'Unknown viewport.' });

  let bundle;
  const startedAt = Date.now();
  try {
    bundle = await captureViewportBundle(row.source_url, viewport);
  } catch (err) {
    // Desktop failing is fatal; tablet/mobile failures degrade gracefully.
    if (viewport === 'desktop') {
      await supabase
        .from('ai_style_reference_analysis')
        .update({ status: 'failed', error: err.message, updated_at: new Date().toISOString() })
        .eq('id', row.id);
      return res.status(502).json({ error: err.message });
    }
    const debug = { ...(row.debug || {}) };
    debug.viewports = [...(debug.viewports || []), { viewport, ok: false, error: String(err.message).slice(0, 200) }];
    await supabase
      .from('ai_style_reference_analysis')
      .update({ debug, updated_at: new Date().toISOString() })
      .eq('id', row.id);
    return res.status(200).json({ viewport, ok: false, warning: err.message });
  }

  // Redirect revalidation (spec §17): re-run the public-target check on the
  // FINAL post-redirect URL; reject captures that landed somewhere private.
  if (bundle.finalUrl && bundle.finalUrl !== row.source_url) {
    const finalCheck = validateReferenceUrl(bundle.finalUrl);
    const finalPublic = finalCheck.ok ? await assertPublicUrlTarget(finalCheck.url) : { ok: false };
    if (!finalCheck.ok || !finalPublic.ok) {
      await supabase
        .from('ai_style_reference_analysis')
        .update({ status: 'failed', error: 'The reference page redirected to an address that cannot be analysed.', updated_at: new Date().toISOString() })
        .eq('id', row.id);
      return res.status(400).json({ error: 'The reference page redirected to an address that cannot be analysed.' });
    }
  }

  const totalBytes = bundle.screenshots.reduce((n, s) => n + s.buffer.length, 0);
  const quota = await checkStorageQuota(tenantId, { fileSizeBytes: totalBytes });
  if (!quota.ok) return res.status(quota.status || 402).json(quota.body || { error: 'Storage quota exceeded' });

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stored = [];
  let storedBytes = 0;
  for (const shot of bundle.screenshots) {
    const path = `${tenantId}/style-refs/${row.id}/${stamp}-${shot.label}.jpg`;
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, shot.buffer, { contentType: 'image/jpeg', upsert: false });
    if (upErr) {
      console.error('[style-reference] upload failed:', upErr.message);
      continue;
    }
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
    if (pub?.publicUrl) {
      stored.push({ viewport, label: shot.label, url: pub.publicUrl, width: shot.width, height: shot.height });
      storedBytes += shot.buffer.length;
    }
  }
  if (storedBytes > 0) addTenantStorageBytes(tenantId, storedBytes).catch(() => {});
  if (stored.length === 0) {
    return res.status(502).json({ error: 'The screenshots could not be stored — please try again.' });
  }

  const metrics = { ...(row.extracted_metrics || {}) };
  if (bundle.metrics) metrics[viewport] = bundle.metrics;
  const contentHash = viewport === 'desktop' && bundle.metrics
    ? crypto.createHash('sha256').update(JSON.stringify({
      t: bundle.metrics.page?.title,
      h: bundle.metrics.page?.pageHeight,
      typo: (bundle.metrics.typography || []).slice(0, 10),
      cols: (bundle.metrics.colours || []).slice(0, 10),
    })).digest('hex').slice(0, 32)
    : row.content_hash;

  const debug = { ...(row.debug || {}) };
  debug.viewports = [...(debug.viewports || []), {
    viewport,
    ok: true,
    durationMs: Date.now() - startedAt,
    screenshots: stored.map((s) => s.label),
    capturedAt: new Date().toISOString(),
  }];

  await supabase
    .from('ai_style_reference_analysis')
    .update({
      screenshots: [...(Array.isArray(row.screenshots) ? row.screenshots : []), ...stored],
      extracted_metrics: metrics,
      final_url: bundle.finalUrl || row.final_url,
      content_hash: contentHash,
      debug,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id);

  return res.status(200).json({ viewport, ok: true, screenshots: stored.map(({ label, url }) => ({ label, url })) });
}

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

async function runAnalysis(row, tenantId, res) {
  const prefix = tenantPublicAssetPrefix(tenantId);
  if (!prefix) return res.status(500).json({ error: 'Storage is not configured.' });

  const shots = (Array.isArray(row.screenshots) ? row.screenshots : [])
    .filter((s) => s?.url && String(s.url).startsWith(prefix));
  if (shots.length === 0) return res.status(400).json({ error: 'No usable screenshots to analyse.' });

  const client = getOpenAIClient();
  if (!client) return res.status(503).json({ error: 'AI analysis is not configured on this server.' });

  // Budget the image inputs: all crops (high) + one full-page overview per
  // viewport (low), capped.
  const inputs = buildAnalysisImageInputs(shots).slice(0, 12);
  const { system, user } = buildDesignDnaAnalysisPrompt({
    metrics: row.extracted_metrics || null,
    screenshotLabels: inputs.map((i) => i.label),
  });

  const startedAt = Date.now();
  let completion;
  try {
    completion = await client.chat.completions.create({
      model: ANALYSIS_MODEL,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: user },
            ...inputs.map((i) => ({ type: 'image_url', image_url: { url: i.url, detail: i.detail } })),
          ],
        },
      ],
      response_format: { type: 'json_schema', json_schema: DESIGN_DNA_JSON_SCHEMA },
      temperature: 0.2,
      max_completion_tokens: 8000,
    });
  } catch (err) {
    console.error('[style-reference] analysis failed:', err?.message);
    await supabase
      .from('ai_style_reference_analysis')
      .update({ status: 'failed', error: 'analysis_unavailable', updated_at: new Date().toISOString() })
      .eq('id', row.id);
    return res.status(502).json({ error: 'The style analysis service is temporarily unavailable — please try again.' });
  }

  let parsed = null;
  try { parsed = JSON.parse(completion.choices?.[0]?.message?.content || ''); } catch {}
  const designDna = normalizeDesignDnaV2(parsed);

  const hasMobileScreenshots = shots.some((s) => s.viewport === 'mobile');
  const metricsForGate = row.extracted_metrics?.desktop || null;
  const gate = runDesignDnaQualityGate(designDna, {
    metrics: metricsForGate,
    hasMobileScreenshots,
  });

  const usage = completion.usage || null;
  const debug = {
    ...(row.debug || {}),
    analysis: {
      model: ANALYSIS_MODEL,
      requestId: completion.id || null,
      durationMs: Date.now() - startedAt,
      imagesSent: inputs.map((i) => ({ label: i.label, detail: i.detail })),
      qualityGate: { ok: gate.ok, failures: gate.failures, warnings: gate.warnings },
      analysedAt: new Date().toISOString(),
    },
  };
  // Rough cost estimate (gpt-4o list price) — informational only.
  const estimatedCost = usage
    ? ((usage.prompt_tokens || 0) * 2.5 + (usage.completion_tokens || 0) * 10) / 1e6
    : null;

  const update = {
    design_dna: designDna,
    quality_score: gate.score,
    quality_warnings: [...gate.failures.map((f) => `blocked: ${f}`), ...gate.warnings],
    model: ANALYSIS_MODEL,
    token_usage: usage,
    estimated_cost: estimatedCost,
    debug,
    status: gate.ok ? 'complete' : 'failed',
    error: gate.ok ? null : QUALITY_GATE_USER_MESSAGE,
    updated_at: new Date().toISOString(),
  };
  const { data: saved } = await supabase
    .from('ai_style_reference_analysis')
    .update(update)
    .eq('id', row.id)
    .select('*')
    .single();

  if (!gate.ok) {
    return res.status(422).json({
      error: QUALITY_GATE_USER_MESSAGE,
      details: gate.failures,
      analysis: publicAnalysis(saved || { ...row, ...update }),
    });
  }
  return res.status(200).json({ analysis: publicAnalysis(saved || { ...row, ...update }) });
}

async function handleAnalyze(body, context, res) {
  const tenantId = context.tenantId;

  // Path A: staged flow — analyse a captured analysis row.
  if (body.analysisId) {
    const row = await fetchAnalysisRow(tenantId, body.analysisId);
    if (!row) return res.status(404).json({ error: 'Analysis not found.' });
    if (row.status === 'complete' && row.design_dna && !body.reanalyze) {
      return res.status(200).json({ analysis: publicAnalysis(row) });
    }
    return runAnalysis(row, tenantId, res);
  }

  // Path B: upload flow — tenant-owned screenshot URLs, no extractor
  // evidence. Creates an upload-sourced row so the result is still cached,
  // previewable and debuggable.
  const prefix = tenantPublicAssetPrefix(tenantId);
  if (!prefix) return res.status(500).json({ error: 'Storage is not configured.' });
  const shots = [];
  for (const s of Array.isArray(body.screenshots) ? body.screenshots.slice(0, MAX_REFERENCE_SCREENSHOTS * 2) : []) {
    const url = String(s?.url || s || '').trim();
    if (!url || !url.startsWith(prefix) || shots.some((x) => x.url === url)) continue;
    const viewport = ['desktop', 'tablet', 'mobile'].includes(s?.viewport) ? s.viewport : 'desktop';
    shots.push({ viewport, label: `${viewport}_upload_${shots.length + 1}`, url });
    if (shots.length >= MAX_REFERENCE_SCREENSHOTS) break;
  }
  if (shots.length === 0) return res.status(400).json({ error: 'No usable screenshots to analyse.' });

  const { data: row, error } = await supabase
    .from('ai_style_reference_analysis')
    .insert({
      tenant_id: tenantId,
      source_type: 'upload',
      status: 'capturing',
      capture_version: CAPTURE_VERSION,
      analyser_version: ANALYSER_VERSION,
      schema_version: DESIGN_DNA_SCHEMA_VERSION,
      screenshots: shots,
      created_by: context.memberId || null,
      expires_at: new Date(Date.now() + CACHE_TTL_DAYS * 24 * 3600 * 1000).toISOString(),
      debug: { uploaded: true, startedAt: new Date().toISOString() },
    })
    .select('*')
    .single();
  if (error || !row) {
    console.error('[style-reference] failed to create upload analysis row:', error?.message);
    return res.status(500).json({ error: 'Could not start the reference analysis.' });
  }
  return runAnalysis(row, tenantId, res);
}

// ---------------------------------------------------------------------------
// get / list / delete
// ---------------------------------------------------------------------------

async function handleGet(body, context, res) {
  const row = await fetchAnalysisRow(context.tenantId, body.analysisId);
  if (!row) return res.status(404).json({ error: 'Analysis not found.' });
  return res.status(200).json({ analysis: publicAnalysis(row, { includeDebug: !!body.debug }) });
}

async function handleList(body, context, res) {
  const { data } = await supabase
    .from('ai_style_reference_analysis')
    .select('id, source_url, source_type, status, schema_version, quality_score, created_at, last_used_at, expires_at, screenshots')
    .eq('tenant_id', context.tenantId)
    .eq('status', 'complete')
    .order('created_at', { ascending: false })
    .limit(20);
  const analyses = (data || []).map((r) => ({
    id: r.id,
    sourceUrl: r.source_url,
    sourceType: r.source_type,
    qualityScore: r.quality_score != null ? Number(r.quality_score) : null,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    isStale: r.expires_at ? new Date(r.expires_at) < new Date() : false,
    thumbnail: (Array.isArray(r.screenshots) ? r.screenshots : []).find((s) => /_full_page$/.test(s.label || ''))?.url
      || (Array.isArray(r.screenshots) ? r.screenshots[0]?.url : null) || null,
  }));
  return res.status(200).json({ analyses });
}

async function handleDelete(body, context, res) {
  const row = await fetchAnalysisRow(context.tenantId, body.analysisId);
  if (!row) return res.status(404).json({ error: 'Analysis not found.' });
  // Best-effort storage cleanup of the analysis's own screenshot folder.
  const paths = (Array.isArray(row.screenshots) ? row.screenshots : [])
    .map((s) => {
      const m = String(s.url || '').split(`/object/public/${BUCKET}/`)[1];
      return m || null;
    })
    .filter(Boolean);
  if (paths.length) await supabase.storage.from(BUCKET).remove(paths).catch(() => {});
  await supabase
    .from('ai_style_reference_analysis')
    .delete()
    .eq('id', row.id)
    .eq('tenant_id', context.tenantId);
  return res.status(200).json({ deleted: true });
}

// ---------------------------------------------------------------------------

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

  const body = req.body || {};
  try {
    if (body.action === 'start') return await handleStart(body, context, res);
    if (body.action === 'capture') return await handleCaptureViewport(body, context, res);
    if (body.action === 'analyze') return await handleAnalyze(body, context, res);
    if (body.action === 'get') return await handleGet(body, context, res);
    if (body.action === 'list') return await handleList(body, context, res);
    if (body.action === 'delete') return await handleDelete(body, context, res);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('[style-reference] unexpected error:', err?.message);
    return res.status(500).json({ error: 'Style reference request failed.' });
  }
}
