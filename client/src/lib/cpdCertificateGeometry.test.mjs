import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateFitScale,
  clientDeltaToPoints,
  moveBox,
  normalizeBox,
  pointsToPixels,
  resizeBox,
  resizeImageBox, imageAspectRatio,
} from './cpdCertificateGeometry.js';

test('PDF point and screen geometry round trips at arbitrary zoom', () => {
  assert.equal(pointsToPixels(72, 1.5), 108);
  assert.deepEqual(clientDeltaToPoints(36, -18, 1.5), { x: 24, y: -12 });
});

test('signature numeric resizing and dragging preserve intrinsic aspect and clamp at either page edge at every zoom', () => {
  const page = { width: 600, height: 800 };
  const image = { field_type: 'image', x: 100, y: 100, width: 180, height: 60, image_width: 900, image_height: 300 };
  assert.equal(imageAspectRatio(image), 3);
  const width = resizeImageBox(image, 300, 'width', page);
  assert.equal(width.width, 300);
  assert.equal(width.height, 100);
  const height = resizeImageBox(image, 80, 'height', page);
  assert.equal(height.width, 240);
  assert.equal(height.height, 80);
  for (const scale of [0.5, 1, 2]) {
    for (const [dx, dy] of [[60, 0], [0, 20], [6000, 6000], [-6000, -6000]]) {
      const resized = resizeBox(image, dx * scale, dy * scale, scale, page);
      assert.ok(Math.abs(resized.width / resized.height - 3) < 1e-9);
      assert.ok(resized.x + resized.width <= page.width);
      assert.ok(resized.y + resized.height <= page.height);
      assert.ok(resized.height >= 8);
    }
  }
  const bottom = resizeImageBox({ ...image, y: 780 }, 400, 'width', page);
  assert.equal(bottom.width, 60);
  assert.equal(bottom.height, 20);
});

test('reloaded images fall back to saved box aspect and page changes/moving do not distort images', () => {
  const image = { field_type: 'image', x: 100, y: 700, width: 300, height: 100 };
  assert.equal(imageAspectRatio(image), 3);
  const nextPage = { width: 200, height: 100 };
  const normalized = normalizeBox(image, nextPage);
  assert.equal(normalized.width / normalized.height, 3);
  assert.ok(normalized.x + normalized.width <= nextPage.width);
  assert.ok(normalized.y + normalized.height <= nextPage.height);
  const moved = moveBox(normalized, 1000, 1000, 1.5, nextPage);
  assert.equal(moved.width, normalized.width);
  assert.equal(moved.height, normalized.height);
  assert.equal(resizeImageBox(image, 150, 'width', { width: 600, height: 800 }).height, 50);
});

test('move and resize preserve point geometry and page boundaries', () => {
  const page = { width: 600, height: 800 };
  assert.deepEqual(
    moveBox({ x: 10, y: 20, width: 100, height: 30 }, 40, 20, 2, page),
    { x: 30, y: 30, width: 100, height: 30 },
  );
  assert.deepEqual(
    resizeBox({ x: 550, y: 780, width: 40, height: 20 }, 100, 100, 1, page),
    { x: 550, y: 780, width: 50, height: 20 },
  );
});

test('normalization and fit calculations clamp invalid geometry', () => {
  assert.deepEqual(normalizeBox({ x: -4, y: 900, width: 700, height: 20 }, { width: 600, height: 800 }), {
    x: 0, y: 780, width: 600, height: 20,
  });
  assert.equal(calculateFitScale('fit-width', { width: 900 }, { width: 600 }), 1.5);
  assert.equal(calculateFitScale('fit-page', { width: 900, height: 800 }, { width: 600, height: 800 }), 1);
});

test('portrait and landscape fit the measured inner viewport without changing point coordinates', () => {
  for (const page of [{ width: 612, height: 792 }, { width: 842, height: 595 }]) {
    for (const viewport of [{ width: 1392, height: 720 }, { width: 342, height: 450 }]) {
      const original = { ...page };
      const width = calculateFitScale('fit-width', viewport, page);
      assert.ok(Math.abs(pointsToPixels(page.width, width) - viewport.width) < 0.00001);
      const fit = calculateFitScale('fit-page', viewport, page);
      assert.ok(pointsToPixels(page.width, fit) <= viewport.width + 0.00001);
      assert.ok(pointsToPixels(page.height, fit) <= viewport.height + 0.00001);
      assert.equal(calculateFitScale(2, viewport, page), 2, 'manual zoom is independent of viewport size');
      assert.deepEqual(page, original);
    }
  }
});