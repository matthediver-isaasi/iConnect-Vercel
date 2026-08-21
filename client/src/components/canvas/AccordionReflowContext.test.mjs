import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK_TYPES } from '../../lib/canvasDesign.js';
import {
  buildReflowRowGroups,
  computeReflowStageHeight,
  growthForContainedGeom,
  offsetForTargetGeom,
  relativeOffsetWithinContainer,
} from './reflowStageHeight.js';
import { computeBoxGrowthDelta } from './autoHeightBake.js';

const block = (id, type, y, h, x = 0, w = 100) => ({
  id,
  type,
  geom: { x, y, w, h, hidden: false },
});
const resolveGeom = (item) => item.geom;
const member = (id, effectiveH, { signed = false, isCard = false } = {}) => ({
  id,
  effectiveH,
  signed,
  isCard,
});
const row = ({
  top,
  refBottom,
  growth,
  renderedHeight,
  members,
  signed = false,
}) => ({
  top,
  refBottom,
  growth,
  renderedHeight,
  members,
  ids: members.map((item) => item.id),
  signed,
});

const entry = ({
  id,
  x = 0,
  y = 0,
  w = 100,
  h = 100,
  measuredH = h,
  referenceH = h,
  isCard = false,
  signed = false,
  fullWidth = false,
}) => ({
  id,
  top: y,
  bottom: y + h,
  refBottom: y + referenceH,
  left: x,
  right: x + w,
  fullWidth,
  effectiveH: measuredH,
  isCard,
  signed,
});

function height({
  baseHeight,
  blocks,
  rowGroups,
  getContainerGrowth = () => 0,
  relayTargets,
}) {
  return computeReflowStageHeight({
    baseHeight,
    blocks,
    resolveGeom,
    rowGroups,
    getContainerGrowth,
    relayTargets,
  });
}

test('stage ignores row growth that does not move or extend the deepest block', () => {
  const growing = block('text', BLOCK_TYPES.TEXT, 100, 800);
  const deepest = block('final', BLOCK_TYPES.SECTION, 800, 200);
  const rows = [row({
    top: 100,
    refBottom: 900,
    growth: 100,
    renderedHeight: 900,
    members: [member('text', 900)],
  })];

  assert.equal(height({ baseHeight: 1000, blocks: [growing, deepest], rowGroups: rows }), 1000);
});

test('accordion growth uses the authored gap before moving the final block', () => {
  const growing = block('accordion', BLOCK_TYPES.ACCORDION, 100, 100);
  const deepest = block('final', BLOCK_TYPES.SECTION, 500, 200);
  const rows = [row({
    top: 100,
    refBottom: 200,
    growth: 150,
    renderedHeight: 250,
    members: [member('accordion', 250)],
  })];

  assert.equal(height({ baseHeight: 700, blocks: [growing, deepest], rowGroups: rows }), 700);
});

test('a final auto-height block extends the stage by its own measured growth', () => {
  const final = block('accordion', BLOCK_TYPES.ACCORDION, 500, 100);
  const rows = [row({
    top: 500,
    refBottom: 600,
    growth: 150,
    renderedHeight: 250,
    members: [member('accordion', 250)],
  })];

  assert.equal(height({ baseHeight: 600, blocks: [final], rowGroups: rows }), 750);
});

test('a growing row extends the stage when its rendered bottom overtakes a deeper static block', () => {
  const growing = block('text', BLOCK_TYPES.TEXT, 100, 350);
  const staticBlock = block('static', BLOCK_TYPES.IMAGE, 300, 100);
  const rows = [row({
    top: 100,
    refBottom: 450,
    growth: 150,
    renderedHeight: 500,
    members: [member('text', 500)],
  })];

  assert.equal(height({ baseHeight: 450, blocks: [growing, staticBlock], rowGroups: rows }), 600);
});

test('ordinary measured shrink never collapses authored stage geometry', () => {
  const final = block('text', BLOCK_TYPES.TEXT, 500, 100);
  const rows = [row({
    top: 500,
    refBottom: 600,
    growth: 0,
    renderedHeight: 50,
    members: [member('text', 50)],
  })];

  assert.equal(height({ baseHeight: 600, blocks: [final], rowGroups: rows }), 600);
});

test('signed aspect-carousel shrink follows the actual pulled-up final bottom', () => {
  const carousel = block('hero', BLOCK_TYPES.HERO_CAROUSEL, 0, 500);
  const final = block('final', BLOCK_TYPES.SECTION, 500, 200);
  const rows = [row({
    top: 0,
    refBottom: 500,
    growth: -200,
    renderedHeight: 300,
    members: [member('hero', 300, { signed: true })],
    signed: true,
  })];

  assert.equal(height({ baseHeight: 700, blocks: [carousel, final], rowGroups: rows }), 500);
});

test('a deepest container contributes the same live growth used by its wrapper', () => {
  const section = block('section', BLOCK_TYPES.SECTION, 0, 700);
  const rows = [row({
    top: 100,
    refBottom: 200,
    growth: 100,
    renderedHeight: 200,
    members: [member('text', 200)],
  })];

  assert.equal(height({
    baseHeight: 700,
    blocks: [section],
    rowGroups: rows,
    getContainerGrowth: () => 100,
  }), 800);
});

test('plain auto-height blocks in separate columns form independent reflow rows', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'left-accordion', x: 0, w: 600, measuredH: 300 }),
    entry({ id: 'right-text', x: 650, w: 550, measuredH: 180 }),
  ]);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((item) => item.ids), [['left-accordion'], ['right-text']]);
});

test('cards retain cross-column row equalisation', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'left-card', x: 0, w: 360, measuredH: 180, isCard: true }),
    entry({ id: 'right-card', x: 400, w: 360, measuredH: 240, isCard: true }),
  ]);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].ids, ['left-card', 'right-card']);
  assert.equal(rows[0].renderedHeight, 240);
  assert.equal(rows[0].growth, 140);
});

test('left-column accordion growth does not move a right-column target', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'left-accordion', x: 0, w: 600, measuredH: 300 }),
  ]);

  assert.equal(offsetForTargetGeom(rows, { x: 650, y: 250, w: 550, h: 100 }), 0);
  assert.equal(offsetForTargetGeom(rows, { x: 0, y: 250, w: 600, h: 100 }), 50);
});

test('reflow follows the active breakpoint geometry when columns stack on mobile', () => {
  const desktopRows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, w: 560, measuredH: 300 }),
  ]);
  const mobileRows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, w: 375, measuredH: 300 }),
  ]);

  assert.equal(
    offsetForTargetGeom(desktopRows, { x: 640, y: 250, w: 560, h: 100 }),
    0,
  );
  assert.equal(
    offsetForTargetGeom(mobileRows, { x: 0, y: 250, w: 375, h: 100 }),
    50,
  );
});

test('a spanning target follows the greatest side-by-side row growth without double-counting', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'left-accordion', x: 0, w: 580, measuredH: 300 }),
    entry({ id: 'right-accordion', x: 620, w: 580, measuredH: 220 }),
  ]);

  assert.equal(offsetForTargetGeom(rows, { x: 0, y: 250, w: 1200, h: 100 }), 50);
  assert.equal(offsetForTargetGeom(rows, { x: 900, y: 250, w: 20, h: 100, fullWidth: true }), 50);
});

test('stacked collisions preserve gaps and pass only remaining displacement', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'upper', x: 0, y: 0, w: 600, h: 100, measuredH: 300 }),
    entry({ id: 'lower', x: 0, y: 150, w: 600, h: 100, measuredH: 150 }),
  ]);

  assert.equal(offsetForTargetGeom(rows, { x: 0, y: 400, w: 600, h: 100 }), 50);
  assert.equal(offsetForTargetGeom(rows, { x: 650, y: 400, w: 550, h: 100 }), 0);
});

test('container growth preserves authored room beneath independent lanes', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'left-accordion', x: 0, w: 580, measuredH: 300 }),
    entry({ id: 'right-accordion', x: 620, w: 580, measuredH: 220 }),
  ]);

  assert.equal(growthForContainedGeom(rows, { x: 0, y: 0, w: 580, h: 500 }), 0);
  assert.equal(growthForContainedGeom(rows, { x: 620, y: 0, w: 580, h: 500 }), 0);
  assert.equal(growthForContainedGeom(rows, { x: 0, y: 0, w: 1200, h: 500 }), 0);
});

test('an authored gap keeps a Box and its static content in place', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, y: 0, w: 600, h: 100, measuredH: 300 }),
  ]);
  const boxGeom = { x: 0, y: 400, w: 600, h: 300 };
  const memberGeom = { x: 20, y: 440, w: 560, h: 100 };
  const relativeOffset = relativeOffsetWithinContainer(rows, memberGeom, boxGeom);

  assert.equal(offsetForTargetGeom(rows, boxGeom), 0);
  assert.equal(offsetForTargetGeom(rows, memberGeom), 0);
  assert.equal(relativeOffset, 0);
  assert.equal(computeBoxGrowthDelta({
    containerTop: boxGeom.y,
    containerHeight: boxGeom.h,
    rows: [{
      storedBottom: memberGeom.y + memberGeom.h,
      measuredBottom: memberGeom.y + memberGeom.h + relativeOffset,
    }],
  }), 0);
});

test('stage height does not grow when only the deepest right-column block is unrelated', () => {
  const accordion = block('accordion', BLOCK_TYPES.ACCORDION, 0, 100, 0, 600);
  const rightDeepest = block('right-deepest', BLOCK_TYPES.IMAGE, 500, 200, 650, 550);
  const rows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, w: 600, measuredH: 300 }),
  ]);

  assert.equal(height({
    baseHeight: 700,
    blocks: [accordion, rightDeepest],
    rowGroups: rows,
  }), 700);
});

test('stage height preserves authored room beneath the accordion lane', () => {
  const accordion = block('accordion', BLOCK_TYPES.ACCORDION, 0, 100, 0, 600);
  const leftDeepest = block('left-deepest', BLOCK_TYPES.IMAGE, 500, 200, 0, 600);
  const rows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, w: 600, measuredH: 300 }),
  ]);

  assert.equal(height({
    baseHeight: 700,
    blocks: [accordion, leftDeepest],
    rowGroups: rows,
  }), 700);
});

test('growth smaller than the available gap does not move content', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'accordion', y: 0, h: 100, measuredH: 250 }),
  ]);

  assert.equal(offsetForTargetGeom(rows, { x: 0, y: 300, w: 100, h: 100 }), 0);
});

test('growth that exactly fills the available gap does not move content', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'accordion', y: 0, h: 100, measuredH: 300 }),
  ]);

  assert.equal(offsetForTargetGeom(rows, { x: 0, y: 300, w: 100, h: 100 }), 0);
});

test('partial overlap moves content by exactly the overlap and collapse restores zero', () => {
  const expandedRows = buildReflowRowGroups([
    entry({ id: 'accordion', y: 0, h: 100, measuredH: 340 }),
  ]);
  const collapsedRows = buildReflowRowGroups([
    entry({ id: 'accordion', y: 0, h: 100, measuredH: 100 }),
  ]);
  const target = { x: 0, y: 300, w: 100, h: 100 };

  assert.equal(offsetForTargetGeom(expandedRows, target), 40);
  assert.equal(offsetForTargetGeom(collapsedRows, target), 0);
});

test('a chained collision consumes both authored gaps before reaching the target', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'upper', x: 0, y: 0, w: 500, h: 100, measuredH: 280 }),
    entry({ id: 'lower', x: 0, y: 240, w: 500, h: 100, measuredH: 180 }),
  ]);

  // Upper crosses lower by 40. Lower then ends at 460, crossing the target by
  // only 30 after consuming the target's authored 90px gap.
  assert.equal(offsetForTargetGeom(rows, { x: 0, y: 430, w: 500, h: 100 }), 30);
});

test('a displaced static block relays its remaining collision to the next block', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, y: 0, w: 600, h: 100, measuredH: 300 }),
  ]);
  const first = {
    id: 'first-static',
    x: 0,
    y: 250,
    w: 600,
    h: 200,
    top: 250,
    bottom: 450,
  };
  const second = {
    id: 'second-static',
    x: 0,
    y: 460,
    w: 600,
    h: 100,
    top: 460,
    bottom: 560,
  };
  const relays = [first, second];
  const containedTargets = [
    {
      id: 'accordion',
      x: 0,
      y: 0,
      w: 600,
      h: 100,
      top: 0,
      bottom: 100,
    },
    first,
    second,
  ];

  assert.equal(offsetForTargetGeom(rows, first, relays), 50);
  assert.equal(offsetForTargetGeom(rows, second, relays), 40);
  assert.equal(growthForContainedGeom(
    rows,
    { x: 0, y: 0, w: 600, h: 560 },
    containedTargets,
    { relayTargets: relays },
  ), 40);
});

test('card rows keep equalized height when collision displacement is calculated', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'left-card', x: 0, y: 0, w: 360, h: 100, measuredH: 180, isCard: true }),
    entry({ id: 'right-card', x: 400, y: 0, w: 360, h: 100, measuredH: 240, isCard: true }),
  ]);

  assert.equal(rows[0].renderedHeight, 240);
  assert.equal(offsetForTargetGeom(rows, { x: 0, y: 200, w: 760, h: 100 }), 40);
});

test('a displaced static child grows a Section or Box by only its final overflow', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, y: 100, w: 600, h: 100, measuredH: 300 }),
  ]);
  const container = { x: 0, y: 0, w: 600, h: 500 };
  const targets = [
    { id: 'accordion', x: 0, y: 100, w: 600, h: 100, top: 100, bottom: 200 },
    { id: 'image', x: 0, y: 350, w: 600, h: 140, top: 350, bottom: 490 },
  ];

  // Accordion ends at 400, pushing the image 50px. Its final bottom is 540,
  // therefore the background grows 40px rather than the accordion's 200px.
  assert.equal(growthForContainedGeom(rows, container, targets), 40);
});

test('ordinary collision composes with signed carousel container sizing', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, y: 0, w: 600, h: 100, measuredH: 300 }),
    entry({
      id: 'carousel',
      x: 0,
      y: 250,
      w: 600,
      h: 200,
      measuredH: 150,
      referenceH: 200,
      signed: true,
    }),
  ]);
  const container = { x: 0, y: 0, w: 600, h: 450 };
  const targets = [
    { id: 'accordion', x: 0, y: 0, w: 600, h: 100, top: 0, bottom: 100 },
    { id: 'carousel', x: 0, y: 250, w: 600, h: 200, top: 250, bottom: 450 },
  ];

  // The carousel's signed shrink would reduce the container by 50px, but the
  // accordion collides with and moves it 50px, putting its live bottom back at
  // the authored boundary.
  assert.equal(growthForContainedGeom(rows, container, targets), 0);
});

test('a Box stays at its authored height when a signed carousel shrinks', () => {
  const rows = buildReflowRowGroups([
    entry({
      id: 'carousel',
      x: 0,
      y: 0,
      w: 600,
      h: 200,
      measuredH: 150,
      referenceH: 200,
      signed: true,
    }),
  ]);
  const container = { x: 0, y: 0, w: 600, h: 200 };
  const targets = [
    { id: 'carousel', x: 0, y: 0, w: 600, h: 200, top: 0, bottom: 200 },
  ];

  // Sections preserve the signed carousel shrink; decorative Boxes retain
  // their authored height on the public page.
  assert.equal(growthForContainedGeom(rows, container, targets), -50);
  assert.equal(growthForContainedGeom(rows, container, targets, { growOnly: true }), 0);
});

test('a signed carousel relays only the residual collision to a following block', () => {
  const cancellingRows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, y: 0, w: 600, h: 100, measuredH: 300 }),
    entry({
      id: 'carousel',
      x: 0,
      y: 250,
      w: 600,
      h: 200,
      measuredH: 150,
      referenceH: 200,
      signed: true,
    }),
  ]);
  const residualRows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, y: 0, w: 600, h: 100, measuredH: 320 }),
    entry({
      id: 'carousel',
      x: 0,
      y: 250,
      w: 600,
      h: 200,
      measuredH: 150,
      referenceH: 200,
      signed: true,
    }),
  ]);
  const target = { x: 0, y: 450, w: 600, h: 100 };

  // A 50px accordion collision and 50px carousel shrink cancel exactly.
  assert.equal(offsetForTargetGeom(cancellingRows, target), 0);
  // With a 70px collision, only the uncancelled 20px reaches the target.
  assert.equal(offsetForTargetGeom(residualRows, target), 20);
});

test('stage height follows the deepest final static bottom after collision', () => {
  const accordion = block('accordion', BLOCK_TYPES.ACCORDION, 100, 100, 0, 600);
  const image = block('image', BLOCK_TYPES.IMAGE, 350, 140, 0, 600);
  const rows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, y: 100, w: 600, h: 100, measuredH: 300 }),
  ]);

  assert.equal(height({
    baseHeight: 500,
    blocks: [accordion, image],
    rowGroups: rows,
  }), 540);
});

test('stage height includes collision relayed through stacked static blocks', () => {
  const accordion = block('accordion', BLOCK_TYPES.ACCORDION, 0, 100, 0, 600);
  const first = block('first-static', BLOCK_TYPES.IMAGE, 250, 200, 0, 600);
  const second = block('second-static', BLOCK_TYPES.IMAGE, 460, 100, 0, 600);
  const rows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, y: 0, w: 600, h: 100, measuredH: 300 }),
  ]);
  const relayTargets = [
    { id: first.id, ...first.geom, top: 250, bottom: 450 },
    { id: second.id, ...second.geom, top: 460, bottom: 560 },
  ];

  assert.equal(height({
    baseHeight: 560,
    blocks: [accordion, first, second],
    rowGroups: rows,
    relayTargets,
  }), 600);
});