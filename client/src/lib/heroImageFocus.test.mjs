import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getHeroImageFocusStyle,
  getHeroThumbnailBackgroundStyle,
  normalizeHeroImageFocus,
  resolveHeroImageFocus,
} from './heroImageFocus.js';

test('legacy Hero backgrounds default their focus to the centre', () => {
  assert.deepEqual(normalizeHeroImageFocus(), { x: 50, y: 50 });
  assert.deepEqual(resolveHeroImageFocus({}), { x: 50, y: 50 });
  assert.deepEqual(getHeroImageFocusStyle('cover'), { objectPosition: '50% 50%' });
});

test('same-as-desktop mobile background inherits the desktop focus', () => {
  const content = {
    image_focal_point: { x: 18, y: 74 },
    mobile_background_type: 'same',
    mobile_image_focal_point: { x: 91, y: 9 },
  };

  assert.deepEqual(resolveHeroImageFocus(content), { x: 18, y: 74 });
  assert.deepEqual(resolveHeroImageFocus(content, { mobile: true }), { x: 18, y: 74 });
});

test('custom mobile image uses its own focus point', () => {
  const content = {
    image_focal_point: { x: 18, y: 74 },
    mobile_background_type: 'image',
    mobile_image_focal_point: { x: 82, y: 28 },
  };

  assert.deepEqual(resolveHeroImageFocus(content, { mobile: true }), { x: 82, y: 28 });
});

test('focus values are clamped and non-cover images keep their existing appearance', () => {
  assert.deepEqual(normalizeHeroImageFocus({ x: -2, y: 190 }), { x: 0, y: 100 });
  assert.deepEqual(getHeroImageFocusStyle('contain', { x: 20, y: 80 }), {});
});

test('banner thumbnails match cover focus and contain scaling', () => {
  assert.deepEqual(
    getHeroThumbnailBackgroundStyle('/hero.jpg', 'cover', { x: 20, y: 80 }),
    {
      backgroundImage: 'url(/hero.jpg)',
      backgroundSize: 'cover',
      backgroundPosition: '20% 80%',
      backgroundRepeat: 'no-repeat',
    }
  );
  assert.deepEqual(
    getHeroThumbnailBackgroundStyle('/hero.jpg', 'contain', { x: 20, y: 80 }),
    {
      backgroundImage: 'url(/hero.jpg)',
      backgroundSize: 'contain',
      backgroundPosition: '50% 50%',
      backgroundRepeat: 'no-repeat',
    }
  );
});