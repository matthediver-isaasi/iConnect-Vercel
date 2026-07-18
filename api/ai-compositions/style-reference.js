// Style Reference capture & Design DNA analysis (Task #2873).
//
// POST /api/ai-compositions/style-reference
//   body: { action: 'capture', sourceType: 'page'|'url', pageId?, url? }
//     → renders desktop/tablet/mobile screenshots via browserless.io, stores
//       them in tenant storage (quota metered) and returns
//       { screenshots: [{ viewport, url, width, height }], sourceUrl }
//   body: { action: 'analyze', screenshots: [{ viewport, url }] }
//     → sends the screenshots to the vision LLM and returns the validated
//       Design DNA profile { designDna }
//
// Screenshot URLs accepted for analysis MUST live under the calling
// tenant's own public-assets prefix (uploads and captures both do), so the
// vision model is only ever fed tenant-owned images.
//
// Gated the same as generation: ai-generate feature key.

import OpenAI from 'openai';
import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { canUseAiFeature, AI_FEATURE_GENERATE } from '../_lib/aiStudioAccess.js';
import { checkStorageQuota } from '../_lib/planQuota.js';
import { addTenantStorageBytes } from '../_lib/tenantStorageUsage.js';
import { getTenantBaseUrl } from '../_lib/campaignService.js';
import {
  validateReferenceUrl,
  assertPublicUrlTarget,
  normalizeDesignDna,
  buildDesignDnaPrompt,
  MAX_REFERENCE_SCREENSHOTS,
} from '../_lib/styleReference.js';
import {
  captureReferenceScreenshots,
  isBrowserlessConfigured,
} from '../_lib/browserlessScreenshot.js';
import { tenantPublicAssetPrefix } from '../_lib/aiCompositionAssetStore.js';

const BUCKET = 'public-assets';

function getOpenAIClient() {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (!apiKey) return null;
  return new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
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
    // Screenshots are taken anonymously, so the page must be publicly
    // renderable at its bare slug (mirrors entityMeta resolution).
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
    // Second stage: resolve DNS and refuse private/loopback/link-local
    // targets (also catches decimal/hex/octal IP-literal encodings).
    const resolved = await assertPublicUrlTarget(check.url);
    if (!resolved.ok) return { error: resolved.error, status: 400 };
    return { url: check.url };
  }
  return { error: 'Unsupported reference source.', status: 400 };
}

async function handleCapture(body, tenantId, res) {
  if (!isBrowserlessConfigured()) {
    return res.status(503).json({ error: 'Screenshot capture is not configured on this server. You can upload screenshots instead.' });
  }
  const resolved = await resolveCaptureUrl(body, tenantId);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

  let captures;
  try {
    captures = await captureReferenceScreenshots(resolved.url);
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Screenshot capture failed.' });
  }

  const totalBytes = captures.reduce((n, c) => n + c.buffer.length, 0);
  const quota = await checkStorageQuota(tenantId, { fileSizeBytes: totalBytes });
  if (!quota.ok) return res.status(quota.status || 402).json(quota.body || { error: 'Storage quota exceeded' });

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const screenshots = [];
  let storedBytes = 0;
  for (const cap of captures) {
    const path = `${tenantId}/style-refs/${stamp}-${cap.viewport}.jpg`;
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, cap.buffer, { contentType: cap.contentType, upsert: false });
    if (upErr) {
      console.error('[style-reference] upload failed:', upErr.message);
      continue;
    }
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
    if (pub?.publicUrl) {
      screenshots.push({ viewport: cap.viewport, url: pub.publicUrl, width: cap.width, height: cap.height });
      storedBytes += cap.buffer.length;
    }
  }
  if (storedBytes > 0) addTenantStorageBytes(tenantId, storedBytes).catch(() => {});
  if (screenshots.length === 0) {
    return res.status(502).json({ error: 'The screenshots could not be stored — please try again.' });
  }
  return res.status(200).json({ screenshots, sourceUrl: resolved.url });
}

async function handleAnalyze(body, tenantId, res) {
  const prefix = tenantPublicAssetPrefix(tenantId);
  if (!prefix) return res.status(500).json({ error: 'Storage is not configured.' });
  const urls = [];
  for (const s of Array.isArray(body.screenshots) ? body.screenshots.slice(0, MAX_REFERENCE_SCREENSHOTS * 2) : []) {
    const url = String(s?.url || s || '').trim();
    if (!url || !url.startsWith(prefix) || urls.includes(url)) continue;
    urls.push(url);
    if (urls.length >= MAX_REFERENCE_SCREENSHOTS) break;
  }
  if (urls.length === 0) {
    return res.status(400).json({ error: 'No usable screenshots to analyse.' });
  }

  const client = getOpenAIClient();
  if (!client) return res.status(503).json({ error: 'AI analysis is not configured on this server.' });

  const { system, user } = buildDesignDnaPrompt();
  let completion;
  try {
    completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: user },
            ...urls.map((url) => ({ type: 'image_url', image_url: { url, detail: 'low' } })),
          ],
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_completion_tokens: 1200,
    });
  } catch (err) {
    console.error('[style-reference] analysis failed:', err?.message);
    return res.status(502).json({ error: 'The style analysis service is temporarily unavailable — please try again.' });
  }
  let parsed;
  try {
    parsed = JSON.parse(completion.choices?.[0]?.message?.content || '');
  } catch {
    return res.status(502).json({ error: 'The style analysis returned an unreadable response — please try again.' });
  }
  const designDna = normalizeDesignDna(parsed);
  if (!designDna) {
    return res.status(502).json({ error: 'The style analysis produced no usable profile — please try again.' });
  }
  return res.status(200).json({ designDna });
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
  if (!(await canUseAiFeature(context, AI_FEATURE_GENERATE))) {
    return res.status(404).json({ error: 'Not found' });
  }

  const body = req.body || {};
  try {
    if (body.action === 'capture') return await handleCapture(body, context.tenantId, res);
    if (body.action === 'analyze') return await handleAnalyze(body, context.tenantId, res);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('[style-reference] unexpected error:', err?.message);
    return res.status(500).json({ error: 'Style reference request failed.' });
  }
}
