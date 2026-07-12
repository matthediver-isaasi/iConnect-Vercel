// Tests for the canvas auto reading-order helpers (Task #2723).
//
// Covers the pure ordering logic in canvasA11y.js:
//   - sortChildrenByVisualOrder  (top-to-bottom, then left-to-right)
//   - readingOrderMatchesVisual  (no-op detector)
//   - autoOrderChildren          (reorder with zero visual change)
//   - computeReadingOrder        (pure document order; raw tabindex retired)
//
// Run: node --test client/src/lib/canvasA11y.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sortChildrenByVisualOrder,
  readingOrderMatchesVisual,
  autoOrderChildren,
  computeReadingOrder,
  isInteractiveBlock,
} from './canvasA11y.js';

import { BLOCK_TYPES } from './canvasDesign.js';

// A minimal absolutely-positioned block. `type` defaults to TEXT so it is not
// treated as full-width (which would flatten x to 0 in resolveBlockAtBreakpoint).
function mk(id, x, y, { z, type = BLOCK_TYPES.TEXT } = {}) {
  const block = {
    id,
    type,
    bp: { desktop: { x, y, w: 100, h: 50, hidden: false } },
  };
  if (z !== undefined) block.style = { zIndex: z };
  return block;
}

const ids = (arr) => arr.map((b) => b.id);
const zOf = (block) => block?.style?.zIndex;

test('sortChildrenByVisualOrder: top-to-bottom then left-to-right', () => {
  // Authored (document) order is scrambled relative to the visual layout.
  const a = mk('a', 300, 200); // bottom
  const b = mk('b', 10, 10);   // top-left
  const c = mk('c', 200, 10);  // top-right (same row as b)
  const sorted = sortChildrenByVisualOrder([a, b, c]);
  assert.deepEqual(ids(sorted), ['b', 'c', 'a']);
});

test('sortChildrenByVisualOrder: ties on (y,x) keep original order (stable)', () => {
  const a = mk('a', 50, 50);
  const b = mk('b', 50, 50); // identical geometry
  assert.deepEqual(ids(sortChildrenByVisualOrder([a, b])), ['a', 'b']);
  assert.deepEqual(ids(sortChildrenByVisualOrder([b, a])), ['b', 'a']);
});

test('readingOrderMatchesVisual: true when already in visual order', () => {
  const children = [mk('a', 10, 10), mk('b', 10, 100), mk('c', 10, 200)];
  assert.equal(readingOrderMatchesVisual(children), true);
});

test('readingOrderMatchesVisual: false when out of order', () => {
  const children = [mk('a', 10, 200), mk('b', 10, 10)];
  assert.equal(readingOrderMatchesVisual(children), false);
});

test('computeReadingOrder: pure copy of document order (tabindex retired)', () => {
  const children = [mk('a', 10, 200), mk('b', 10, 10)];
  const out = computeReadingOrder(children);
  assert.deepEqual(ids(out), ['a', 'b']);
  assert.notEqual(out, children); // new array reference
});

test('autoOrderChildren: reorders to visual order', () => {
  const a = mk('a', 300, 200);
  const b = mk('b', 10, 10);
  const c = mk('c', 200, 10);
  const out = autoOrderChildren([a, b, c]);
  assert.deepEqual(ids(out), ['b', 'c', 'a']);
});

test('autoOrderChildren: no-op (same contents) when already ordered', () => {
  const children = [mk('a', 10, 10), mk('b', 10, 100)];
  const out = autoOrderChildren(children);
  assert.deepEqual(ids(out), ['a', 'b']);
  // Blocks are untouched (no spurious zIndex writes).
  assert.equal(zOf(out[0]), undefined);
  assert.equal(zOf(out[1]), undefined);
});

test('autoOrderChildren: idempotent', () => {
  const a = mk('a', 300, 200);
  const b = mk('b', 10, 10);
  const c = mk('c', 200, 10);
  const once = autoOrderChildren([a, b, c]);
  const twice = autoOrderChildren(once);
  assert.deepEqual(ids(twice), ids(once));
});

test('autoOrderChildren: empty / single-child inputs are safe', () => {
  assert.deepEqual(autoOrderChildren([]), []);
  const one = [mk('a', 0, 0)];
  assert.deepEqual(ids(autoOrderChildren(one)), ['a']);
});

test('autoOrderChildren: preserves stacking when reorder would swap paint order', () => {
  // Two overlapping blocks with the SAME z-index. Document order currently
  // paints `top` last (on top). Visually `bottom` comes first (lower y), so a
  // naive reorder would flip which one paints on top. Auto-order must pin
  // z-index to preserve the original stacking.
  const top = mk('top', 10, 10, { z: 1 });     // visually first (y=10)
  const bottom = mk('bottom', 12, 12, { z: 1 }); // overlaps, painted on top now
  // Document order: bottom is LAST => currently paints on top.
  const input = [top, bottom];
  // Visual order would be [top, bottom] (top has lower y) — same as document
  // order here, so it's already a no-op. Rearrange so it isn't:
  const t2 = mk('t2', 300, 300, { z: 1 }); // visually last
  const b2 = mk('b2', 10, 10, { z: 1 });   // visually first, painted UNDER t2
  // Document order [t2, b2]: t2 painted first (under), b2 painted on top.
  const out = autoOrderChildren([t2, b2]);
  // Visual order is [b2, t2]. In the new document order b2 is first, so with
  // equal z it would paint UNDER t2 — flipping stacking. Auto-order must pin
  // z so b2 still paints on top.
  assert.deepEqual(ids(out), ['b2', 't2']);
  const outB2 = out.find((x) => x.id === 'b2');
  const outT2 = out.find((x) => x.id === 't2');
  // b2 originally painted on top → must keep a higher effective z than t2.
  assert.ok((zOf(outB2) ?? 1) > (zOf(outT2) ?? 1),
    'the block that was on top must still have the higher z-index');
});

test('autoOrderChildren: leaves z-index untouched when explicit z already encodes stacking', () => {
  // Distinct z-indexes already fully determine paint order, so the new document
  // order cannot change what paints on top — no z-index should be rewritten.
  const a = mk('a', 10, 300, { z: 5 }); // visually last, painted on top
  const b = mk('b', 10, 10, { z: 1 });  // visually first, painted underneath
  const out = autoOrderChildren([a, b]);
  assert.deepEqual(ids(out), ['b', 'a']);
  assert.equal(zOf(out.find((x) => x.id === 'a')), 5);
  assert.equal(zOf(out.find((x) => x.id === 'b')), 1);
});

test('autoOrderChildren: is pure (never mutates input blocks)', () => {
  const a = mk('a', 300, 200, { z: 1 });
  const b = mk('b', 10, 10, { z: 1 });
  const before = JSON.stringify([a, b]);
  autoOrderChildren([a, b]);
  assert.equal(JSON.stringify([a, b]), before);
});

test('isInteractiveBlock: buttons/forms interactive, containers are not', () => {
  assert.equal(isInteractiveBlock(mk('x', 0, 0, { type: BLOCK_TYPES.BUTTON })), true);
  assert.equal(isInteractiveBlock(mk('x', 0, 0, { type: BLOCK_TYPES.TEXT })), false);
  // A plain image is not interactive; a linked image is.
  const img = mk('x', 0, 0, { type: BLOCK_TYPES.IMAGE });
  assert.equal(isInteractiveBlock(img), false);
  img.content = { href: 'https://example.com' };
  assert.equal(isInteractiveBlock(img), true);
});
