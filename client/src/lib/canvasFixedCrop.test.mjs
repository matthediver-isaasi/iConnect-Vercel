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
