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
  computeReanchoredBoxHeight,
  computeBoxGrowthDelta,
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

// --- box re-anchor: single source of truth with the public renderer (#2680) --

// The box height is baked via the SAME computeReanchoredBoxHeight formula the
// public renderer uses, so the builder and the front-end agree. These tests pin
// the shared formula and the bake's box branch.

test('computeReanchoredBoxHeight: no rows returns the authored height', () => {
  assert.equal(
    computeReanchoredBoxHeight({ containerTop: 0, containerHeight: 200, rows: [] }),
    200,
  );
});

test('computeReanchoredBoxHeight: preserves the authored bottom inset when content grows', () => {
  // Box y=0 h=200 (bottom 200). One row stored bottom 160 -> authored inset 40.
  // Content grows to a measured bottom of 260 -> box wraps it keeping the 40 gap.
  const h = computeReanchoredBoxHeight({
    containerTop: 0,
    containerHeight: 200,
    rows: [{ storedBottom: 160, measuredBottom: 260 }],
  });
  assert.equal(h, 260 + 40 - 0); // (measured - top) + inset
});

test('computeReanchoredBoxHeight: tracks the DEEPEST row, not the last one', () => {
  const h = computeReanchoredBoxHeight({
    containerTop: 0,
    containerHeight: 300,
    rows: [
      { storedBottom: 250, measuredBottom: 250 }, // deepest, unchanged
      { storedBottom: 120, measuredBottom: 180 }, // shallower row grew
    ],
  });
  // Deepest measured bottom is 250; deepest stored bottom is 250; inset = 300-250 = 50.
  assert.equal(h, 250 + 50);
});

test('computeReanchoredBoxHeight: content deeper than the box forces growth (inset clamps to 0)', () => {
  const h = computeReanchoredBoxHeight({
    containerTop: 0,
    containerHeight: 100,
    rows: [{ storedBottom: 90, measuredBottom: 400 }],
  });
  // containerBottom 100 < deepestStored 90? no: inset = max(0, 100-90) = 10.
  assert.equal(h, 400 + 10);
});

// --- public-renderer grow-only box growth (front-end never shrinks below the
// authored/stored height, matching the builder) ---------------------------

test('computeBoxGrowthDelta: static content (measured == stored) yields 0 growth', () => {
  assert.equal(
    computeBoxGrowthDelta({
      containerTop: 0,
      containerHeight: 300,
      rows: [{ storedBottom: 250, measuredBottom: 250 }],
    }),
    0,
  );
});

test('computeBoxGrowthDelta: content taller than stored grows the box', () => {
  // Box y=0 h=200, row stored bottom 160 (inset 40), measured bottom 260 ->
  // re-anchored 300 -> delta +100.
  assert.equal(
    computeBoxGrowthDelta({
      containerTop: 0,
      containerHeight: 200,
      rows: [{ storedBottom: 160, measuredBottom: 260 }],
    }),
    100,
  );
});

test('computeBoxGrowthDelta: content SHORTER than stored is floored at 0 (never shrinks the box)', () => {
  // The reported bug: a box authored at 300 whose text renders shorter than its
  // stored geometry. The re-anchor formula alone would collapse the box below
  // 300; grow-only floors the delta at 0 so the front-end keeps the authored
  // height, matching the builder.
  const reanchored = computeReanchoredBoxHeight({
    containerTop: 0,
    containerHeight: 300,
    rows: [{ storedBottom: 250, measuredBottom: 214 }],
  });
  assert.ok(reanchored < 300); // formula shrinks…
  assert.equal(
    computeBoxGrowthDelta({
      containerTop: 0,
      containerHeight: 300,
      rows: [{ storedBottom: 250, measuredBottom: 214 }],
    }),
    0, // …but the public path floors it to no shrink
  );
});

test('computeBoxGrowthDelta: no contained rows yields 0 growth', () => {
  assert.equal(
    computeBoxGrowthDelta({ containerTop: 0, containerHeight: 300, rows: [] }),
    0,
  );
});

test('box bake: single contained block grows -> box grows by the same delta (parity with old delta path)', () => {
  const d = design([
    block('bx', BLOCK_TYPES.BOX, { x: 0, y: 0, w: 600, h: 200 }),
    block('t1', BLOCK_TYPES.TEXT, { x: 20, y: 40, w: 560, h: 100 }), // bottom 140, inset 60
    block('b2', BLOCK_TYPES.IMAGE, { x: 20, y: 260, h: 100 }),
  ]);
  const next = bake(d, 't1', 250); // +150 delta -> new bottom 290
  assert.ok(next);
  assert.equal(hOf(next, 't1'), 250);
  assert.equal(hOf(next, 'bx'), 200 + 150); // box grew by delta, inset preserved
  assert.equal(yOf(next, 'b2'), 260 + 150); // block below pushed down by delta
});

test('box bake: editing the SHALLOWER of two blocks does NOT grow the box (re-anchor, not delta)', () => {
  const d = design([
    block('bx', BLOCK_TYPES.BOX, { x: 0, y: 0, w: 600, h: 300 }),
    // deep block (left column) is the deepest contained content
    block('deep', BLOCK_TYPES.TEXT, { x: 20, y: 40, w: 270, h: 210 }), // bottom 250
    // shallow block (right column) shares the top row band
    block('shallow', BLOCK_TYPES.TEXT, { x: 310, y: 40, w: 270, h: 100 }), // bottom 140
  ]);
  // Grow the shallow block, but it stays shallower than `deep`.
  const next = bake(d, 'shallow', 180); // +80, new bottom 220 < deep bottom 250
  assert.ok(next);
  assert.equal(hOf(next, 'shallow'), 180);
  assert.equal(hOf(next, 'bx'), 300); // box UNCHANGED — deepest content unchanged
});

test('box bake: shrinking a non-deepest block leaves the box height unchanged', () => {
  const d = design([
    block('bx', BLOCK_TYPES.BOX, { x: 0, y: 0, w: 600, h: 300 }),
    block('deep', BLOCK_TYPES.TEXT, { x: 20, y: 40, w: 270, h: 210 }), // bottom 250 (deepest)
    block('shallow', BLOCK_TYPES.TEXT, { x: 310, y: 40, w: 270, h: 120 }), // bottom 160
  ]);
  const next = bake(d, 'shallow', 60); // shrinks well below deep
  assert.ok(next);
  assert.equal(hOf(next, 'shallow'), 60);
  assert.equal(hOf(next, 'bx'), 300); // box tracks the (unchanged) deepest block
});

test('box bake: growing the deepest block re-anchors the box and preserves its inset', () => {
  const d = design([
    block('bx', BLOCK_TYPES.BOX, { x: 0, y: 0, w: 600, h: 300 }),
    block('deep', BLOCK_TYPES.TEXT, { x: 20, y: 40, w: 270, h: 210 }), // bottom 250, inset 50
    block('shallow', BLOCK_TYPES.TEXT, { x: 310, y: 40, w: 270, h: 100 }), // bottom 140
  ]);
  const next = bake(d, 'deep', 260); // +50, new bottom 300
  assert.ok(next);
  assert.equal(hOf(next, 'deep'), 260);
  assert.equal(hOf(next, 'bx'), 300 + 50); // re-anchored to new deepest + 50 inset
});

test('box bake: a card contained in the box never drives box growth', () => {
  const d = design([
    block('bx', BLOCK_TYPES.BOX, { x: 0, y: 0, w: 600, h: 300 }),
    block('t1', BLOCK_TYPES.TEXT, { x: 20, y: 40, w: 270, h: 100 }), // bottom 140, inset 160
    block('c1', BLOCK_TYPES.CARD, { x: 310, y: 40, w: 270, h: 240 }), // deepest, but a card
  ]);
  const next = bake(d, 't1', 180); // +40 -> new measured bottom 40+180=220
  assert.ok(next);
  // Card excluded from the row set: box re-anchors to the text only.
  // text stored bottom 140 -> authored inset 300-140=160; measured bottom 220.
  assert.equal(hOf(next, 'bx'), 220 + 160);
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

// --- manualWidth override (Task #2675) -----------------------------------

const btnWithManualWidth = (id, geom) => ({
  id,
  type: BLOCK_TYPES.BUTTON,
  bp: { desktop: { manualWidth: true, ...geom } },
});

const manualWidthOf = (d, id, bp = 'desktop') => {
  const b = d.root.sections[0].children.find((x) => x.id === id);
  return resolveBlockAtBreakpoint(b, bp).manualWidth;
};

test('planAutoSizeBake: manualWidth blocks a text-driven width shrink (no snap-back)', () => {
  const d = design([btnWithManualWidth('btn', { x: 0, y: 0, w: 300, h: 44 })]);
  // Content span reports the narrower natural label width (200) but the user
  // dragged the box to 300 -> the shrink must be ignored.
  assert.equal(sizeBake(d, 'btn', 200, 44), null);
});

test('planAutoSizeBake: a text-driven grow past the manual width bakes and clears manualWidth', () => {
  const d = design([btnWithManualWidth('btn', { x: 0, y: 0, w: 300, h: 44 })]);
  const next = sizeBake(d, 'btn', 360, 44); // label now genuinely longer than 300
  assert.ok(next);
  assert.equal(wOf(next, 'btn'), 360); // grew to fit the longer label
  assert.equal(manualWidthOf(next, 'btn'), false); // override reset -> auto-tracks again
});

test('planAutoSizeBake: without manualWidth a text shrink still bakes (existing behaviour)', () => {
  const d = design([block('btn', BLOCK_TYPES.BUTTON, { x: 0, y: 0, w: 300, h: 44 })]);
  const next = sizeBake(d, 'btn', 200, 44);
  assert.ok(next);
  assert.equal(wOf(next, 'btn'), 200); // shrinks to the shorter label
});

test('planAutoSizeBake: manualWidth still allows an independent height change on a blocked width shrink', () => {
  const d = design([btnWithManualWidth('btn', { x: 0, y: 0, w: 300, h: 44 })]);
  // Width shrink is blocked, but a real height grow must still bake.
  const next = sizeBake(d, 'btn', 200, 90);
  assert.ok(next);
  assert.equal(wOf(next, 'btn'), 300); // width unchanged (manual override wins)
  assert.equal(hOf(next, 'btn'), 90); // height baked
  assert.equal(manualWidthOf(next, 'btn'), true); // flag preserved (no width grow)
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
