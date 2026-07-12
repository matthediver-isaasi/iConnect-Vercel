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
  readingOrderMatchesVisualDeep,
  autoOrderChildren,
  computeReadingOrder,
  isInteractiveBlock,
  moveBlockInReadingOrder,
  findReadingOrderPosition,
} from './canvasA11y.js';

import { BLOCK_TYPES, LAYOUT_MODES } from './canvasDesign.js';

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

// A container block (section/row/group) carrying nested `children`. `layoutMode`
// decides whether Auto-order may reorder the children: 'free' groups are
// reordered, 'flow' stacks are left alone (document order defines layout).
function mkContainer(id, x, y, children, { layoutMode = LAYOUT_MODES.FREE, type = BLOCK_TYPES.GROUP, z } = {}) {
  const block = {
    id,
    type,
    layoutMode,
    bp: { desktop: { x, y, w: 400, h: 400, hidden: false } },
    children,
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

// -- Nested containers (Task #2724) -----------------------------------------

test('autoOrderChildren: reorders children inside a free-position group', () => {
  // The group is free-position, so its children can be reordered without moving
  // anything visually. Its children are authored out of visual order.
  const g1 = mk('g1', 300, 200); // visually last
  const g2 = mk('g2', 10, 10);   // visually first
  const group = mkContainer('grp', 10, 10, [g1, g2]);
  const other = mk('other', 10, 500); // root sibling below the group
  const out = autoOrderChildren([group, other]);
  // Root order is already visual (group at y=10, other at y=500).
  assert.deepEqual(ids(out), ['grp', 'other']);
  const outGroup = out.find((b) => b.id === 'grp');
  // The group's children are reordered top-to-bottom.
  assert.deepEqual(ids(outGroup.children), ['g2', 'g1']);
});

test('autoOrderChildren: reorders BOTH the root and the nested group', () => {
  const g1 = mk('g1', 300, 200);
  const g2 = mk('g2', 10, 10);
  const group = mkContainer('grp', 10, 500, [g1, g2]); // visually last at root
  const top = mk('top', 10, 10);                        // visually first at root
  const out = autoOrderChildren([group, top]);
  assert.deepEqual(ids(out), ['top', 'grp']);
  const outGroup = out.find((b) => b.id === 'grp');
  assert.deepEqual(ids(outGroup.children), ['g2', 'g1']);
});

test('autoOrderChildren: does NOT reorder children of a flow container', () => {
  // A flow section/row lays children out BY document order, so reordering would
  // move them on the page. Auto-order must leave the array untouched.
  const c1 = mk('c1', 300, 0); // authored first, but visually to the right
  const c2 = mk('c2', 10, 0);  // authored second, visually to the left
  const row = mkContainer('row', 10, 10, [c1, c2], {
    layoutMode: LAYOUT_MODES.FLOW,
    type: BLOCK_TYPES.ROW,
  });
  const out = autoOrderChildren([row]);
  const outRow = out.find((b) => b.id === 'row');
  assert.deepEqual(ids(outRow.children), ['c1', 'c2']); // unchanged
});

test('autoOrderChildren: recurses through a flow container into a nested free group', () => {
  // Flow section (not reordered) that contains a free group (reordered).
  const g1 = mk('g1', 300, 200);
  const g2 = mk('g2', 10, 10);
  const group = mkContainer('grp', 0, 0, [g1, g2]); // free
  const lead = mk('lead', 0, 0);
  const section = mkContainer('sec', 0, 0, [lead, group], {
    layoutMode: LAYOUT_MODES.FLOW,
    type: BLOCK_TYPES.SECTION,
  });
  const out = autoOrderChildren([section]);
  const outSec = out.find((b) => b.id === 'sec');
  // Flow section children keep their document order...
  assert.deepEqual(ids(outSec.children), ['lead', 'grp']);
  // ...but the nested free group is reordered.
  const outGroup = outSec.children.find((b) => b.id === 'grp');
  assert.deepEqual(ids(outGroup.children), ['g2', 'g1']);
});

test('autoOrderChildren: preserves stacking inside a nested group', () => {
  // Two overlapping children in a free group with equal z. Document order paints
  // `b2` on top; visual order would flip which paints on top, so z must be
  // pinned to preserve stacking.
  const t2 = mk('t2', 300, 300, { z: 1 }); // visually last, painted under b2
  const b2 = mk('b2', 10, 10, { z: 1 });   // visually first, painted on top now
  const group = mkContainer('grp', 0, 0, [t2, b2]);
  const out = autoOrderChildren([group]);
  const outGroup = out.find((b) => b.id === 'grp');
  assert.deepEqual(ids(outGroup.children), ['b2', 't2']);
  const outB2 = outGroup.children.find((x) => x.id === 'b2');
  const outT2 = outGroup.children.find((x) => x.id === 't2');
  assert.ok((zOf(outB2) ?? 1) > (zOf(outT2) ?? 1),
    'the nested block that was on top must keep the higher z-index');
});

test('autoOrderChildren: rootIsFlow leaves top level alone but fixes nested groups', () => {
  // v2 (flow) design: root array is a flow stack — do not reorder it — but a
  // nested free group inside is still fixed.
  const g1 = mk('g1', 300, 200);
  const g2 = mk('g2', 10, 10);
  const group = mkContainer('grp', 0, 0, [g1, g2]);
  const secA = mkContainer('secA', 0, 500, [group], {
    layoutMode: LAYOUT_MODES.FLOW, type: BLOCK_TYPES.SECTION,
  });
  const secB = mkContainer('secB', 0, 10, [], {
    layoutMode: LAYOUT_MODES.FLOW, type: BLOCK_TYPES.SECTION,
  });
  // Root order [secA, secB] is NOT visual (secA is lower). With rootIsFlow it
  // must stay as authored.
  const out = autoOrderChildren([secA, secB], { rootIsFlow: true });
  assert.deepEqual(ids(out), ['secA', 'secB']);
  const outGroup = out.find((b) => b.id === 'secA').children.find((b) => b.id === 'grp');
  assert.deepEqual(ids(outGroup.children), ['g2', 'g1']);
});

test('autoOrderChildren: idempotent with nesting', () => {
  const g1 = mk('g1', 300, 200);
  const g2 = mk('g2', 10, 10);
  const group = mkContainer('grp', 10, 500, [g1, g2]);
  const top = mk('top', 10, 10);
  const once = autoOrderChildren([group, top]);
  const twice = autoOrderChildren(once);
  assert.deepEqual(ids(twice), ids(once));
  const g = twice.find((b) => b.id === 'grp');
  assert.deepEqual(ids(g.children), ['g2', 'g1']);
});

test('autoOrderChildren: no-op keeps container block references when already ordered', () => {
  const g1 = mk('g1', 10, 10);
  const g2 = mk('g2', 10, 100);
  const group = mkContainer('grp', 10, 10, [g1, g2]); // already in visual order
  const other = mk('other', 10, 500);
  const input = [group, other];
  const out = autoOrderChildren(input);
  // Same ids and — crucially — the same block reference (no spurious clone).
  assert.deepEqual(ids(out), ['grp', 'other']);
  assert.equal(out.find((b) => b.id === 'grp'), group);
});

test('readingOrderMatchesVisualDeep: detects a nested group mismatch', () => {
  const g1 = mk('g1', 300, 200); // out of order inside the group
  const g2 = mk('g2', 10, 10);
  const group = mkContainer('grp', 10, 10, [g1, g2]);
  const other = mk('other', 10, 500);
  // Root is already visual, but the nested group is not.
  assert.equal(readingOrderMatchesVisual([group, other]), true);
  assert.equal(readingOrderMatchesVisualDeep([group, other]), false);
});

test('readingOrderMatchesVisualDeep: true when root and nested are all ordered', () => {
  const g1 = mk('g1', 10, 10);
  const g2 = mk('g2', 10, 100);
  const group = mkContainer('grp', 10, 10, [g1, g2]);
  const other = mk('other', 10, 500);
  assert.equal(readingOrderMatchesVisualDeep([group, other]), true);
});

test('readingOrderMatchesVisualDeep: detects mismatch behind a single-child container chain', () => {
  // section(flow, ONE child) -> group(free, 2 out-of-order children). Because the
  // intermediate container has exactly one child, a naive `> 1` recursion guard
  // would wrongly report "already ordered" and disable Auto-order.
  const g1 = mk('g1', 300, 200); // out of order inside the group
  const g2 = mk('g2', 10, 10);
  const group = mkContainer('grp', 0, 0, [g1, g2]); // free
  const section = mkContainer('sec', 0, 0, [group], {
    layoutMode: LAYOUT_MODES.FLOW,
    type: BLOCK_TYPES.SECTION,
  });
  // Root-level (the single section) is trivially ordered, but the deep check
  // must still see the nested free group is out of order.
  assert.equal(readingOrderMatchesVisualDeep([section]), false);
  // ...and Auto-order actually fixes it.
  const out = autoOrderChildren([section]);
  const outGroup = out.find((b) => b.id === 'sec').children.find((b) => b.id === 'grp');
  assert.deepEqual(ids(outGroup.children), ['g2', 'g1']);
});

test('readingOrderMatchesVisualDeep: single-child chain mismatch detected with rootIsFlow', () => {
  const g1 = mk('g1', 300, 200);
  const g2 = mk('g2', 10, 10);
  const group = mkContainer('grp', 0, 0, [g1, g2]);
  const section = mkContainer('sec', 0, 0, [group], {
    layoutMode: LAYOUT_MODES.FLOW,
    type: BLOCK_TYPES.SECTION,
  });
  assert.equal(readingOrderMatchesVisualDeep([section], { rootIsFlow: true }), false);
});

// -- Manual reading-order move / arrows (Task #2726) ------------------------

test('findReadingOrderPosition: root-level block reports index within root', () => {
  const a = mk('a', 10, 10);
  const b = mk('b', 10, 100);
  const c = mk('c', 10, 200);
  assert.deepEqual(findReadingOrderPosition([a, b, c], 'b'), { index: 1, total: 3 });
  assert.deepEqual(findReadingOrderPosition([a, b, c], 'a'), { index: 0, total: 3 });
});

test('findReadingOrderPosition: nested block reports index within its OWN group', () => {
  const g1 = mk('g1', 10, 10);
  const g2 = mk('g2', 10, 100);
  const g3 = mk('g3', 10, 200);
  const group = mkContainer('grp', 10, 10, [g1, g2, g3]);
  const other = mk('other', 10, 500);
  // g2 is index 1 of the group's 3 children — NOT relative to the root array.
  assert.deepEqual(findReadingOrderPosition([group, other], 'g2'), { index: 1, total: 3 });
  assert.deepEqual(findReadingOrderPosition([group, other], 'g3'), { index: 2, total: 3 });
});

test('findReadingOrderPosition: unknown id returns index -1', () => {
  const a = mk('a', 10, 10);
  assert.deepEqual(findReadingOrderPosition([a], 'nope'), { index: -1, total: 0 });
  assert.deepEqual(findReadingOrderPosition(null, 'a'), { index: -1, total: 0 });
});

test('moveBlockInReadingOrder: moves a root block up and down', () => {
  const a = mk('a', 10, 10);
  const b = mk('b', 10, 100);
  const c = mk('c', 10, 200);
  assert.deepEqual(ids(moveBlockInReadingOrder([a, b, c], 'c', 'up')), ['a', 'c', 'b']);
  assert.deepEqual(ids(moveBlockInReadingOrder([a, b, c], 'a', 'down')), ['b', 'a', 'c']);
});

test('moveBlockInReadingOrder: out-of-bounds move is a no-op (same reference)', () => {
  const a = mk('a', 10, 10);
  const b = mk('b', 10, 100);
  const input = [a, b];
  assert.equal(moveBlockInReadingOrder(input, 'a', 'up'), input);
  assert.equal(moveBlockInReadingOrder(input, 'b', 'down'), input);
});

test('moveBlockInReadingOrder: unknown id is a no-op (same reference)', () => {
  const a = mk('a', 10, 10);
  const input = [a];
  assert.equal(moveBlockInReadingOrder(input, 'ghost', 'up'), input);
});

test('moveBlockInReadingOrder: reorders a block INSIDE a nested group only', () => {
  const g1 = mk('g1', 10, 10);
  const g2 = mk('g2', 10, 100);
  const g3 = mk('g3', 10, 200);
  const group = mkContainer('grp', 10, 10, [g1, g2, g3]);
  const other = mk('other', 10, 500);
  const out = moveBlockInReadingOrder([group, other], 'g3', 'up');
  // Root order unchanged, and the root sibling object is untouched.
  assert.deepEqual(ids(out), ['grp', 'other']);
  assert.equal(out.find((b) => b.id === 'other'), other);
  // The group's children were reordered.
  const outGroup = out.find((b) => b.id === 'grp');
  assert.deepEqual(ids(outGroup.children), ['g1', 'g3', 'g2']);
});

test('moveBlockInReadingOrder: nested out-of-bounds move is a no-op (same reference)', () => {
  const g1 = mk('g1', 10, 10);
  const g2 = mk('g2', 10, 100);
  const group = mkContainer('grp', 10, 10, [g1, g2]);
  const input = [group];
  // g1 is already first inside the group; moving it up does nothing.
  assert.equal(moveBlockInReadingOrder(input, 'g1', 'up'), input);
});

test('moveBlockInReadingOrder: preserves stacking when the swap would flip paint order', () => {
  // Two overlapping equal-z blocks. Document order [under, over]: `over` paints
  // last (on top). Moving `over` up swaps document order to [over, under]; with
  // equal z that would make `under` paint on top. z must be pinned to keep
  // `over` on top — zero visual change.
  const under = mk('under', 10, 10, { z: 1 });
  const over = mk('over', 12, 12, { z: 1 });
  const out = moveBlockInReadingOrder([under, over], 'over', 'up');
  assert.deepEqual(ids(out), ['over', 'under']);
  const outOver = out.find((b) => b.id === 'over');
  const outUnder = out.find((b) => b.id === 'under');
  assert.ok((zOf(outOver) ?? 1) > (zOf(outUnder) ?? 1),
    'the block that was on top must keep the higher z-index after the move');
});

test('moveBlockInReadingOrder: is pure (never mutates input blocks)', () => {
  const g1 = mk('g1', 10, 10);
  const g2 = mk('g2', 10, 100);
  const group = mkContainer('grp', 10, 10, [g1, g2]);
  const before = JSON.stringify([group]);
  moveBlockInReadingOrder([group], 'g2', 'up');
  assert.equal(JSON.stringify([group]), before);
});
