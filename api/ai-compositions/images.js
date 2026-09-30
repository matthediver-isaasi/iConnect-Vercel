// AI Composition in-composition image actions — Phase 3 (Task #2851).
//
// POST /api/ai-compositions/images  { action, compositionId, elementId, ... }
//   'generate'        { brief }                     → generate a new image for the element
//   'regenerate'      { brief? }                    → edit/regenerate (parent-linked)
//   'alternative'     { brief? }                    → new alternative, old asset kept (usage 'alternative')
//   'replace'         { fileRepositoryId }          → replace with an uploaded / media-library asset
//   'crop'            { crop: { aspectRatio } }     → deterministic asset patch
//   'focal'           { focalPoint: { x, y } }      → deterministic asset patch
//   'simplify_mobile' {}                            → simplified mobile variant on asset.mobile
//
// Every action produces a new immutable version via a deterministic
// replace_asset patch — the LLM is never involved here. Editors only;
// 404 (not 403) so composition existence never leaks.

import OpenAI from 'openai';
import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { canUseAiFeature, AI_FEATURE_GENERATE, illustrationBlocked } from '../_lib/aiStudioAccess.js';
import { applyPatch } from '../_lib/aiCompositionPatch.js';
import { validateComposition } from '../_lib/aiCompositionSchema.js';
import {
  buildImagePrompt,
  buildAssetMergeOp,
  normalizeAspect,
  ASPECT_SIZES,
  IMAGE_ELEMENT_TYPES,
  walkElements,
} from '../_lib/aiCompositionImages.js';
import {
  storeGeneratedAsset,
  markGeneratedAssetUsage,
  findGeneratedAssetByFile,
} from '../_lib/aiCompositionAssetStore.js';
import { loadStudioSettings } from '../_lib/aiDesignStudioSettings.js';
import { checkAiUsageAllowance, recordAiUsageEvent } from '../_lib/aiUsage.js';

function getOpenAIClient() {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (!apiKey) return null;
  return new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
}

async function generateImageBuffer(client, prompt, aspectRatio) {
  let result;
  try {
    result = await client.images.generate({
      model: 'gpt-image-1',
      prompt,
      size: ASPECT_SIZES[aspectRatio] || ASPECT_SIZES.landscape,
      n: 1,
    });
  } catch {
    throw Object.assign(
      new Error('Image generation failed — the image service was unavailable. Nothing was changed.'),
      { httpStatus: 502 },
    );
  }
  const b64 = result?.data?.[0]?.b64_json;
  if (!b64) {
    throw Object.assign(new Error('Image generation returned no image. Nothing was changed.'), { httpStatus: 502 });
  }
  return Buffer.from(b64, 'base64');
}

async function loadComposition(id, tenantId) {
  const { data: comp } = await supabase
    .from('ai_composition')
    .select('id, tenant_id, current_version_id')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!comp || !comp.current_version_id) return null;
  const { data: version } = await supabase
    .from('ai_composition_version')
    .select('id, document')
    .eq('id', comp.current_version_id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!version?.document) return null;
  return { comp, version, doc: version.document };
}

function findImageElement(doc, elementId) {
  let found = null;
  walkElements(doc, (el) => { if (el.id === elementId) found = el; });
  if (!found || !IMAGE_ELEMENT_TYPES.includes(found.type)) return null;
  return found;
}

async function saveVersion({ comp, version, tenantId, memberId, doc, summary }) {
  const check = validateComposition(doc);
  if (!check.ok) {
    throw Object.assign(
      new Error('The change produced an invalid document and was rejected.'),
      { httpStatus: 422, validationErrors: check.errors.slice(0, 10) },
    );
  }
  const { data: inserted, error } = await supabase
    .from('ai_composition_version')
    .insert({
      composition_id: comp.id,
      tenant_id: tenantId,
      parent_version_id: version.id,
      document: doc,
      change_summary: summary,
      operation_type: 'edit',
      is_alternative: false,
      validation_result: { ok: true },
      generation_metadata: { source: 'image_action' },
      created_by: memberId,
    })
    .select('id')
    .single();
  if (error) throw new Error('Failed to save the new version');
  await supabase
    .from('ai_composition')
    .update({ current_version_id: inserted.id, updated_at: new Date().toISOString() })
    .eq('id', comp.id)
    .eq('tenant_id', tenantId);
  return inserted.id;
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
  // Permission split (spec §29): imagery generation sits under ai-generate
  // on top of the baseline page-editor permission (404 to avoid leaking).
  if (!(await canUseAiFeature(context, AI_FEATURE_GENERATE))) {
    return res.status(404).json({ error: 'Not found' });
  }
  const tenantId = context.tenantId;
  const memberId = context.memberId || null;

  const body = req.body || {};
  const { action, compositionId, elementId } = body;

  try {
    const loaded = await loadComposition(compositionId, tenantId);
    if (!loaded) return res.status(404).json({ error: 'Composition not found' });
    const { comp, version, doc } = loaded;

    const el = findImageElement(doc, elementId);
    if (!el) return res.status(404).json({ error: 'Image element not found in this composition' });
    const currentAsset = el.asset || {};

    // ---- deterministic asset patches --------------------------------------
    if (action === 'focal' || action === 'crop') {
      const changes = action === 'focal'
        ? { focalPoint: body.focalPoint }
        : { crop: body.crop };
      const op = buildAssetMergeOp(doc, elementId, changes);
      const applied = applyPatch(doc, [op]);
      if (!applied.ok) return res.status(422).json({ error: 'The change could not be applied.', details: applied.errors.slice(0, 5) });
      const versionId = await saveVersion({
        comp, version, tenantId, memberId, doc: applied.doc,
        summary: action === 'focal' ? 'Changed image focal point' : 'Changed image crop',
      });
      return res.status(200).json({ status: 'applied', versionId, document: applied.doc });
    }

    // ---- replace with an uploaded / media-library asset --------------------
    if (action === 'replace') {
      const fileId = String(body.fileRepositoryId || '');
      const { data: file } = await supabase
        .from('file_repository')
        .select('id, tenant_id, file_url, mime_type')
        .eq('id', fileId)
        .eq('tenant_id', tenantId)   // tenant ownership is the security gate
        .maybeSingle();
      if (!file) return res.status(404).json({ error: 'That media-library file could not be found.' });
      if (file.mime_type && !/^image\//.test(file.mime_type)) {
        return res.status(422).json({ error: 'Only image files can be used here.' });
      }
      const altText = String(body.altText || currentAsset.altText || '').trim();
      const op = {
        op: 'replace_asset',
        elementId,
        asset: { fileRepositoryId: file.id, url: file.file_url, status: 'ready', altText },
      };
      const applied = applyPatch(doc, [op]);
      if (!applied.ok) return res.status(422).json({ error: 'The replacement could not be applied.', details: applied.errors.slice(0, 5) });
      if (currentAsset.fileRepositoryId && currentAsset.fileRepositoryId !== file.id) {
        await markGeneratedAssetUsage(tenantId, currentAsset.fileRepositoryId, 'replaced');
      }
      const versionId = await saveVersion({
        comp, version, tenantId, memberId, doc: applied.doc, summary: 'Replaced image from media library',
      });
      return res.status(200).json({
        status: 'applied',
        versionId,
        document: applied.doc,
        altTextMissing: !altText,
      });
    }

    // ---- generation actions ------------------------------------------------
    if (['generate', 'regenerate', 'alternative', 'simplify_mobile'].includes(action)) {
      const client = getOpenAIClient();
      if (!client) return res.status(503).json({ error: 'Image generation is not configured on this server.' });

      // Governance gate (Phase 4): image allowances + rate limit.
      const studioSettings = await loadStudioSettings(supabase, tenantId);
      if (studioSettings.allowImageGeneration === false) {
        return res.status(403).json({ error: 'AI image generation is disabled for this organisation.', code: 'AI_IMAGES_DISABLED' });
      }
      if (illustrationBlocked(studioSettings, el.type)) {
        return res.status(403).json({ error: 'AI illustration is disabled for this organisation.', code: 'AI_ILLUSTRATION_DISABLED' });
      }
      const allowance = await checkAiUsageAllowance(supabase, {
        tenantId,
        memberId,
        settings: studioSettings,
        operation: 'image_generation',
        prompt: JSON.stringify(body.brief || el.imageBrief || {}),
        imageCount: 1,
      });
      if (!allowance.ok) {
        await recordAiUsageEvent(supabase, {
          tenantId,
          memberId,
          compositionId: comp.id,
          operation: 'image_generation',
          units: { images: 1 },
          status: 'blocked',
          dedupeHash: allowance.dedupeHash,
        });
        return res.status(allowance.status).json(allowance.body);
      }

      // Brief: explicit from the client, else the element's stored brief,
      // else the previous generated asset's brief.
      let brief = (body.brief && typeof body.brief === 'object') ? body.brief : el.imageBrief;
      let parentAssetId = null;
      const prevMeta = currentAsset.fileRepositoryId
        ? await findGeneratedAssetByFile(tenantId, currentAsset.fileRepositoryId)
        : null;
      if (!brief && prevMeta?.brief) brief = prevMeta.brief;
      if (!brief?.subject) {
        return res.status(400).json({ error: 'An image brief with a subject is required.' });
      }
      if (prevMeta && action !== 'generate') parentAssetId = prevMeta.id;

      const isMobile = action === 'simplify_mobile';
      const effectiveBrief = isMobile
        ? { ...brief, style: `${brief.style ? `${brief.style}. ` : ''}Simplified for a small mobile screen: fewer details, one clear focal subject, bold shapes`, aspectRatio: 'portrait' }
        : brief;
      const aspectRatio = normalizeAspect(effectiveBrief.aspectRatio);
      const prompt = buildImagePrompt(effectiveBrief, null, el.type);
      const buffer = await generateImageBuffer(client, prompt, aspectRatio);
      const stored = await storeGeneratedAsset({
        tenantId,
        memberId,
        compositionId: comp.id,
        elementId,
        buffer,
        prompt,
        model: 'gpt-image-1',
        aspectRatio,
        brief: effectiveBrief,
        parentAssetId,
        usageStatus: 'in_use',
      });

      const altText = String(effectiveBrief.accessibilityDescription || currentAsset.altText || '').trim();
      let nextAsset;
      let summary;
      if (isMobile) {
        nextAsset = { ...currentAsset, mobile: { fileRepositoryId: stored.fileRepositoryId, url: stored.url } };
        summary = 'Added a simplified mobile image';
      } else {
        nextAsset = {
          fileRepositoryId: stored.fileRepositoryId,
          url: stored.url,
          status: 'ready',
          altText,
          ...(effectiveBrief.focalPoint ? { focalPoint: effectiveBrief.focalPoint } : {}),
        };
        summary = action === 'alternative' ? 'Generated an alternative image'
          : action === 'regenerate' ? 'Regenerated the image'
            : 'Generated a new image';
      }
      if (!isMobile && currentAsset.fileRepositoryId && currentAsset.fileRepositoryId !== stored.fileRepositoryId) {
        await markGeneratedAssetUsage(
          tenantId,
          currentAsset.fileRepositoryId,
          action === 'alternative' ? 'alternative' : 'replaced',
        );
      }

      const applied = applyPatch(doc, [{ op: 'replace_asset', elementId, asset: nextAsset }]);
      if (!applied.ok) return res.status(422).json({ error: 'The image could not be applied.', details: applied.errors.slice(0, 5) });
      const versionId = await saveVersion({
        comp, version, tenantId, memberId, doc: applied.doc, summary,
      });

      // Usage/audit event (Phase 4).
      await recordAiUsageEvent(supabase, {
        tenantId,
        memberId,
        compositionId: comp.id,
        operation: 'image_generation',
        model: 'gpt-image-1',
        units: { images: 1 },
        dedupeHash: allowance.dedupeHash,
      });

      return res.status(200).json({
        status: 'applied',
        versionId,
        document: applied.doc,
        fileRepositoryId: stored.fileRepositoryId,
        url: stored.url,
        altTextMissing: !isMobile && !altText,
        usageWarning: allowance.warning || undefined,
      });
    }

    return res.status(400).json({ error: `Unknown action "${action}"` });
  } catch (err) {
    const status = err.httpStatus || 500;
    return res.status(status).json({
      error: err.message || 'Image action failed',
      validationErrors: err.validationErrors || undefined,
    });
  }
}
