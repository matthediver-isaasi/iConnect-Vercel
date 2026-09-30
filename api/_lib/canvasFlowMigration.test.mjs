import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_TYPES,
  LAYOUT_MODES,
  CANVAS_FLOW_VERSION,
  createBlock,
  createEmptyCanvasDesign,
  createFlowDesign,
  convertDesignToFlow,
  isFlowDesign,
  isFlowContainerType,
  forEachFlowNode,
  normalizeFlowDesign,
} from '../../client/src/lib/canvasDesign.js';

// Build a v1 (absolute) design from a flat list of block overrides. Each entry
// is passed straight to createBlock (so `desktop` carries geometry).
function v1Design(blocks) {
  const design = createEmptyCanvasDesign();
  design.root.sections[0].children = blocks.map((b) => createBlock(b.type || BLOCK_TYPES.BOX, b));
  return design;
}

// Set of leaf (non-container) block ids in a flow design.
function flowLeafIds(design) {
  const ids = new Set();
  forEachFlowNode(design, (node) => {
    if (node && node.id && !isFlowContainerType(node.type)) ids.add(node.id);
  });
  return ids;
}

// ---------------------------------------------------------------------------
// Idempotency / no-op on already-flow docs.
// ---------------------------------------------------------------------------

test('convertDesignToFlow on a v2 design is a normalize-only no-op', () => {
  const flow = createFlowDesign();
  const out = convertDesignToFlow(flow);
  assert.equal(isFlowDesign(out), true);
  assert.equal(out.version, CANVAS_FLOW_VERSION);
  assert.deepEqual(out, normalizeFlowDesign(flow));
});

test('convertDesignToFlow is idempotent (convert twice == convert once)', () => {
  const v1 = v1Design([
    { id: 'a', type: BLOCK_TYPES.TEXT, desktop: { x: 40, y: 40, w: 400, h: 80 } },
    { id: 'b', type: BLOCK_TYPES.BOX, desktop: { x: 40, y: 160, w: 400, h: 200 } },
  ]);
  const once = convertDesignToFlow(v1);
  const twice = convertDesignToFlow(once);
  assert.deepEqual(twice, once);
});

// ---------------------------------------------------------------------------
// Structural conversion.
// ---------------------------------------------------------------------------

test('produces a well-formed v2 flow design', () => {
  const v1 = v1Design([
    { id: 'a', type: BLOCK_TYPES.TEXT, desktop: { x: 40, y: 40, w: 400, h: 80 } },
  ]);
  const out = convertDesignToFlow(v1);
  assert.equal(isFlowDesign(out), true);
  assert.equal(out.version, CANVAS_FLOW_VERSION);
  assert.equal(out.root.layout, 'flow');
  assert.ok(Array.isArray(out.root.sections) && out.root.sections.length >= 1);
});

test('vertically-separated blocks become stacked leaves in document order', () => {
  const v1 = v1Design([
    { id: 'top', type: BLOCK_TYPES.TEXT, desktop: { x: 40, y: 40, w: 400, h: 80 } },
    { id: 'bottom', type: BLOCK_TYPES.BOX, desktop: { x: 40, y: 200, w: 400, h: 120 } },
  ]);
  const out = convertDesignToFlow(v1);
  const section = out.root.sections[0];
  // Two separate bands -> two direct children, neither a Row.
  assert.equal(section.children.length, 2);
  assert.equal(section.children[0].type, BLOCK_TYPES.TEXT);
  assert.equal(section.children[1].type, BLOCK_TYPES.BOX);
  assert.ok(section.children.every((c) => c.type !== BLOCK_TYPES.ROW));
});

test('side-by-side blocks (overlapping vertical extents) become a Row', () => {
  const v1 = v1Design([
    { id: 'left', type: BLOCK_TYPES.BOX, desktop: { x: 0, y: 40, w: 300, h: 200 } },
    { id: 'right', type: BLOCK_TYPES.BOX, desktop: { x: 340, y: 40, w: 300, h: 200 } },
  ]);
  const out = convertDesignToFlow(v1);
  const section = out.root.sections[0];
  assert.equal(section.children.length, 1);
  const row = section.children[0];
  assert.equal(row.type, BLOCK_TYPES.ROW);
  assert.equal(row.children.length, 2);
  // Columns are ordered left-to-right and carry their width as basis.
  assert.equal(row.children[0].id, 'left');
  assert.equal(row.children[1].id, 'right');
  assert.equal(row.children[0].flow.basis, 300);
  assert.equal(row.children[1].flow.basis, 300);
});

test('auto-height leaves flow-size; other leaves pin their desktop height', () => {
  const v1 = v1Design([
    { id: 'text', type: BLOCK_TYPES.TEXT, desktop: { x: 40, y: 40, w: 400, h: 90 } },
    { id: 'box', type: BLOCK_TYPES.BOX, desktop: { x: 40, y: 200, w: 400, h: 150 } },
  ]);
  const out = convertDesignToFlow(v1);
  const [text, box] = out.root.sections[0].children;
  assert.equal(text.flow.heightMode, 'auto');
  assert.equal(text.flow.height, null);
  assert.equal(box.flow.heightMode, 'fixed');
  assert.equal(box.flow.height, 150);
});

// ---------------------------------------------------------------------------
// Content preservation — no authored block is dropped.
// ---------------------------------------------------------------------------

test('every authored leaf survives conversion (visible + hidden)', () => {
  const v1 = v1Design([
    { id: 'a', type: BLOCK_TYPES.TEXT, desktop: { x: 40, y: 40, w: 400, h: 80 } },
    { id: 'b', type: BLOCK_TYPES.BOX, desktop: { x: 0, y: 200, w: 300, h: 200 } },
    { id: 'c', type: BLOCK_TYPES.BOX, desktop: { x: 340, y: 200, w: 300, h: 200 } },
    // A desktop-hidden block must still be preserved.
    { id: 'hidden', type: BLOCK_TYPES.BOX, desktop: { x: 40, y: 500, w: 200, h: 100, hidden: true } },
  ]);
  const out = convertDesignToFlow(v1);
  const ids = flowLeafIds(out);
  assert.equal(ids.has('a'), true);
  assert.equal(ids.has('b'), true);
  assert.equal(ids.has('c'), true);
  assert.equal(ids.has('hidden'), true);
  assert.equal(ids.size, 4);
});

test('empty v1 design converts to a valid empty flow design', () => {
  const v1 = createEmptyCanvasDesign();
  const out = convertDesignToFlow(v1);
  assert.equal(isFlowDesign(out), true);
  assert.ok(Array.isArray(out.root.sections) && out.root.sections.length >= 1);
  assert.equal(flowLeafIds(out).size, 0);
});

test('converted section uses zero gap and its children are flow-mode', () => {
  const v1 = v1Design([
    { id: 'a', type: BLOCK_TYPES.TEXT, desktop: { x: 40, y: 40, w: 400, h: 80 } },
    { id: 'b', type: BLOCK_TYPES.BOX, desktop: { x: 40, y: 200, w: 400, h: 120 } },
  ]);
  const out = convertDesignToFlow(v1);
  const section = out.root.sections[0];
  assert.equal(section.flow.gap, 0);
  assert.equal(section.layoutMode, LAYOUT_MODES.FLOW);
});
