/**
 * Phase 3 tests — AI Composition images & infographics (Task #2851).
 *
 * Proves:
 *   1. The factual-text rule: statistic/simple_chart/comparison_item may
 *      never carry an asset or imageBrief, and image prompts forbid text
 *      unless a digit-free decorative overlay was authorised.
 *   2. Per-asset failure isolation: one failed generation flags only that
 *      element (asset.status='failed', brief kept for retry) and the run
 *      continues.
 *   3. Alt-text workflow: every resolved image without alt text (and every
 *      failed asset) is flagged — never silently ignored.
 *   4. Deterministic replace/crop/focal patches merge into the current asset
 *      so the underlying fileRepositoryId is never dropped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectImageBriefs,
  buildImagePrompt,
  resolveCompositionAssets,
  collectAltTextFlags,
  buildAssetMergeOp,
  normalizeAspect,
  ASPECT_SIZES,
} from './aiCompositionImages.js';
import { validateComposition, validateImageBrief } from './aiCompositionSchema.js';
import { applyPatch } from './aiCompositionPatch.js';
import { SECTION_EXAMPLE } from './aiCompositionExamples.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));

function docWithImages() {
  const doc = clone(SECTION_EXAMPLE);
  const section = doc.sections[0];
  const img1 = {
    id: 'img_hero', type: 'image',
    imageBrief: { subject: 'members networking at a conference', aspectRatio: 'landscape', accessibilityDescription: 'Members talking at an event' },
  };
  const img2 = {
    id: 'img_side', type: 'generated_illustration',
    imageBrief: { subject: 'abstract growth arrows', aspectRatio: 'square' },
  };
  section.elements.push(img1, img2);
  section.readingOrder.push('img_hero', 'img_side');
  doc.layouts.desktop.img_hero = { x: 0, y: 900, w: 600, h: 300 };
  doc.layouts.desktop.img_side = { x: 620, y: 900, w: 300, h: 300 };
  return doc;
}

// ---------------------------------------------------------------------------
// 1. Factual-text rule
// ---------------------------------------------------------------------------

test('factual element types reject assets and image briefs', () => {
  for (const type of ['statistic', 'simple_chart', 'comparison_item']) {
    const doc = docWithImages();
    doc.sections[0].elements.push({
      id: 'fact_1', type,
      data: { value: '85%', label: 'Renewal rate', items: [{ label: 'A', value: 1 }] },
      imageBrief: { subject: 'a chart showing 85%' },
    });
    doc.sections[0].readingOrder.push('fact_1');
    doc.layouts.desktop.fact_1 = { x: 0, y: 1300, w: 200, h: 100 };
    const result = validateComposition(doc);
    assert.equal(result.ok, false, `${type} with imageBrief must be rejected`);
    assert.ok(result.errors.some((e) => e.includes('factual')));
  }
});

test('factual element with structured data (no imagery) validates', () => {
  const doc = docWithImages();
  doc.sections[0].elements.push({
    id: 'fact_ok', type: 'statistic', data: { value: '85%', label: 'Renewal rate' },
  });
  doc.sections[0].readingOrder.push('fact_ok');
  doc.layouts.desktop.fact_ok = { x: 0, y: 1300, w: 200, h: 100 };
  const result = validateComposition(doc);
  assert.deepEqual(result.errors, []);
});

test('imageBrief textOverlay may not contain digits (facts stay HTML text)', () => {
  const errors = [];
  validateImageBrief({ subject: 'x', textOverlay: 'Save 25% today' }, 'el', errors);
  assert.ok(errors.length > 0);

  const ok = [];
  validateImageBrief({ subject: 'x', textOverlay: 'Join us' }, 'el', ok);
  assert.deepEqual(ok, []);
});

test('prompt forbids embedded text unless a decorative overlay is authorised', () => {
  const noOverlay = buildImagePrompt({ subject: 'a skyline' }, null, 'image');
  assert.ok(/No text, letters, numbers/.test(noOverlay));
  const withOverlay = buildImagePrompt({ subject: 'a skyline', textOverlay: 'Welcome' }, null, 'image');
  assert.ok(withOverlay.includes('"Welcome"'));
  assert.ok(!/No text, letters, numbers/.test(withOverlay));
});

test('prompt weaves in brand palette and illustration style', () => {
  const p = buildImagePrompt({ subject: 'teamwork' }, { primaryColor: '#123456', secondaryColor: '#abcdef' }, 'generated_illustration');
  assert.ok(p.includes('#123456'));
  assert.ok(p.includes('illustration'));
});

// ---------------------------------------------------------------------------
// 2. Per-asset failure isolation
// ---------------------------------------------------------------------------

test('one failed generation flags only that element and keeps its brief', async () => {
  const doc = docWithImages();
  const generateImage = async ({ prompt }) => {
    if (prompt.includes('networking')) throw new Error('provider exploded');
    return { buffer: Buffer.from('png'), model: 'test-model' };
  };
  let stored = 0;
  const storeAsset = async ({ elementId }) => {
    stored += 1;
    return { fileRepositoryId: `file_${elementId}`, url: `https://cdn/x/${elementId}.png` };
  };
  const { doc: next, results } = await resolveCompositionAssets({ doc, generateImage, storeAsset });

  assert.equal(results.length, 2);
  const failed = results.find((r) => r.elementId === 'img_hero');
  const okRes = results.find((r) => r.elementId === 'img_side');
  assert.equal(failed.ok, false);
  assert.equal(okRes.ok, true);
  assert.equal(stored, 1);

  const els = Object.fromEntries(next.sections[0].elements.map((e) => [e.id, e]));
  assert.deepEqual(els.img_hero.asset, { status: 'failed' });
  assert.ok(els.img_hero.imageBrief, 'brief kept for retry');
  assert.equal(els.img_side.asset.status, 'ready');
  assert.equal(els.img_side.asset.fileRepositoryId, 'file_img_side');
  // Input document is never mutated.
  assert.equal(doc.sections[0].elements.find((e) => e.id === 'img_side').asset, undefined);
  // The partially-imaged document still validates (failed asset allowed).
  assert.deepEqual(validateComposition(next).errors, []);
});

test('failed elements are re-collected for retry; resolved ones are not', async () => {
  const doc = docWithImages();
  const { doc: next } = await resolveCompositionAssets({
    doc,
    generateImage: async ({ prompt }) => {
      if (prompt.includes('networking')) throw new Error('boom');
      return { buffer: Buffer.from('x'), model: 'm' };
    },
    storeAsset: async ({ elementId }) => ({ fileRepositoryId: `f_${elementId}`, url: 'https://cdn/a.png' }),
  });
  const remaining = collectImageBriefs(next);
  assert.deepEqual(remaining.map((b) => b.elementId), ['img_hero']);
});

// ---------------------------------------------------------------------------
// 3. Alt-text workflow
// ---------------------------------------------------------------------------

test('alt-text flags: missing alt text and failed generations are both flagged', async () => {
  const doc = docWithImages();
  const { doc: next } = await resolveCompositionAssets({
    doc,
    generateImage: async ({ prompt }) => {
      if (prompt.includes('growth arrows')) throw new Error('boom');
      return { buffer: Buffer.from('x'), model: 'm' };
    },
    storeAsset: async ({ elementId }) => ({ fileRepositoryId: `f_${elementId}`, url: 'https://cdn/a.png' }),
  });
  const flags = collectAltTextFlags(next);
  // img_hero resolved WITH accessibilityDescription → no flag for it.
  assert.deepEqual(flags, [{ elementId: 'img_side', reason: 'generation_failed' }]);

  // Strip the alt text → flagged as missing.
  const el = next.sections[0].elements.find((e) => e.id === 'img_hero');
  el.asset.altText = '';
  assert.deepEqual(collectAltTextFlags(next), [
    { elementId: 'img_hero', reason: 'missing_alt_text' },
    { elementId: 'img_side', reason: 'generation_failed' },
  ]);
});

// ---------------------------------------------------------------------------
// 4. Deterministic asset patches
// ---------------------------------------------------------------------------

test('crop/focal merge ops keep the underlying fileRepositoryId', async () => {
  const doc = docWithImages();
  const { doc: resolved } = await resolveCompositionAssets({
    doc,
    generateImage: async () => ({ buffer: Buffer.from('x'), model: 'm' }),
    storeAsset: async ({ elementId }) => ({ fileRepositoryId: `f_${elementId}`, url: `https://cdn/${elementId}.png` }),
  });
  const focalOp = buildAssetMergeOp(resolved, 'img_hero', { focalPoint: { x: 30, y: 60 } });
  const afterFocal = applyPatch(resolved, [focalOp]);
  assert.equal(afterFocal.ok, true, JSON.stringify(afterFocal.errors));
  const el1 = afterFocal.doc.sections[0].elements.find((e) => e.id === 'img_hero');
  assert.equal(el1.asset.fileRepositoryId, 'f_img_hero');
  assert.deepEqual(el1.asset.focalPoint, { x: 30, y: 60 });

  const cropOp = buildAssetMergeOp(afterFocal.doc, 'img_hero', { crop: { aspectRatio: '16 / 9' } });
  const afterCrop = applyPatch(afterFocal.doc, [cropOp]);
  assert.equal(afterCrop.ok, true, JSON.stringify(afterCrop.errors));
  const el2 = afterCrop.doc.sections[0].elements.find((e) => e.id === 'img_hero');
  assert.equal(el2.asset.fileRepositoryId, 'f_img_hero');
  assert.deepEqual(el2.asset.focalPoint, { x: 30, y: 60 }, 'crop keeps earlier focal point');
  assert.deepEqual(el2.asset.crop, { aspectRatio: '16 / 9' });
  assert.deepEqual(validateComposition(afterCrop.doc).errors, []);
});

test('aspect helpers normalise unknown values and map to provider sizes', () => {
  assert.equal(normalizeAspect('banana'), 'landscape');
  assert.equal(normalizeAspect('portrait'), 'portrait');
  assert.equal(ASPECT_SIZES[normalizeAspect(undefined)], '1536x1024');
});
