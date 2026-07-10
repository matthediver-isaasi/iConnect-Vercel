import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_TYPES,
  LAYOUT_MODES,
  CANVAS_DESIGN_VERSION,
  CANVAS_FLOW_VERSION,
  createBlock,
  createEmptyCanvasDesign,
  createFlowDesign,
  createFlowSection,
  createFlowNode,
  createRow,
  createFreeGroup,
  isFlowDesign,
  normalizeCanvasDesign,
  normalizeFlowDesign,
  forEachFlowNode,
} from '../../client/src/lib/canvasDesign.js';
import { resolveFlowLayout } from '../../client/src/lib/canvasFlowLayout.js';
import { buildFlowDesign, buildNeutralFlowDesign } from './canvasLayoutEngine.js';

// A fixed-height leaf so layout is deterministic without measurement.
function leaf(height, overrides = {}) {
  return createFlowNode(BLOCK_TYPES.TEXT, { flow: { heightMode: 'fixed', height }, ...overrides });
}

// ---------------------------------------------------------------------------
// Schema coexistence: v1 and v2 documents both normalize, without cross-talk.
// ---------------------------------------------------------------------------

test('v1 designs are unaffected by the flow branch', () => {
  const v1 = createEmptyCanvasDesign();
  assert.equal(isFlowDesign(v1), false);
  const norm = normalizeCanvasDesign(v1);
  assert.equal(norm.version, CANVAS_DESIGN_VERSION);
  assert.equal(norm.version, 1);
  assert.equal(norm.root.sections[0].id, 'root-section');
  assert.ok(!('layout' in norm.root));
  assert.ok(!('children' in norm.root.sections[0].children));
});

test('a v1 design with real blocks keeps its absolute shape', () => {
  const block = createBlock(BLOCK_TYPES.TEXT, { desktop: { x: 12, y: 34, w: 200, h: 80 } });
  const v1 = { version: 1, root: { sections: [{ id: 'root-section', children: [block] }] } };
  const norm = normalizeCanvasDesign(v1);
  assert.equal(norm.version, 1);
  const b = norm.root.sections[0].children[0];
  assert.equal(b.bp.desktop.x, 12);
  assert.equal(b.bp.desktop.y, 34);
  // No flow-model fields leak onto v1 blocks.
  assert.ok(!('layoutMode' in b));
  assert.ok(!('flow' in b));
});

test('isFlowDesign detects version 2 and root.layout', () => {
  assert.equal(isFlowDesign({ version: CANVAS_FLOW_VERSION, root: {} }), true);
  assert.equal(isFlowDesign({ version: 1, root: { layout: 'flow' } }), true);
  assert.equal(isFlowDesign({ version: 1, root: {} }), false);
  assert.equal(isFlowDesign(null), false);
});

test('normalizeCanvasDesign routes flow designs to the flow normalizer', () => {
  const flow = createFlowDesign();
  assert.equal(isFlowDesign(flow), true);
  const norm = normalizeCanvasDesign(flow);
  assert.equal(norm.version, CANVAS_FLOW_VERSION);
  assert.equal(norm.root.layout, 'flow');
  assert.ok(Array.isArray(norm.root.sections));
});

test('normalizeFlowDesign is idempotent and fills defaults', () => {
  const raw = {
    root: {
      layout: 'flow',
      sections: [
        { type: BLOCK_TYPES.SECTION, children: [{ type: BLOCK_TYPES.TEXT }] },
      ],
    },
  };
  const once = normalizeFlowDesign(raw);
  const twice = normalizeFlowDesign(once);
  assert.deepEqual(once, twice);
  const section = once.root.sections[0];
  assert.equal(section.layoutMode, LAYOUT_MODES.FLOW);
  assert.ok(section.flow && typeof section.flow.gap === 'number');
  assert.ok(section.responsive && section.responsive.tablet && section.responsive.mobile);
  assert.equal(section.children[0].type, BLOCK_TYPES.TEXT);
});

test('groups default to free mode, sections/rows to flow', () => {
  assert.equal(createFreeGroup().layoutMode, LAYOUT_MODES.FREE);
  assert.equal(createFlowSection().layoutMode, LAYOUT_MODES.FLOW);
  assert.equal(createRow().layoutMode, LAYOUT_MODES.FLOW);
});

// ---------------------------------------------------------------------------
// Layout engine: vertical stack reflow.
// ---------------------------------------------------------------------------

test('flow section stacks children by order + height + gap', () => {
  const a = leaf(100);
  const b = leaf(50);
  const section = createFlowSection({ children: [a, b], flow: { gap: 24 } });
  const design = { version: CANVAS_FLOW_VERSION, root: { layout: 'flow', sections: [section] } };

  const { boxes, height } = resolveFlowLayout(design, { containerWidth: 1000 });
  assert.deepEqual(boxes[a.id], { x: 0, y: 0, w: 1000, h: 100 });
  assert.deepEqual(boxes[b.id], { x: 0, y: 124, w: 1000, h: 50 });
  assert.deepEqual(boxes[section.id], { x: 0, y: 0, w: 1000, h: 174 });
  assert.equal(height, 174);
});

test('editing a block height reflows everything below it', () => {
  // createFlowSection normalizes (clones) its children, so mutate the nodes
  // that actually live in the tree, not the originals.
  const section = createFlowSection({ children: [leaf(100), leaf(50)], flow: { gap: 10 } });
  const [na, nb] = section.children;
  const design = { version: CANVAS_FLOW_VERSION, root: { layout: 'flow', sections: [section] } };

  const before = resolveFlowLayout(design, { containerWidth: 800 });
  assert.equal(before.boxes[nb.id].y, 110);

  // Grow A by 40px; B must shift down by exactly 40 and the section grows too.
  na.flow.height = 140;
  const after = resolveFlowLayout(design, { containerWidth: 800 });
  assert.equal(after.boxes[nb.id].y, 150);
  assert.equal(after.boxes[section.id].h, before.boxes[section.id].h + 40);
});

test('padding and maxWidth center + inset a container', () => {
  const a = leaf(100);
  const section = createFlowSection({
    children: [a],
    flow: { padTop: 20, padBottom: 30, padLeft: 40, padRight: 40, maxWidth: 600 },
  });
  const design = { version: CANVAS_FLOW_VERSION, root: { layout: 'flow', sections: [section] } };
  const { boxes } = resolveFlowLayout(design, { containerWidth: 1000 });
  // maxWidth 600 centered in 1000 -> x offset 200; padLeft 40 -> child x 240.
  assert.equal(boxes[section.id].x, 200);
  assert.equal(boxes[section.id].w, 600);
  assert.equal(boxes[a.id].x, 240);
  assert.equal(boxes[a.id].y, 20);
  assert.equal(boxes[a.id].w, 600 - 80);
  // Section height = padTop + content + padBottom.
  assert.equal(boxes[section.id].h, 20 + 100 + 30);
});

test('hidden children are skipped in the stack', () => {
  const a = leaf(100);
  const b = leaf(50, { responsive: { mobile: { hidden: true } } });
  const c = leaf(70);
  const section = createFlowSection({ children: [a, b, c], flow: { gap: 0 } });
  const design = { version: CANVAS_FLOW_VERSION, root: { layout: 'flow', sections: [section] } };

  const mobile = resolveFlowLayout(design, { breakpoint: 'mobile', containerWidth: 375 });
  assert.equal(mobile.boxes[b.id], undefined);
  // c follows a directly (100), not after b.
  assert.equal(mobile.boxes[c.id].y, 100);
});

// ---------------------------------------------------------------------------
// Layout engine: row (horizontal columns).
// ---------------------------------------------------------------------------

test('row splits width across equal-grow columns and stretches height', () => {
  const a = leaf(200, { flow: { heightMode: 'fixed', height: 200, grow: 1 } });
  const b = leaf(100, { flow: { heightMode: 'fixed', height: 100, grow: 1 } });
  const row = createRow({ children: [a, b], flow: { gap: 20, align: 'stretch' } });
  const design = { version: CANVAS_FLOW_VERSION, root: { layout: 'flow', sections: [row] } };

  const { boxes } = resolveFlowLayout(design, { containerWidth: 1000 });
  // available = 1000 - 20 gap = 980 -> 490 each.
  assert.equal(boxes[a.id].w, 490);
  assert.equal(boxes[b.id].w, 490);
  assert.equal(boxes[a.id].x, 0);
  assert.equal(boxes[b.id].x, 510);
  // stretch => both columns take the tallest height.
  assert.equal(boxes[a.id].h, 200);
  assert.equal(boxes[b.id].h, 200);
  assert.equal(boxes[row.id].h, 200);
});

test('row honors fixed px basis and shares leftover with grow', () => {
  const fixed = leaf(80, { flow: { heightMode: 'fixed', height: 80, basis: 200 } });
  const flex = leaf(80, { flow: { heightMode: 'fixed', height: 80, grow: 1 } });
  const row = createRow({ children: [fixed, flex], flow: { gap: 0, align: 'start' } });
  const design = { version: CANVAS_FLOW_VERSION, root: { layout: 'flow', sections: [row] } };

  const { boxes } = resolveFlowLayout(design, { containerWidth: 1000 });
  assert.equal(boxes[fixed.id].w, 200);
  assert.equal(boxes[flex.id].w, 800);
  assert.equal(boxes[flex.id].x, 200);
});

test('row collapses to a vertical stack on mobile', () => {
  const a = leaf(100, { flow: { heightMode: 'fixed', height: 100, grow: 1 } });
  const b = leaf(60, { flow: { heightMode: 'fixed', height: 60, grow: 1 } });
  const row = createRow({ children: [a, b], flow: { gap: 10 } });
  const design = { version: CANVAS_FLOW_VERSION, root: { layout: 'flow', sections: [row] } };

  const mobile = resolveFlowLayout(design, { breakpoint: 'mobile', containerWidth: 375 });
  // Stacked: full width, b below a.
  assert.equal(mobile.boxes[a.id].w, 375);
  assert.equal(mobile.boxes[b.id].w, 375);
  assert.equal(mobile.boxes[b.id].y, 110);
});

// ---------------------------------------------------------------------------
// Layout engine: free group rigidity (overlap preserved).
// ---------------------------------------------------------------------------

test('free group places children by absolute geometry and preserves overlap', () => {
  const c1 = createFlowNode(BLOCK_TYPES.IMAGE, { desktop: { x: 10, y: 10, w: 100, h: 100 } });
  const c2 = createFlowNode(BLOCK_TYPES.TEXT, { desktop: { x: 50, y: 50, w: 100, h: 100 } });
  const group = createFreeGroup({ children: [c1, c2] });
  const section = createFlowSection({ children: [group] });
  const design = { version: CANVAS_FLOW_VERSION, root: { layout: 'flow', sections: [section] } };

  const { boxes } = resolveFlowLayout(design, { containerWidth: 1000 });
  assert.deepEqual(boxes[c1.id], { x: 10, y: 10, w: 100, h: 100 });
  assert.deepEqual(boxes[c2.id], { x: 50, y: 50, w: 100, h: 100 });
  // Overlap: c2 starts inside c1's box.
  assert.ok(boxes[c2.id].x < boxes[c1.id].x + boxes[c1.id].w);
  // Group height = furthest child bottom (150), NOT a reflowed stack.
  assert.equal(boxes[group.id].h, 150);
});

// ---------------------------------------------------------------------------
// Autobuild flow emitter.
// ---------------------------------------------------------------------------

test('buildFlowDesign emits a normalizable, resolvable flow document', () => {
  const spec = {
    hero: { headline: 'Welcome' },
    intro: { html: '<p>Intro</p>', h: 120, strapline: 'Hello' },
    sections: [
      { heading: 'Two up', type: 'columns', columns: [{ h3: 'A', html: '<p>a</p>', h: 100 }, { h3: 'B', html: '<p>b</p>', h: 100 }] },
      { type: 'text', html: '<p>Body</p>', h: 140, buttons: ['Join', 'Learn'] },
    ],
    closingHero: { headline: 'Join us' },
  };

  const design = buildNeutralFlowDesign(spec);
  assert.equal(isFlowDesign(design), true);
  assert.equal(design.version, CANVAS_FLOW_VERSION);

  // Emitted design must already be normalized (idempotent through normalize).
  assert.deepEqual(normalizeCanvasDesign(design), design);

  // Every node resolves to a box, and the page has positive height.
  const { boxes, height } = resolveFlowLayout(design, { containerWidth: 1200 });
  assert.ok(height > 0);
  const ids = [];
  forEachFlowNode(design, (node) => ids.push(node.id));
  for (const id of ids) {
    assert.ok(boxes[id], `missing box for node ${id}`);
  }

  // A Row was emitted for the two-column section.
  let rows = 0;
  forEachFlowNode(design, (n) => { if (n.type === BLOCK_TYPES.ROW) rows += 1; });
  assert.ok(rows >= 1);
});

test('buildFlowDesign sections appear in vertical document order', () => {
  const design = buildNeutralFlowDesign({
    hero: { headline: 'H' },
    sections: [{ type: 'text', html: '<p>x</p>', h: 100 }],
  });
  const { boxes } = resolveFlowLayout(design, { containerWidth: 1200 });
  const sectionYs = design.root.sections.map((s) => boxes[s.id].y);
  const sorted = [...sectionYs].sort((a, b) => a - b);
  assert.deepEqual(sectionYs, sorted);
});
