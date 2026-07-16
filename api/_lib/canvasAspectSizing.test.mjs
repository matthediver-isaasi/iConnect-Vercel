// Task #2829 — Hero Carousel "Auto (match image)" wrapper sizing.
//
// The public stylesheet used to pin every block wrapper (including aspect-mode
// Hero Carousels) to its stored fixed pixel height, so the carousel never grew
// or shrank with the viewport on published pages. These tests lock in the new
// behaviour: aspect-mode carousels emit `height:auto` + CSS `aspect-ratio`
// (with optional min/max clamps) in the static stylesheet, while every other
// block keeps its fixed geometry height byte-identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_TYPES,
  buildCanvasCss,
  isAspectHeightCarousel,
  resolveAspectReflowReferenceHeight,
  resolveAspectSizingCss,
  resolveAspectSizingStyle,
} from '../../client/src/lib/canvasDesign.js';

const geom = { x: 0, y: 100, w: 1200, h: 500 };

function carouselBlock(content = {}, extra = {}) {
  return {
    id: 'hcc-1',
    type: BLOCK_TYPES.HERO_CAROUSEL,
    content: { height_type: 'aspect', ...content },
    style: {},
    bp: { desktop: { ...geom } },
    ...extra,
  };
}

test('resolveAspectSizingCss: null for non-aspect blocks', () => {
  assert.equal(resolveAspectSizingCss({ id: 'x', type: BLOCK_TYPES.TEXT, content: {}, bp: { desktop: geom } }), null);
  assert.equal(resolveAspectSizingCss(carouselBlock({ height_type: 'custom' })), null);
  assert.equal(resolveAspectSizingCss(carouselBlock({ height_type: 'full' })), null);
  assert.equal(resolveAspectSizingCss(carouselBlock({ height_type: 'auto' })), null);
});

test('resolveAspectSizingCss: stored ratio emits height:auto + aspect-ratio', () => {
  const css = resolveAspectSizingCss(carouselBlock({ aspect_ratio_w: 1600, aspect_ratio_h: 900 }));
  assert.equal(css, 'height:auto;aspect-ratio:1600 / 900;');
});

test('resolveAspectSizingCss: min/max clamps included when > 0, omitted at 0', () => {
  const css = resolveAspectSizingCss(carouselBlock({
    aspect_ratio_w: 4, aspect_ratio_h: 3,
    aspect_min_height: 200, aspect_max_height: 700,
  }));
  assert.equal(css, 'height:auto;aspect-ratio:4 / 3;min-height:200px;max-height:700px;');

  const noClamp = resolveAspectSizingCss(carouselBlock({
    aspect_ratio_w: 4, aspect_ratio_h: 3,
    aspect_min_height: 0, aspect_max_height: 0,
  }));
  assert.equal(noClamp, 'height:auto;aspect-ratio:4 / 3;');
});

test('resolveAspectSizingCss: no stored ratio falls back to a min-height placeholder', () => {
  assert.equal(resolveAspectSizingCss(carouselBlock()), 'height:auto;min-height:400px;');
  assert.equal(
    resolveAspectSizingCss(carouselBlock({ aspect_min_height: 250 })),
    'height:auto;min-height:250px;',
  );
});

test('resolveAspectSizingStyle mirrors the CSS form for inline (forced-breakpoint) use', () => {
  const s = resolveAspectSizingStyle(carouselBlock({
    aspect_ratio_w: 16, aspect_ratio_h: 9, aspect_max_height: 800,
  }));
  assert.deepEqual(s, { height: 'auto', aspectRatio: '16 / 9', minHeight: undefined, maxHeight: 800 });
  assert.equal(resolveAspectSizingStyle({ id: 'x', type: BLOCK_TYPES.IMAGE, content: {}, bp: { desktop: geom } }), null);
});

test('isAspectHeightCarousel gate', () => {
  assert.equal(isAspectHeightCarousel(carouselBlock()), true);
  assert.equal(isAspectHeightCarousel(carouselBlock({ height_type: 'custom' })), false);
});

// Task #2840 — the signed public reflow measures aspect-carousel growth from
// the aspect-DERIVED height at the breakpoint stage width, not the stored
// (possibly stale) geometry height. Real-page regression: mobile hero stored
// h=552 but aspect 744×1228 renders 619px at the 375px stage — the old
// stored-h reference double-counted the 67px mismatch as a constant gap
// below the carousel on every phone width.
test('resolveAspectReflowReferenceHeight: fullBleed mobile carousel uses stage-width aspect height, not stored h', () => {
  const block = {
    id: 'hcc-m',
    type: BLOCK_TYPES.HERO_CAROUSEL_MOBILE,
    content: { height_type: 'aspect', fullBleed: true, aspect_ratio_w: 744, aspect_ratio_h: 1228 },
    style: {},
    bp: { mobile: { x: 0, y: 0, w: 375, h: 552 } },
  };
  const ref = resolveAspectReflowReferenceHeight(block, { x: 0, y: 0, w: 375, h: 552 }, 'mobile');
  assert.equal(ref, Math.round((375 * 1228) / 744)); // 619 — NOT the stored 552
});

test('resolveAspectReflowReferenceHeight: non-fullBleed uses the (stage-clamped) stored width', () => {
  const block = carouselBlock({ aspect_ratio_w: 16, aspect_ratio_h: 9 });
  // Desktop, w=1200 → 675.
  assert.equal(resolveAspectReflowReferenceHeight(block, geom, 'desktop'), 675);
  // Mobile with a desktop-cascaded 1200px-wide frame clamps to the 375 stage.
  assert.equal(
    resolveAspectReflowReferenceHeight(block, { x: 0, y: 0, w: 1200, h: 500 }, 'mobile'),
    Math.round((375 * 9) / 16),
  );
});

test('resolveAspectReflowReferenceHeight: min/max clamps apply to the derived height', () => {
  const block = carouselBlock({
    fullBleed: true,
    aspect_ratio_w: 16,
    aspect_ratio_h: 9,
    aspect_max_height: 500,
  });
  assert.equal(resolveAspectReflowReferenceHeight(block, geom, 'desktop'), 500);
  const minned = carouselBlock({
    fullBleed: true,
    aspect_ratio_w: 16,
    aspect_ratio_h: 9,
    aspect_min_height: 400,
  });
  assert.equal(resolveAspectReflowReferenceHeight(minned, { x: 0, y: 0, w: 375, h: 200 }, 'mobile'), 400);
});

test('resolveAspectReflowReferenceHeight: null for non-aspect blocks and missing ratio (legacy fallback)', () => {
  assert.equal(resolveAspectReflowReferenceHeight(carouselBlock({ height_type: 'custom' }), geom, 'mobile'), null);
  assert.equal(resolveAspectReflowReferenceHeight(carouselBlock(), geom, 'mobile'), null);
  assert.equal(
    resolveAspectReflowReferenceHeight({ id: 'x', type: BLOCK_TYPES.TEXT, content: {}, bp: { desktop: geom } }, geom, 'desktop'),
    null,
  );
});

test('buildCanvasCss: aspect carousel wrapper rule uses auto height, not fixed px', () => {
  const block = carouselBlock({
    fullBleed: true,
    aspect_ratio_w: 1600,
    aspect_ratio_h: 900,
    aspect_max_height: 900,
  });
  const css = buildCanvasCss([block], '#scope');
  const rule = css.split('\n').find((l) => l.includes('[data-cb="hcc-1"]') && l.includes('width:100vw'));
  assert.ok(rule, 'expected a full-bleed rule for the carousel');
  assert.ok(rule.includes('height:auto;'), 'wrapper must be height:auto');
  assert.ok(rule.includes('aspect-ratio:1600 / 900;'), 'wrapper must carry the stored ratio');
  assert.ok(rule.includes('max-height:900px;'), 'max clamp must be present');
  assert.ok(!rule.includes('height:500px'), 'fixed geometry height must not leak through');
});

test('buildCanvasCss: non-aspect carousel keeps the fixed geometry height', () => {
  const block = carouselBlock({ fullBleed: true, height_type: 'custom', custom_height: 500 });
  const css = buildCanvasCss([block], '#scope');
  const rule = css.split('\n').find((l) => l.includes('[data-cb="hcc-1"]') && l.includes('width:100vw'));
  assert.ok(rule, 'expected a full-bleed rule for the carousel');
  assert.ok(rule.includes('height:500px;'), 'fixed height preserved for custom mode');
  assert.ok(!rule.includes('aspect-ratio'), 'no aspect-ratio for custom mode');
});

test('buildCanvasCss: unrelated blocks are byte-identical with and without an aspect carousel present', () => {
  const textBlock = {
    id: 'txt-1',
    type: BLOCK_TYPES.TEXT,
    content: {},
    style: {},
    bp: { desktop: { x: 0, y: 700, w: 600, h: 120 } },
  };
  const withCarousel = buildCanvasCss([carouselBlock({ aspect_ratio_w: 3, aspect_ratio_h: 2 }), textBlock], '#scope');
  const alone = buildCanvasCss([textBlock], '#scope');
  const ruleWith = withCarousel.split('\n').find((l) => l.includes('[data-cb="txt-1"]'));
  const ruleAlone = alone.split('\n').find((l) => l.includes('[data-cb="txt-1"]'));
  assert.ok(ruleWith && ruleAlone);
  assert.equal(ruleWith, ruleAlone);
});
