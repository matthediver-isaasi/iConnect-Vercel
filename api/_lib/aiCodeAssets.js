// AI Design Studio V2 — Phase 5 generated raster imagery (Task #2909).
//
// V2 compositions request raster images declaratively: the model never writes
// an <img src> itself. Instead it emits a placeholder
//   <img data-ai-id="…" data-ai-asset="<key>" alt="…">
// and declares the key in the package `assets` manifest as an image_request:
//   { key, type: "image_request", subject, style?, palette?, avoid?,
//     aspectRatio? ("square"|"landscape"|"portrait"), alt, required?,
//     librarySearch? }
//
// The server fulfils each request AFTER the safety pipeline (gpt-image-1 via
// injected generateImage, or an existing media-library image via injected
// searchLibrary), stores it through storeAsset (file_repository +
// ai_generated_asset) and rewrites the placeholder's src to the stored
// media-library URL. Per-asset failure isolation mirrors V1
// (aiCompositionImages.js): a failed request keeps its brief for retry and
// only REQUIRED assets hard-reject the generation.
//
// Provider/storage-facing calls are injected so this module stays
// node-testable:
//   generateImage({ prompt, aspectRatio })            → { buffer, model, cost? }
//   storeAsset({ buffer, request, prompt, ... })      → { fileRepositoryId, url, generatedAssetId? }
//   searchLibrary({ query })                          → { fileRepositoryId, url } | null

import { JSDOM } from 'jsdom';
import { buildImagePrompt, normalizeAspect } from './aiCompositionImages.js';

export const AI_CODE_ASSET_REQUEST_TYPE = 'image_request';

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate + normalise the `assets` manifest entries of a V2 package.
 * Entries already passed the generic keyed-list check (unique keys, type
 * present) in aiCodePackageSchema — this adds the image_request field rules.
 * Returns { ok, errors, assets } — assets is a normalised copy on ok.
 */
export function validateAssetRequests(assets) {
  const errors = [];
  const out = [];
  for (const [i, a] of (assets || []).entries()) {
    const p = `assets[${i}] ("${a?.key}")`;
    if (a?.type !== AI_CODE_ASSET_REQUEST_TYPE) {
      errors.push(`${p}.type "${a?.type}" is not supported — only "${AI_CODE_ASSET_REQUEST_TYPE}"`);
      continue;
    }
    const subject = typeof a.subject === 'string' ? a.subject.trim().slice(0, 600) : '';
    if (!subject) { errors.push(`${p}.subject is required — describe what the image shows`); continue; }
    const alt = typeof a.alt === 'string' ? a.alt.trim().slice(0, 300) : '';
    if (!alt) { errors.push(`${p}.alt is required — every requested image needs accessibility alt text`); continue; }
    // Factual-text rule (spec §19): generated imagery must never carry
    // numbers/prices baked into pixels.
    if (typeof a.textOverlay === 'string' && /\d/.test(a.textOverlay)) {
      errors.push(`${p}.textOverlay must not contain numbers — factual values never go into image pixels`);
      continue;
    }
    out.push({
      key: a.key,
      type: AI_CODE_ASSET_REQUEST_TYPE,
      subject,
      alt,
      style: typeof a.style === 'string' ? a.style.slice(0, 300) : undefined,
      palette: typeof a.palette === 'string' ? a.palette.slice(0, 200) : undefined,
      avoid: typeof a.avoid === 'string' ? a.avoid.slice(0, 300) : undefined,
      textOverlay: typeof a.textOverlay === 'string' ? a.textOverlay.slice(0, 120) : undefined,
      aspectRatio: normalizeAspect(a.aspectRatio),
      required: a.required === true,
      librarySearch: typeof a.librarySearch === 'string' ? a.librarySearch.trim().slice(0, 200) : undefined,
      // Fulfilment + presentation state survive re-validation (stored
      // documents round-trip — crop/focal edits must never be dropped).
      ...(isPlainObject(a.fulfilment) ? { fulfilment: a.fulfilment } : {}),
      ...(normalizeFocalPoint(a.focalPoint) ? { focalPoint: normalizeFocalPoint(a.focalPoint) } : {}),
      ...(normalizeCrop(a.crop) ? { crop: normalizeCrop(a.crop) } : {}),
    });
  }
  return { ok: errors.length === 0, errors, assets: out };
}

/** Requests still awaiting fulfilment (failed ones are re-collected for retry). */
export function collectPendingAssetRequests(doc) {
  return (doc?.assets || []).filter((a) => a?.type === AI_CODE_ASSET_REQUEST_TYPE
    && !(isPlainObject(a.fulfilment) && a.fulfilment.status === 'ready' && a.fulfilment.url));
}

/** Required requests that ended in failure — these hard-reject the generation. */
export function requiredAssetFailures(assets) {
  return (assets || []).filter((a) => a?.type === AI_CODE_ASSET_REQUEST_TYPE
    && a.required === true
    && (!isPlainObject(a.fulfilment) || a.fulfilment.status !== 'ready'));
}

/** Provider prompt for a V2 image_request — reuses the V1 prompt builder. */
export function buildV2AssetPrompt(request, brand = null) {
  return buildImagePrompt({
    subject: request.subject,
    style: request.style,
    palette: request.palette,
    avoid: request.avoid,
    textOverlay: request.textOverlay,
  }, brand, 'image');
}

const escapeAttr = (v) => String(v).replace(/["\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// Focal point & crop (merge semantics, mirroring V1's asset merge ops)
// ---------------------------------------------------------------------------

// CSS-style aspect: "16 / 9" (NOT "16:9" — the V1 lesson; it feeds
// the aspect-ratio CSS property verbatim).
const CROP_ASPECT_RE = /^\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?$/;

/** Normalise { x, y } percentages (0–100). Returns null when invalid/absent. */
export function normalizeFocalPoint(focal) {
  if (!isPlainObject(focal)) return null;
  const x = Number(focal.x);
  const y = Number(focal.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const clamp = (n) => Math.min(100, Math.max(0, Math.round(n * 10) / 10));
  return { x: clamp(x), y: clamp(y) };
}

/** Normalise { aspectRatio: "16 / 9" }. Returns null when invalid/absent. */
export function normalizeCrop(crop) {
  if (!isPlainObject(crop)) return null;
  const aspect = String(crop.aspectRatio || '').trim();
  if (!CROP_ASPECT_RE.test(aspect)) return null;
  return { aspectRatio: aspect.replace(/\s*\/\s*/, ' / ') };
}

/**
 * Deterministic focal-point / crop update (merge operation): merges the
 * provided changes onto the asset entry (never dropping the other field or
 * the fulfilment) and applies them to the <img> as inline presentation
 * styles (object-fit/object-position/aspect-ratio) — a pure presentation
 * change that never mutates layout markup. Pass `null` for a field to
 * clear it. Returns { ok, errors, doc, assetKey } — never mutates the input.
 */
export function updateImagePresentation(doc, aiId, { focalPoint, crop } = {}) {
  const wantsFocal = focalPoint !== undefined;
  const wantsCrop = crop !== undefined;
  if (!wantsFocal && !wantsCrop) {
    return { ok: false, errors: ['A focalPoint or crop change is required.'] };
  }
  const nextFocal = wantsFocal && focalPoint !== null ? normalizeFocalPoint(focalPoint) : null;
  if (wantsFocal && focalPoint !== null && !nextFocal) {
    return { ok: false, errors: ['focalPoint must be { x, y } percentages between 0 and 100.'] };
  }
  const nextCrop = wantsCrop && crop !== null ? normalizeCrop(crop) : null;
  if (wantsCrop && crop !== null && !nextCrop) {
    return { ok: false, errors: ['crop.aspectRatio must look like "16 / 9".'] };
  }

  const dom = new JSDOM(`<body>${doc?.html || ''}</body>`);
  const el = dom.window.document.querySelector(`img[data-ai-id="${escapeAttr(aiId)}"]`);
  if (!el) return { ok: false, errors: ['The image this change targets no longer exists.'] };
  const assetKey = el.getAttribute('data-ai-asset') || null;

  // Resolve the EFFECTIVE presentation: merge onto what the asset already
  // has, so setting a crop never drops an earlier focal point (and vice
  // versa).
  const entry = assetKey ? (doc?.assets || []).find((a) => a?.key === assetKey) : null;
  const effFocal = wantsFocal ? nextFocal : (normalizeFocalPoint(entry?.focalPoint) || null);
  const effCrop = wantsCrop ? nextCrop : (normalizeCrop(entry?.crop) || null);

  // Inline style attributes are forbidden by the sanitiser (the scoped
  // stylesheet is the single presentation choke point), so the presentation
  // is written as a marker-delimited rule appended to the document CSS —
  // rewritten in place on every change, never accumulated. The stored CSS is
  // already scope-prefixed; an attribute selector on the composition root
  // keeps this rule equally scoped without knowing the composition uuid.
  const decls = [];
  if (effFocal || effCrop) decls.push('object-fit: cover');
  if (effFocal) decls.push(`object-position: ${effFocal.x}% ${effFocal.y}%`);
  if (effCrop) decls.push(`aspect-ratio: ${effCrop.aspectRatio}`);
  const safeAiId = String(aiId).replace(/["\\]/g, '');
  const marker = `/* aic-presentation:${safeAiId} */`;
  const endMarker = `/* end-aic-presentation:${safeAiId} */`;
  const blockRe = new RegExp(
    `\\s*${marker.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[\\s\\S]*?${endMarker.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`,
    'g',
  );
  let css = String(doc?.css || '').replace(blockRe, '');
  if (decls.length) {
    css += `\n${marker}\n[data-ai-composition] img[data-ai-id="${safeAiId}"] { ${decls.join('; ')}; }\n${endMarker}`;
  }

  const next = { ...doc, html: dom.window.document.body.innerHTML, css };
  if (assetKey && Array.isArray(next.assets)) {
    next.assets = next.assets.map((a) => {
      if (a?.key !== assetKey) return a;
      const merged = { ...a };
      if (wantsFocal) {
        if (nextFocal) merged.focalPoint = nextFocal;
        else delete merged.focalPoint;
      }
      if (wantsCrop) {
        if (nextCrop) merged.crop = nextCrop;
        else delete merged.crop;
      }
      return merged;
    });
  }
  return { ok: true, errors: [], doc: next, assetKey, focalPoint: effFocal, crop: effCrop };
}

/**
 * Set src (+alt when the placeholder left it empty) on every
 * <img data-ai-asset="<key>"> in the HTML. Returns { html, matched }.
 */
export function applyAssetFulfilment(html, key, { url, alt = '' }) {
  const dom = new JSDOM(`<body>${html || ''}</body>`);
  const doc = dom.window.document;
  const els = doc.body.querySelectorAll(`img[data-ai-asset="${escapeAttr(key)}"]`);
  for (const el of els) {
    el.setAttribute('src', url);
    if (alt && !String(el.getAttribute('alt') || '').trim()) el.setAttribute('alt', alt);
  }
  return { html: doc.body.innerHTML, matched: els.length };
}

/**
 * Fulfil every pending image_request with per-asset failure isolation.
 * Never mutates the input document. Returns { doc, results, remaining }:
 *   results[i] = { key, ok, source?, fileRepositoryId?, generatedAssetId?,
 *                  url?, error? }
 *   remaining  = requests skipped because the deadline passed (resume later).
 */
export async function resolveV2AssetRequests({
  doc, brand = null, generateImage, storeAsset, searchLibrary = null,
  maxAssets = 6, deadline = null,
}) {
  const next = JSON.parse(JSON.stringify(doc));
  const pending = collectPendingAssetRequests(next).slice(0, maxAssets);
  const results = [];
  let remaining = 0;
  if (!pending.length) return { doc: next, results, remaining };

  const byKey = new Map((next.assets || []).map((a) => [a.key, a]));

  for (const request of pending) {
    if (typeof deadline === 'number' && Date.now() >= deadline && results.length > 0) {
      remaining += 1;
      continue;
    }
    const entry = byKey.get(request.key);
    if (!entry) continue;
    try {
      let stored = null;
      let source = 'generated';
      // Media-library first when the request names an existing image.
      if (request.librarySearch && typeof searchLibrary === 'function') {
        const hit = await searchLibrary({ query: request.librarySearch });
        if (hit?.url) { stored = hit; source = 'library'; }
      }
      if (!stored) {
        const prompt = buildV2AssetPrompt(request, brand);
        const generated = await generateImage({ prompt, aspectRatio: request.aspectRatio || 'landscape' });
        stored = await storeAsset({
          buffer: generated.buffer,
          request,
          prompt,
          model: generated.model || null,
          cost: generated.cost ?? null,
          aspectRatio: request.aspectRatio || 'landscape',
        });
      }
      const applied = applyAssetFulfilment(next.html, request.key, { url: stored.url, alt: request.alt });
      next.html = applied.html;
      entry.fulfilment = {
        status: 'ready',
        source,
        url: stored.url,
        fileRepositoryId: stored.fileRepositoryId || null,
        ...(stored.generatedAssetId ? { generatedAssetId: stored.generatedAssetId } : {}),
        alt: request.alt,
        placeholders: applied.matched,
      };
      results.push({
        key: request.key,
        ok: true,
        source,
        url: stored.url,
        fileRepositoryId: stored.fileRepositoryId || null,
        generatedAssetId: stored.generatedAssetId || null,
      });
    } catch (err) {
      // Per-asset isolation: keep the request (brief) for retry.
      entry.fulfilment = { status: 'failed', error: err?.message || 'Image generation failed' };
      results.push({ key: request.key, ok: false, error: err?.message || 'Image generation failed' });
    }
  }
  return { doc: next, results, remaining };
}

/**
 * Deterministic image replacement (Phase 4 edit flow): swap the src of the
 * <img> carrying the given data-ai-id for a media-library URL the SERVER
 * already verified belongs to the tenant. Returns { ok, errors, doc,
 * previousUrl, assetKey } — never mutates the input.
 */
export function replaceImageSource(doc, aiId, { url, alt = null }) {
  if (!url || typeof url !== 'string') return { ok: false, errors: ['A replacement image URL is required.'] };
  const dom = new JSDOM(`<body>${doc?.html || ''}</body>`);
  const el = dom.window.document.querySelector(`img[data-ai-id="${escapeAttr(aiId)}"]`);
  if (!el) return { ok: false, errors: ['The image this change targets no longer exists.'] };
  const previousUrl = el.getAttribute('src') || null;
  el.setAttribute('src', url);
  if (typeof alt === 'string' && alt.trim()) el.setAttribute('alt', alt.trim().slice(0, 300));
  const assetKey = el.getAttribute('data-ai-asset') || null;
  const next = { ...doc, html: dom.window.document.body.innerHTML };
  if (assetKey && Array.isArray(next.assets)) {
    next.assets = next.assets.map((a) => (a?.key === assetKey
      ? {
          ...a,
          fulfilment: {
            ...(isPlainObject(a.fulfilment) ? a.fulfilment : {}),
            status: 'ready',
            source: 'library',
            url,
            ...(typeof alt === 'string' && alt.trim() ? { alt: alt.trim().slice(0, 300) } : {}),
          },
        }
      : a));
  }
  return { ok: true, errors: [], doc: next, previousUrl, assetKey };
}
