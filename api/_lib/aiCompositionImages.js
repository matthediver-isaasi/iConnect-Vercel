/**
 * AI Composition image & illustration generation — Phase 3 (Task #2851).
 *
 * Pure, dependency-injectable logic for the assets stage of the generation
 * pipeline and the in-composition image actions (spec §19–§20):
 *   - collectImageBriefs(doc): find image/generated_illustration elements
 *     still awaiting an asset (they carry an `imageBrief`, no resolved
 *     fileRepositoryId).
 *   - buildImagePrompt(brief, brand): structured brief → provider prompt.
 *     The prompt forbids embedded factual text (spec §19/§20 rule).
 *   - resolveCompositionAssets(): generates every outstanding asset with
 *     PER-ASSET failure isolation (spec §30) — a failed image marks that one
 *     element `asset.status = 'failed'` and the run continues.
 *   - collectAltTextFlags(doc): the alt-text workflow — every image either
 *     has alt text or is flagged (never silently ignored).
 *
 * Everything provider/storage-facing is injected:
 *   generateImage({ prompt, aspectRatio })   → { buffer, model, cost? }
 *   storeAsset({ buffer, brief, elementId }) → { fileRepositoryId, url }
 */

export const IMAGE_ELEMENT_TYPES = ['image', 'generated_illustration'];

export const IMAGE_ASPECTS = ['square', 'landscape', 'portrait'];

/** Provider size map (OpenAI gpt-image-1 supported sizes). */
export const ASPECT_SIZES = {
  square: '1024x1024',
  landscape: '1536x1024',
  portrait: '1024x1536',
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function normalizeAspect(aspect) {
  return IMAGE_ASPECTS.includes(aspect) ? aspect : 'landscape';
}

/** Walk every element (including children) of a composition document. */
export function walkElements(doc, fn) {
  const walk = (els, section) => {
    for (const el of els || []) {
      if (!isPlainObject(el)) continue;
      fn(el, section);
      if (Array.isArray(el.children)) walk(el.children, section);
    }
  };
  for (const s of doc?.sections || []) walk(s.elements, s);
}

/**
 * Elements that still need an asset generated: image/illustration types
 * carrying an imageBrief without a resolved fileRepositoryId (or explicitly
 * pending). Failed elements are re-collected so a retry can pick them up.
 */
export function collectImageBriefs(doc) {
  const out = [];
  walkElements(doc, (el, section) => {
    if (!IMAGE_ELEMENT_TYPES.includes(el.type)) return;
    if (!isPlainObject(el.imageBrief)) return;
    if (isPlainObject(el.asset) && el.asset.fileRepositoryId && el.asset.status !== 'failed') return;
    out.push({ elementId: el.id, sectionId: section?.id || null, brief: el.imageBrief, type: el.type });
  });
  return out;
}

/**
 * Structured brief → provider prompt. Brand palette and style are woven in;
 * the factual-text rule is enforced in the prompt AND upstream by the schema
 * validator (imageBrief.textOverlay may not contain numbers).
 */
export function buildImagePrompt(brief = {}, brand = null, elementType = 'image') {
  const parts = [];
  const isIllustration = elementType === 'generated_illustration';
  parts.push(isIllustration
    ? `A clean vector-style illustration: ${brief.subject || 'abstract shapes'}.`
    : `A high-quality photographic-style image: ${brief.subject || 'abstract scene'}.`);
  if (brief.style) parts.push(`Visual style: ${brief.style}.`);
  if (brief.placement) parts.push(`Intended placement: ${brief.placement} of a web page.`);
  const palette = brief.palette
    || [brand?.primaryColor, brand?.secondaryColor].filter(Boolean).join(', ');
  if (palette) parts.push(`Colour palette: ${palette}.`);
  if (brief.focalPoint) {
    parts.push(`Main subject positioned around ${Math.round(brief.focalPoint.x)}% across, ${Math.round(brief.focalPoint.y)}% down.`);
  }
  if (brief.avoid) parts.push(`Avoid: ${brief.avoid}.`);
  if (brief.textOverlay) parts.push(`Decorative text allowed: "${brief.textOverlay}".`);
  else parts.push('No text, letters, numbers, words or captions anywhere in the image.');
  parts.push('No watermarks or logos. Professional, on-brand, suitable for a membership organisation website.');
  return parts.join(' ');
}

/**
 * Generate every outstanding asset for a document with per-asset failure
 * isolation (spec §30). Mutates a CLONE of the document, never the input.
 *
 * Returns { doc, results } where results[i] =
 *   { elementId, ok, fileRepositoryId?, url?, altText?, error? }.
 * A failed generation sets el.asset = { status:'failed' } and keeps the
 * imageBrief so the user can retry — it NEVER throws out of this function
 * for a single-asset failure. Only zero-brief inputs short-circuit.
 */
export async function resolveCompositionAssets({ doc, brand = null, generateImage, storeAsset, maxAssets = 6 }) {
  const next = JSON.parse(JSON.stringify(doc));
  const briefs = collectImageBriefs(next).slice(0, maxAssets);
  const results = [];
  if (!briefs.length) return { doc: next, results };

  const byId = new Map();
  walkElements(next, (el) => byId.set(el.id, el));

  for (const item of briefs) {
    const el = byId.get(item.elementId);
    if (!el) continue;
    const aspectRatio = normalizeAspect(item.brief.aspectRatio);
    try {
      const prompt = buildImagePrompt(item.brief, brand, item.type);
      const generated = await generateImage({ prompt, aspectRatio });
      const stored = await storeAsset({
        buffer: generated.buffer,
        brief: item.brief,
        elementId: item.elementId,
        prompt,
        model: generated.model || null,
        cost: generated.cost ?? null,
        aspectRatio,
      });
      const altText = String(item.brief.accessibilityDescription || '').trim();
      el.asset = {
        fileRepositoryId: stored.fileRepositoryId,
        url: stored.url,
        status: 'ready',
        altText,
        ...(item.brief.focalPoint ? { focalPoint: item.brief.focalPoint } : {}),
      };
      results.push({
        elementId: item.elementId,
        ok: true,
        fileRepositoryId: stored.fileRepositoryId,
        url: stored.url,
        altText,
        altTextMissing: !altText,
      });
    } catch (err) {
      // Per-asset isolation: flag this element, keep the brief for retry,
      // continue with the rest of the run.
      el.asset = { status: 'failed' };
      results.push({
        elementId: item.elementId,
        ok: false,
        error: err?.message || 'Image generation failed',
      });
    }
  }
  return { doc: next, results };
}

/**
 * Alt-text workflow (spec §19): every image either has alt text or is
 * flagged. Returns [{ elementId, reason }] — reason 'missing_alt_text' for
 * resolved assets without alt text, 'generation_failed' for failed assets.
 */
export function collectAltTextFlags(doc) {
  const flags = [];
  walkElements(doc, (el) => {
    if (!IMAGE_ELEMENT_TYPES.includes(el.type)) return;
    if (!isPlainObject(el.asset)) return;
    if (el.asset.status === 'failed') {
      flags.push({ elementId: el.id, reason: 'generation_failed' });
      return;
    }
    if (el.asset.fileRepositoryId && !String(el.asset.altText || '').trim()) {
      flags.push({ elementId: el.id, reason: 'missing_alt_text' });
    }
  });
  return flags;
}

/**
 * Deterministic asset patch builders for the in-composition image actions.
 * These merge into the CURRENT asset so crop/focal edits never drop the
 * underlying fileRepositoryId.
 */
export function buildAssetMergeOp(doc, elementId, changes) {
  let current = null;
  walkElements(doc, (el) => { if (el.id === elementId) current = el.asset || null; });
  const merged = { ...(isPlainObject(current) ? current : {}), ...changes };
  return { op: 'replace_asset', elementId, asset: merged };
}
