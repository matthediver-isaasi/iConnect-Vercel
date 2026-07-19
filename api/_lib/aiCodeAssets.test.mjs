// AI Design Studio V2 — Phase 5 generated raster imagery tests.
//
// Pure-logic suites over aiCodeAssets.js (provider/storage calls injected as
// stubs — no network, no database) plus SVG-allowlist verification of the
// Phase 0 sanitiser: gradients, masks and clip-paths survive; scripts,
// external refs and raster <image> inside SVG do not.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateAssetRequests,
  collectPendingAssetRequests,
  requiredAssetFailures,
  buildV2AssetPrompt,
  applyAssetFulfilment,
  resolveV2AssetRequests,
  replaceImageSource,
} from './aiCodeAssets.js';
import { sanitizeAiCodeHtml } from './aiCodeHtmlSanitizer.js';

const LIB_URL = 'https://example.supabase.co/storage/v1/object/public/tenant-abc/hero.png';
const HOSTS = ['https://example.supabase.co/storage/v1/object/public/tenant-abc/'];

function makeDoc({ html, assets }) {
  return {
    schemaVersion: '2.0',
    compositionId: '00000000-0000-4000-8000-000000000001',
    html,
    css: '',
    assets,
  };
}

function req(over = {}) {
  return {
    key: 'hero',
    type: 'image_request',
    subject: 'A community hall full of volunteers',
    alt: 'Volunteers in a community hall',
    aspectRatio: 'landscape',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// validateAssetRequests
// ---------------------------------------------------------------------------

test('validateAssetRequests: accepts a well-formed image_request', () => {
  const r = validateAssetRequests([req()]);
  assert.equal(r.ok, true);
  assert.equal(r.assets.length, 1);
  assert.equal(r.assets[0].key, 'hero');
  assert.equal(r.assets[0].aspectRatio, 'landscape');
});

test('validateAssetRequests: rejects unsupported types, missing subject/alt', () => {
  assert.equal(validateAssetRequests([req({ type: 'video_request' })]).ok, false);
  assert.equal(validateAssetRequests([req({ subject: '' })]).ok, false);
  assert.equal(validateAssetRequests([req({ alt: '' })]).ok, false);
});

test('validateAssetRequests: factual-text rule — numbers never go into pixels', () => {
  const r = validateAssetRequests([req({ textOverlay: 'Only £99!' })]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /textOverlay/);
});

test('validateAssetRequests: fulfilment state survives re-validation', () => {
  const fulfilment = { status: 'ready', url: LIB_URL, source: 'generated' };
  const r = validateAssetRequests([req({ fulfilment })]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.assets[0].fulfilment, fulfilment);
});

// ---------------------------------------------------------------------------
// pending / required-failure collection
// ---------------------------------------------------------------------------

test('collectPendingAssetRequests: ready assets are done; failed ones retry', () => {
  const doc = makeDoc({
    html: '',
    assets: [
      req({ key: 'a', fulfilment: { status: 'ready', url: LIB_URL } }),
      req({ key: 'b', fulfilment: { status: 'failed', error: 'boom' } }),
      req({ key: 'c' }),
    ],
  });
  const pending = collectPendingAssetRequests(doc).map((a) => a.key);
  assert.deepEqual(pending, ['b', 'c']);
});

test('requiredAssetFailures: only unfulfilled REQUIRED requests hard-reject', () => {
  const assets = [
    req({ key: 'a', required: true, fulfilment: { status: 'ready', url: LIB_URL } }),
    req({ key: 'b', required: true, fulfilment: { status: 'failed' } }),
    req({ key: 'c', required: false, fulfilment: { status: 'failed' } }),
  ];
  assert.deepEqual(requiredAssetFailures(assets).map((a) => a.key), ['b']);
});

// ---------------------------------------------------------------------------
// fulfilment application
// ---------------------------------------------------------------------------

test('applyAssetFulfilment: sets src on every placeholder; keeps authored alt', () => {
  const html = '<img data-ai-id="i1" data-ai-asset="hero" alt="Authored"><img data-ai-id="i2" data-ai-asset="hero" alt="">';
  const out = applyAssetFulfilment(html, 'hero', { url: LIB_URL, alt: 'Fallback alt' });
  assert.equal(out.matched, 2);
  assert.equal((out.html.match(new RegExp(LIB_URL.replace(/[/.]/g, '\\$&'), 'g')) || []).length, 2);
  assert.match(out.html, /alt="Authored"/);
  assert.match(out.html, /alt="Fallback alt"/);
});

// ---------------------------------------------------------------------------
// resolveV2AssetRequests (stubbed provider/storage)
// ---------------------------------------------------------------------------

test('resolveV2AssetRequests: generates, stores and rewrites placeholders; never mutates input', async () => {
  const doc = makeDoc({
    html: '<img data-ai-id="i1" data-ai-asset="hero" alt="Volunteers">',
    assets: [req()],
  });
  const calls = [];
  const out = await resolveV2AssetRequests({
    doc,
    brand: { name: 'BNMS' },
    generateImage: async ({ prompt, aspectRatio }) => {
      calls.push({ prompt, aspectRatio });
      return { buffer: Buffer.from('img'), model: 'stub-model' };
    },
    storeAsset: async () => ({ fileRepositoryId: 'fr-1', url: LIB_URL, generatedAssetId: 'ga-1' }),
  });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[0].source, 'generated');
  assert.match(out.doc.html, /src="[^"]*hero\.png"/);
  assert.equal(out.doc.assets[0].fulfilment.status, 'ready');
  assert.equal(out.doc.assets[0].fulfilment.fileRepositoryId, 'fr-1');
  assert.equal(calls[0].aspectRatio, 'landscape');
  // input untouched
  assert.equal(doc.assets[0].fulfilment, undefined);
  assert.doesNotMatch(doc.html, /src=/);
});

test('resolveV2AssetRequests: media-library first when librarySearch matches', async () => {
  const doc = makeDoc({
    html: '<img data-ai-asset="hero" alt="x">',
    assets: [req({ librarySearch: 'community hall' })],
  });
  let generated = 0;
  const out = await resolveV2AssetRequests({
    doc,
    generateImage: async () => { generated += 1; return { buffer: Buffer.alloc(1) }; },
    storeAsset: async () => { throw new Error('should not store'); },
    searchLibrary: async ({ query }) => {
      assert.equal(query, 'community hall');
      return { fileRepositoryId: 'fr-lib', url: LIB_URL };
    },
  });
  assert.equal(generated, 0);
  assert.equal(out.results[0].source, 'library');
  assert.equal(out.doc.assets[0].fulfilment.source, 'library');
});

test('resolveV2AssetRequests: per-asset failure isolation keeps the brief for retry', async () => {
  const doc = makeDoc({
    html: '<img data-ai-asset="a" alt="x"><img data-ai-asset="b" alt="y">',
    assets: [req({ key: 'a' }), req({ key: 'b', subject: 'A quiet library reading room' })],
  });
  const out = await resolveV2AssetRequests({
    doc,
    generateImage: async ({ prompt }) => {
      if (prompt.includes('hall')) throw new Error('provider down');
      return { buffer: Buffer.alloc(1) };
    },
    storeAsset: async () => ({ fileRepositoryId: 'fr', url: LIB_URL }),
  });
  const a = out.doc.assets.find((x) => x.key === 'a');
  assert.equal(a.fulfilment.status, 'failed');
  assert.equal(a.subject, req().subject); // brief kept for retry
  // failed asset is pending again on the next pass
  assert.deepEqual(collectPendingAssetRequests(out.doc).map((x) => x.key), ['a']);
});

test('resolveV2AssetRequests: deadline defers remaining requests for resume', async () => {
  const doc = makeDoc({
    html: '<img data-ai-asset="a" alt="x"><img data-ai-asset="b" alt="y">',
    assets: [req({ key: 'a' }), req({ key: 'b' })],
  });
  const out = await resolveV2AssetRequests({
    doc,
    deadline: Date.now() - 1, // already past — but at least ONE runs
    generateImage: async () => ({ buffer: Buffer.alloc(1) }),
    storeAsset: async () => ({ fileRepositoryId: 'fr', url: LIB_URL }),
  });
  assert.equal(out.results.length, 1);
  assert.equal(out.remaining, 1);
});

// ---------------------------------------------------------------------------
// replaceImageSource (Phase 4 edit flow)
// ---------------------------------------------------------------------------

test('replaceImageSource: swaps src by data-ai-id, preserves layout markup', () => {
  const doc = makeDoc({
    html: '<section><img data-ai-id="i1" data-ai-asset="hero" src="https://old/img.png" alt="Old"><p data-ai-id="p1">Text</p></section>',
    assets: [req({ fulfilment: { status: 'ready', url: 'https://old/img.png' } })],
  });
  const out = replaceImageSource(doc, 'i1', { url: LIB_URL, alt: 'New alt' });
  assert.equal(out.ok, true);
  assert.equal(out.previousUrl, 'https://old/img.png');
  assert.equal(out.assetKey, 'hero');
  assert.match(out.doc.html, /hero\.png/);
  assert.match(out.doc.html, /alt="New alt"/);
  // surrounding layout untouched
  assert.match(out.doc.html, /<p data-ai-id="p1">Text<\/p>/);
  // manifest fulfilment follows the replacement
  assert.equal(out.doc.assets[0].fulfilment.url, LIB_URL);
  // input never mutated
  assert.match(doc.html, /https:\/\/old\/img\.png/);
});

test('replaceImageSource: unknown id or non-img target fails without changes', () => {
  const doc = makeDoc({ html: '<p data-ai-id="p1">Text</p>', assets: [] });
  assert.equal(replaceImageSource(doc, 'missing', { url: LIB_URL }).ok, false);
  assert.equal(replaceImageSource(doc, 'p1', { url: LIB_URL }).ok, false);
});

// ---------------------------------------------------------------------------
// prompt building
// ---------------------------------------------------------------------------

test('buildV2AssetPrompt: subject + brand reach the provider prompt', () => {
  const p = buildV2AssetPrompt(req({ style: 'warm documentary photography' }), { name: 'BNMS', primaryColor: '#123456' });
  assert.match(p, /community hall/);
  assert.match(p, /documentary/);
});

// ---------------------------------------------------------------------------
// Sanitiser: Phase 5 img/asset handling + advanced SVG allowlist
// ---------------------------------------------------------------------------

test('sanitiser: src-less asset placeholder <img> survives; asset key reported', () => {
  const out = sanitizeAiCodeHtml('<img data-ai-id="i1" data-ai-asset="hero" alt="x">');
  assert.match(out.html, /data-ai-asset="hero"/);
  assert.deepEqual(out.report.assetKeys, ['hero']);
});

test('sanitiser: data-ai-asset on a non-img element is stripped', () => {
  const out = sanitizeAiCodeHtml('<div data-ai-asset="hero">x</div>');
  assert.doesNotMatch(out.html, /data-ai-asset/);
  assert.deepEqual(out.report.assetKeys, []);
});

test('sanitiser: img src on an allowed host survives; foreign hosts stripped', () => {
  const ok = sanitizeAiCodeHtml(`<img src="${LIB_URL}" alt="x">`, { allowedImageHosts: HOSTS });
  assert.match(ok.html, /hero\.png/);
  const bad = sanitizeAiCodeHtml('<img src="https://evil.example/x.png" alt="x">', { allowedImageHosts: HOSTS });
  assert.doesNotMatch(bad.html, /evil\.example/);
});

test('sanitiser: SVG gradients, masks and clip-paths survive intact', () => {
  const svg = `
    <svg viewBox="0 0 100 100" role="img" aria-label="Chart">
      <defs>
        <linearGradient id="g1"><stop offset="0" stop-color="#123"></stop><stop offset="1" stop-color="#456"></stop></linearGradient>
        <radialGradient id="g2"><stop offset="1" stop-color="#789"></stop></radialGradient>
        <clipPath id="c1"><rect x="0" y="0" width="50" height="50"></rect></clipPath>
        <mask id="m1"><circle cx="50" cy="50" r="40" fill="#fff"></circle></mask>
        <pattern id="p1" width="4" height="4"><rect width="2" height="2"></rect></pattern>
      </defs>
      <rect width="100" height="100" fill="url(#g1)" clip-path="url(#c1)" mask="url(#m1)"></rect>
      <circle cx="20" cy="20" r="10" fill="url(#g2)"></circle>
    </svg>`;
  const out = sanitizeAiCodeHtml(svg);
  for (const bit of ['linearGradient', 'radialGradient', 'clipPath', 'mask', 'pattern', 'url(#g1)', 'url(#c1)', 'url(#m1)']) {
    assert.ok(out.html.includes(bit), `expected ${bit} to survive`);
  }
});

test('sanitiser: SVG external refs, raster <image> and scripts are rejected', () => {
  const svg = `
    <svg>
      <script>alert(1)</script>
      <image href="https://evil.example/x.png"></image>
      <use href="https://evil.example/sprite.svg#icon"></use>
      <rect fill="url(https://evil.example/f.svg#g)"></rect>
      <animate attributeName="x"></animate>
    </svg>`;
  const out = sanitizeAiCodeHtml(svg);
  assert.doesNotMatch(out.html, /script|<image|evil\.example|animate/);
  // internal <use> fragments stay allowed
  const local = sanitizeAiCodeHtml('<svg><defs><symbol id="s"><rect width="1" height="1"></rect></symbol></defs><use href="#s"></use></svg>');
  assert.match(local.html, /use href="#s"/);
});

// ---------------------------------------------------------------------------
// updateImagePresentation — focal point & crop as merge operations
// ---------------------------------------------------------------------------

const IMG_HTML = `<section><img data-ai-id="img-1" data-ai-asset="hero" src="${LIB_URL}" alt="Volunteers"></section>`;

test('updateImagePresentation: sets a focal point as a scoped CSS rule, html untouched', async () => {
  const { updateImagePresentation } = await import('./aiCodeAssets.js');
  const doc = makeDoc({ html: IMG_HTML, assets: [req()] });
  const r = updateImagePresentation(doc, 'img-1', { focalPoint: { x: 30, y: 70 } });
  assert.equal(r.ok, true);
  assert.equal(r.doc.html, doc.html); // layout markup never touched
  assert.match(r.doc.css, /img\[data-ai-id="img-1"\]/);
  assert.match(r.doc.css, /object-fit: cover/);
  assert.match(r.doc.css, /object-position: 30% 70%/);
  const entry = r.doc.assets.find((a) => a.key === 'hero');
  assert.deepEqual(entry.focalPoint, { x: 30, y: 70 });
  // original doc not mutated
  assert.equal(doc.css, '');
  assert.equal(doc.assets[0].focalPoint, undefined);
});

test('updateImagePresentation: crop uses CSS aspect-ratio format "16 / 9" and rejects "16:9"', async () => {
  const { updateImagePresentation } = await import('./aiCodeAssets.js');
  const doc = makeDoc({ html: IMG_HTML, assets: [req()] });
  const ok = updateImagePresentation(doc, 'img-1', { crop: { aspectRatio: '16 / 9' } });
  assert.equal(ok.ok, true);
  assert.match(ok.doc.css, /aspect-ratio: 16 \/ 9/);
  assert.deepEqual(ok.doc.assets[0].crop, { aspectRatio: '16 / 9' });
  const bad = updateImagePresentation(doc, 'img-1', { crop: { aspectRatio: '16:9' } });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /16 \/ 9/);
});

test('updateImagePresentation: merge semantics — crop never drops focal point (and vice versa), fulfilment preserved', async () => {
  const { updateImagePresentation } = await import('./aiCodeAssets.js');
  const fulfilment = { status: 'ready', url: LIB_URL, source: 'generated', fileRepositoryId: 'f-1' };
  const doc = makeDoc({ html: IMG_HTML, assets: [req({ fulfilment })] });
  const step1 = updateImagePresentation(doc, 'img-1', { focalPoint: { x: 25, y: 40 } });
  const step2 = updateImagePresentation(step1.doc, 'img-1', { crop: { aspectRatio: '4 / 3' } });
  assert.equal(step2.ok, true);
  const entry = step2.doc.assets.find((a) => a.key === 'hero');
  assert.deepEqual(entry.focalPoint, { x: 25, y: 40 }); // preserved
  assert.deepEqual(entry.crop, { aspectRatio: '4 / 3' });
  assert.deepEqual(entry.fulfilment, fulfilment); // never dropped
  // both live in ONE rewritten rule — no accumulation of stale blocks
  assert.match(step2.doc.css, /object-position: 25% 40%/);
  assert.match(step2.doc.css, /aspect-ratio: 4 \/ 3/);
  assert.equal(step2.doc.css.match(/aic-presentation:img-1 \*\//g).length, 2); // start+end markers once
});

test('updateImagePresentation: null clears a field; clearing both removes the CSS block', async () => {
  const { updateImagePresentation } = await import('./aiCodeAssets.js');
  const doc = makeDoc({ html: IMG_HTML, assets: [req()] });
  const set = updateImagePresentation(doc, 'img-1', { focalPoint: { x: 10, y: 10 }, crop: { aspectRatio: '1 / 1' } });
  const clearCrop = updateImagePresentation(set.doc, 'img-1', { crop: null });
  assert.equal(clearCrop.ok, true);
  assert.doesNotMatch(clearCrop.doc.css, /aspect-ratio/);
  assert.match(clearCrop.doc.css, /object-position: 10% 10%/);
  const clearAll = updateImagePresentation(clearCrop.doc, 'img-1', { focalPoint: null });
  assert.doesNotMatch(clearAll.doc.css, /aic-presentation/);
  assert.equal(clearAll.doc.assets[0].focalPoint, undefined);
  assert.equal(clearAll.doc.assets[0].crop, undefined);
});

test('updateImagePresentation: rejects bad focal points, unknown ids, empty changes', async () => {
  const { updateImagePresentation } = await import('./aiCodeAssets.js');
  const doc = makeDoc({ html: IMG_HTML, assets: [req()] });
  assert.equal(updateImagePresentation(doc, 'img-1', { focalPoint: { x: 'a', y: 5 } }).ok, false);
  assert.equal(updateImagePresentation(doc, 'nope', { focalPoint: { x: 5, y: 5 } }).ok, false);
  assert.equal(updateImagePresentation(doc, 'img-1', {}).ok, false);
  // values are clamped into 0–100
  const clamped = updateImagePresentation(doc, 'img-1', { focalPoint: { x: -10, y: 250 } });
  assert.deepEqual(clamped.doc.assets[0].focalPoint, { x: 0, y: 100 });
});

test('validateAssetRequests: focalPoint and crop round-trip re-validation like fulfilment', () => {
  const r = validateAssetRequests([req({
    focalPoint: { x: 33.33, y: 66.67 },
    crop: { aspectRatio: '16/9' },
    fulfilment: { status: 'ready', url: LIB_URL },
  })]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.assets[0].focalPoint, { x: 33.3, y: 66.7 });
  assert.deepEqual(r.assets[0].crop, { aspectRatio: '16 / 9' }); // normalised spacing
  // invalid values are dropped, not fatal (model may not emit them at all)
  const bad = validateAssetRequests([req({ focalPoint: { x: 'l' }, crop: { aspectRatio: '16:9' } })]);
  assert.equal(bad.ok, true);
  assert.equal(bad.assets[0].focalPoint, undefined);
  assert.equal(bad.assets[0].crop, undefined);
});
