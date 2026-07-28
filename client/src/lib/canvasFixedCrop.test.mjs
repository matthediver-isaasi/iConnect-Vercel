// Fixed Height / Horizontal Crop image fit (Task #3159).
//
// The shared recipe: an overflow-hidden clipping box + an <img> sized by
// height only (width:auto) anchored on the focal x via left/translateX. These
// tests pin the helper's contract so every render surface (v1 stage, v1
// public, v2 flow, section backgrounds) stays consistent.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_FIT_FIXED_CROP,
  isFixedCropFit,
  buildFixedCropImgStyle,
  buildBgMirrorTransform,
} from './canvasBackground.js';

test('isFixedCropFit: only the fixed-crop token matches', () => {
  assert.equal(isFixedCropFit(IMAGE_FIT_FIXED_CROP), true);
  assert.equal(isFixedCropFit('fixed-crop'), true);
  for (const v of ['cover', 'contain', 'fill', 'none', 'scale-down', '', undefined, null]) {
    assert.equal(isFixedCropFit(v), false, `expected ${String(v)} to not be fixed-crop`);
  }
});

test('buildFixedCropImgStyle: height-driven sizing, never width-driven', () => {
  const s = buildFixedCropImgStyle(50);
  assert.equal(s.height, '100%');
  assert.equal(s.width, 'auto');
  // Must defeat any inherited max-width/max-height clamps (e.g. img{max-width:100%}).
  assert.equal(s.maxWidth, 'none');
  assert.equal(s.maxHeight, 'none');
  assert.equal(s.position, 'absolute');
  assert.equal(s.top, 0);
  assert.equal(s.bottom, 0);
});

test('buildFixedCropImgStyle: focal x anchors via matching left/translate pair', () => {
  assert.deepEqual(
    [buildFixedCropImgStyle(30).left, buildFixedCropImgStyle(30).transform],
    ['30%', 'translateX(-30%)'],
  );
  // Default and invalid focal values centre the crop.
  for (const fx of [undefined, null, NaN, 'nope']) {
    const s = buildFixedCropImgStyle(fx);
    assert.equal(s.left, '50%');
    assert.equal(s.transform, 'translateX(-50%)');
  }
  // Out-of-range values clamp.
  assert.equal(buildFixedCropImgStyle(150).left, '100%');
  assert.equal(buildFixedCropImgStyle(-20).left, '0%');
});

// --- Mirror flips (Task #3164) -------------------------------------------

test('buildBgMirrorTransform: all four flip combinations, strict-true only', () => {
  assert.equal(buildBgMirrorTransform(false, false), '');
  assert.equal(buildBgMirrorTransform(true, false), 'scaleX(-1)');
  assert.equal(buildBgMirrorTransform(false, true), 'scaleY(-1)');
  assert.equal(buildBgMirrorTransform(true, true), 'scaleX(-1) scaleY(-1)');
  // Truthy-but-not-true values (legacy/garbage data) must NOT flip.
  assert.equal(buildBgMirrorTransform(1, 'yes'), '');
  assert.equal(buildBgMirrorTransform(undefined, null), '');
});

test('buildFixedCropImgStyle: no opts / empty opts stay byte-identical to legacy', () => {
  const legacy = buildFixedCropImgStyle(30);
  assert.deepEqual(buildFixedCropImgStyle(30, {}), legacy);
  assert.deepEqual(buildFixedCropImgStyle(30, { mirrorX: false, mirrorY: false }), legacy);
  assert.equal(legacy.transform, 'translateX(-30%)');
  assert.equal(legacy.left, '30%');
});

test('buildFixedCropImgStyle: mirrorX flips the anchor so the framed slice is preserved', () => {
  // Focal 30 on the original image sits at 70% of the flipped image, so the
  // anchor must become 70% or the crop would slide to the wrong side.
  const s = buildFixedCropImgStyle(30, { mirrorX: true });
  assert.equal(s.left, '70%');
  assert.equal(s.transform, 'translateX(-70%) scaleX(-1)');
  // Centre stays centre when flipped.
  const c = buildFixedCropImgStyle(undefined, { mirrorX: true });
  assert.equal(c.left, '50%');
  assert.equal(c.transform, 'translateX(-50%) scaleX(-1)');
});

test('buildFixedCropImgStyle: mirrorY never touches the horizontal anchor', () => {
  const s = buildFixedCropImgStyle(30, { mirrorY: true });
  assert.equal(s.left, '30%');
  assert.equal(s.transform, 'translateX(-30%) scaleY(-1)');
});

test('buildFixedCropImgStyle: both mirrors compose translate → scaleX → scaleY', () => {
  const s = buildFixedCropImgStyle(20, { mirrorX: true, mirrorY: true });
  assert.equal(s.left, '80%');
  assert.equal(s.transform, 'translateX(-80%) scaleX(-1) scaleY(-1)');
  // Height-driven sizing contract is unchanged by mirroring.
  assert.equal(s.height, '100%');
  assert.equal(s.width, 'auto');
  assert.equal(s.maxWidth, 'none');
});
