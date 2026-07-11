// Regression coverage for the auto-height bake corruption guard (Task #2637):
// a transient too-short measurement must never collapse the page and autosave
// over the good version, while a genuine large deletion still commits, cards
// are never baked, and the atomic bake pushes blocks below + grows the
// containing section. The pure decision logic lives in ./autoHeightBake.js so
// it is testable without a DOM. Run with:
//   node --test client/src/components/canvas/autoHeightBake.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK_TYPES, resolveBlockAtBreakpoint } from '../../lib/canvasDesign.js';
import {
  planAutoHeightBake,
  autoHeightDebounceDelay,
  isSuspectShrink,
  readStoredHeightAtBp,
  readStoredWidthAtBp,
  planAutoSizeBake,
  autoSizeDebounceDelay,
  SHRINK_SUSPECT_PX,
  SHRINK_DEBOUNCE_MS,
  AUTOHEIGHT_DEBOUNCE_MS,
  AUTOHEIGHT_DEAD_BAND_PX,
} from './autoHeightBake.js';

// --- helpers -------------------------------------------------------------

const block = (id, type, { x = 0, y = 0, w = 600, h = 100, hidden = false } = {}) => ({
  id,
  type,
  bp: { desktop: { x, y, w, h, hidden } },
});

const design = (children) => ({
  version: 1,
  root: { sections: [{ id: 'root', children }] },
});

// Fake registry lookup — only the two flags the bake decision reads.
const DEFS = {
  [BLOCK_TYPES.TEXT]: { autoHeight: true },
  [BLOCK_TYPES.ACCORDION]: { autoHeight: true },
  [BLOCK_TYPES.CARD]: { autoHeight: true, cardGrow: true },
  [BLOCK_TYPES.BUTTON]: { autoSize: true },
  [BLOCK_TYPES.SECTION]: {},
  [BLOCK_TYPES.BOX]: {},
  [BLOCK_TYPES.IMAGE]: {},
};
const getDefinition = (type) => DEFS[type];

const bake = (d, blockId, measuredHeight, bp = 'desktop') =>
  planAutoHeightBake({ design: d, blockId, breakpoint: bp, measuredHeight, getDefinition });

const hOf = (d, id, bp = 'desktop') => {
  const b = d.root.sections[0].children.find((x) => x.id === id);
  return resolveBlockAtBreakpoint(b, bp).h;
};
const yOf = (d, id, bp = 'desktop') => {
  const b = d.root.sections[0].children.find((x) => x.id === id);
  return resolveBlockAtBreakpoint(b, bp).y;
};

// --- suspect-shrink classification --------------------------------------

test('isSuspectShrink: a shrink >= threshold is suspect; a grow / small change is not', () => {
  assert.equal(isSuspectShrink(300, 300 - SHRINK_SUSPECT_PX), true);
  assert.equal(isSuspectShrink(300, 300 - SHRINK_SUSPECT_PX + 1), false); // just under threshold
  assert.equal(isSuspectShrink(300, 500), false); // grow is never suspect
  assert.equal(isSuspectShrink(NaN, 100), false); // no stored height -> not suspect
});

test('autoHeightDebounceDelay: suspect shrink gets the long window, everything else the fast path', () => {
  const d = design([block('t1', BLOCK_TYPES.TEXT, { y: 0, h: 300 })]);
  // Big shrink -> long debounce so a transient short read can be corrected.
  assert.equal(autoHeightDebounceDelay(d, 't1', 'desktop', 120), SHRINK_DEBOUNCE_MS);
  // Grow -> fast path.
  assert.equal(autoHeightDebounceDelay(d, 't1', 'desktop', 480), AUTOHEIGHT_DEBOUNCE_MS);
  // Small change under threshold -> fast path.
  assert.equal(autoHeightDebounceDelay(d, 't1', 'desktop', 295), AUTOHEIGHT_DEBOUNCE_MS);
});

test('readStoredHeightAtBp returns stored h, NaN for missing/hidden', () => {
  const d = design([
    block('t1', BLOCK_TYPES.TEXT, { h: 240 }),
    block('t2', BLOCK_TYPES.TEXT, { h: 100, hidden: true }),
  ]);
  assert.equal(readStoredHeightAtBp(d, 't1', 'desktop'), 240);
  assert.ok(Number.isNaN(readStoredHeightAtBp(d, 't2', 'desktop')));
  assert.ok(Number.isNaN(readStoredHeightAtBp(d, 'nope', 'desktop')));
});

// --- the bake decision (the corruption guard's committed effect) --------

test('genuine large deletion still commits: block shrinks and blocks below move up', () => {
  const d = design([
    block('t1', BLOCK_TYPES.TEXT, { y: 0, h: 300 }),
    block('b2', BLOCK_TYPES.IMAGE, { y: 320, h: 100 }),
  ]);
  // Author deleted a lot of text; the block genuinely measures 120.
  const next = bake(d, 't1', 120);
  assert.ok(next, 'a real shrink must produce a committed design');
  assert.equal(hOf(next, 't1'), 120); // target baked to measured height
  // Block below shifts up by the (negative) delta of -180.
  assert.equal(yOf(next, 'b2'), 320 - 180);
});

test('a genuine grow commits: block grows and blocks below move down', () => {
  const d = design([
    block('t1', BLOCK_TYPES.TEXT, { y: 0, h: 100 }),
    block('b2', BLOCK_TYPES.IMAGE, { y: 120, h: 100 }),
  ]);
  const next = bake(d, 't1', 260);
  assert.ok(next);
  assert.equal(hOf(next, 't1'), 260);
  assert.equal(yOf(next, 'b2'), 120 + 160); // pushed down by +160 delta
});

test('atomic bake grows the containing section by the same delta', () => {
  const d = design([
    block('sec', BLOCK_TYPES.SECTION, { x: 0, y: 0, w: 600, h: 400 }),
    block('t1', BLOCK_TYPES.TEXT, { x: 20, y: 40, w: 560, h: 100 }),
    block('b2', BLOCK_TYPES.IMAGE, { x: 20, y: 460, h: 100 }),
  ]);
  const next = bake(d, 't1', 250); // +150 delta
  assert.ok(next);
  assert.equal(hOf(next, 't1'), 250);
  assert.equal(hOf(next, 'sec'), 400 + 150); // section grew by delta
  assert.equal(yOf(next, 'b2'), 460 + 150); // block below section pushed down
});

test('cards are never baked (autoHeight + cardGrow rely on row equalization)', () => {
  const d = design([
    block('c1', BLOCK_TYPES.CARD, { y: 0, h: 200 }),
    block('b2', BLOCK_TYPES.IMAGE, { y: 220, h: 100 }),
  ]);
  assert.equal(bake(d, 'c1', 340), null); // big grow ignored
  assert.equal(bake(d, 'c1', 60), null); // big shrink ignored
});

test('non-auto-height blocks are never baked', () => {
  const d = design([block('i1', BLOCK_TYPES.IMAGE, { y: 0, h: 200 })]);
  assert.equal(bake(d, 'i1', 400), null);
});

test('deltas inside the dead-band are dropped (no autosave churn)', () => {
  const d = design([block('t1', BLOCK_TYPES.TEXT, { y: 0, h: 200 })]);
  assert.equal(bake(d, 't1', 200 + (AUTOHEIGHT_DEAD_BAND_PX - 1)), null);
  assert.equal(bake(d, 't1', 200 - (AUTOHEIGHT_DEAD_BAND_PX - 1)), null);
  // Exactly at the dead-band boundary bakes.
  assert.ok(bake(d, 't1', 200 + AUTOHEIGHT_DEAD_BAND_PX));
});

test('hidden / missing target, or non-positive / non-finite measurement, are no-ops', () => {
  const d = design([block('t1', BLOCK_TYPES.TEXT, { y: 0, h: 200, hidden: true })]);
  assert.equal(bake(d, 't1', 400), null); // hidden target
  assert.equal(bake(d, 'gone', 400), null); // missing target
  const d2 = design([block('t2', BLOCK_TYPES.TEXT, { y: 0, h: 200 })]);
  assert.equal(bake(d2, 't2', 0), null); // non-positive
  assert.equal(bake(d2, 't2', NaN), null); // non-finite
});

test('bake does not touch blocks above or laterally adjacent to the target', () => {
  const d = design([
    block('above', BLOCK_TYPES.IMAGE, { y: 0, h: 50 }),
    block('t1', BLOCK_TYPES.TEXT, { y: 60, h: 100 }),
    block('side', BLOCK_TYPES.IMAGE, { y: 60, h: 100 }), // overlaps target's band, not below
  ]);
  const next = bake(d, 't1', 220); // +120 delta
  assert.equal(yOf(next, 'above'), 0); // untouched
  assert.equal(yOf(next, 'side'), 60); // not entirely below target -> untouched
  assert.equal(hOf(next, 't1'), 220);
});

// --- auto-SIZE bake (Button / CTA — Task #2662) --------------------------

const wOf = (d, id, bp = 'desktop') => {
  const b = d.root.sections[0].children.find((x) => x.id === id);
  return resolveBlockAtBreakpoint(b, bp).w;
};

const sizeBake = (d, blockId, measuredWidth, measuredHeight, bp = 'desktop') =>
  planAutoSizeBake({ design: d, blockId, breakpoint: bp, measuredWidth, measuredHeight, getDefinition });

test('readStoredWidthAtBp returns stored w, NaN for missing/hidden', () => {
  const d = design([
    block('btn', BLOCK_TYPES.BUTTON, { w: 180 }),
    block('btn2', BLOCK_TYPES.BUTTON, { w: 200, hidden: true }),
  ]);
  assert.equal(readStoredWidthAtBp(d, 'btn', 'desktop'), 180);
  assert.ok(Number.isNaN(readStoredWidthAtBp(d, 'btn2', 'desktop')));
  assert.ok(Number.isNaN(readStoredWidthAtBp(d, 'nope', 'desktop')));
});

test('autoSizeDebounceDelay: a suspect shrink in EITHER dim gets the long window', () => {
  const d = design([block('btn', BLOCK_TYPES.BUTTON, { w: 180, h: 44 })]);
  // Width shrink past threshold -> long window.
  assert.equal(
    autoSizeDebounceDelay(d, 'btn', 'desktop', { width: 180 - SHRINK_SUSPECT_PX, height: 44 }),
    SHRINK_DEBOUNCE_MS,
  );
  // Height shrink past threshold -> long window (even if width grew).
  assert.equal(
    autoSizeDebounceDelay(d, 'btn', 'desktop', { width: 300, height: 44 - SHRINK_SUSPECT_PX }),
    SHRINK_DEBOUNCE_MS,
  );
  // Both growing -> fast path.
  assert.equal(
    autoSizeDebounceDelay(d, 'btn', 'desktop', { width: 320, height: 60 }),
    AUTOHEIGHT_DEBOUNCE_MS,
  );
});

test('planAutoSizeBake: a width change resizes the block only, never neighbours', () => {
  const d = design([
    block('btn', BLOCK_TYPES.BUTTON, { y: 0, w: 180, h: 44 }),
    block('below', BLOCK_TYPES.IMAGE, { y: 60, h: 100 }),
  ]);
  const next = sizeBake(d, 'btn', 320, 44); // width grows, height unchanged
  assert.ok(next);
  assert.equal(wOf(next, 'btn'), 320); // width baked
  assert.equal(hOf(next, 'btn'), 44); // height unchanged
  assert.equal(yOf(next, 'below'), 60); // NOT pushed by a width change
});

test('planAutoSizeBake: a height change bakes height, pushes blocks below and grows the section', () => {
  const d = design([
    block('sec', BLOCK_TYPES.SECTION, { x: 0, y: 0, w: 600, h: 200 }),
    block('btn', BLOCK_TYPES.BUTTON, { x: 20, y: 40, w: 180, h: 44 }),
    block('below', BLOCK_TYPES.IMAGE, { x: 20, y: 260, h: 100 }),
  ]);
  const next = sizeBake(d, 'btn', 260, 84); // +80 height delta, width grows too
  assert.ok(next);
  assert.equal(wOf(next, 'btn'), 260);
  assert.equal(hOf(next, 'btn'), 84);
  assert.equal(hOf(next, 'sec'), 200 + 40); // grew by the height delta (44 -> 84)
  assert.equal(yOf(next, 'below'), 260 + 40); // pushed down by the height delta
});

test('planAutoSizeBake: dead-band drops tiny width AND height changes', () => {
  const d = design([block('btn', BLOCK_TYPES.BUTTON, { y: 0, w: 180, h: 44 })]);
  assert.equal(
    sizeBake(d, 'btn', 180 + (AUTOHEIGHT_DEAD_BAND_PX - 1), 44 + (AUTOHEIGHT_DEAD_BAND_PX - 1)),
    null,
  );
  // A width change at the dead-band boundary bakes width but not height.
  const next = sizeBake(d, 'btn', 180 + AUTOHEIGHT_DEAD_BAND_PX, 44);
  assert.ok(next);
  assert.equal(wOf(next, 'btn'), 180 + AUTOHEIGHT_DEAD_BAND_PX);
  assert.equal(hOf(next, 'btn'), 44);
});

test('planAutoSizeBake: only autoSize blocks are baked; hidden/missing/non-finite are no-ops', () => {
  // Non-autoSize block (Text) is ignored by the size bake.
  const dText = design([block('t1', BLOCK_TYPES.TEXT, { y: 0, w: 180, h: 44 })]);
  assert.equal(sizeBake(dText, 't1', 320, 80), null);
  // Hidden / missing target.
  const dHidden = design([block('btn', BLOCK_TYPES.BUTTON, { y: 0, w: 180, h: 44, hidden: true })]);
  assert.equal(sizeBake(dHidden, 'btn', 320, 80), null);
  assert.equal(sizeBake(dHidden, 'gone', 320, 80), null);
  // Non-finite / non-positive measurements on both dims -> no-op.
  const dOk = design([block('btn', BLOCK_TYPES.BUTTON, { y: 0, w: 180, h: 44 })]);
  assert.equal(sizeBake(dOk, 'btn', NaN, NaN), null);
  assert.equal(sizeBake(dOk, 'btn', 0, 0), null);
});
