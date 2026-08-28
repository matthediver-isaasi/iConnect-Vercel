import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateFitScale,
  clientDeltaToPoints,
  moveBox,
  normalizeBox,
  pointsToPixels,
  resizeBox,
} from './cpdCertificateGeometry.js';

test('PDF point and screen geometry round trips at arbitrary zoom', () => {
  assert.equal(pointsToPixels(72, 1.5), 108);
  assert.deepEqual(clientDeltaToPoints(36, -18, 1.5), { x: 24, y: -12 });
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