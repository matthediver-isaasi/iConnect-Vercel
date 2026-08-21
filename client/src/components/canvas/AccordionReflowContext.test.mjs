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

function height({ baseHeight, blocks, rowGroups, getContainerGrowth = () => 0 }) {
  return computeReflowStageHeight({
    baseHeight,
    blocks,
    resolveGeom,
    rowGroups,
    getContainerGrowth,
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

test('accordion/text growth extends the stage by the offset applied to the final block', () => {
  const growing = block('accordion', BLOCK_TYPES.ACCORDION, 100, 100);
  const deepest = block('final', BLOCK_TYPES.SECTION, 500, 200);
  const rows = [row({
    top: 100,
    refBottom: 200,
    growth: 150,
    renderedHeight: 250,
    members: [member('accordion', 250)],
  })];

  assert.equal(height({ baseHeight: 700, blocks: [growing, deepest], rowGroups: rows }), 850);
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

  assert.equal(offsetForTargetGeom(rows, { x: 650, y: 400, w: 550, h: 100 }), 0);
  assert.equal(offsetForTargetGeom(rows, { x: 0, y: 400, w: 600, h: 100 }), 200);
});

test('reflow follows the active breakpoint geometry when columns stack on mobile', () => {
  const desktopRows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, w: 560, measuredH: 300 }),
  ]);
  const mobileRows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, w: 375, measuredH: 300 }),
  ]);

  assert.equal(
    offsetForTargetGeom(desktopRows, { x: 640, y: 400, w: 560, h: 100 }),
    0,
  );
  assert.equal(
    offsetForTargetGeom(mobileRows, { x: 0, y: 400, w: 375, h: 100 }),
    200,
  );
});

test('a spanning target follows the greatest side-by-side row growth without double-counting', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'left-accordion', x: 0, w: 580, measuredH: 300 }),
    entry({ id: 'right-accordion', x: 620, w: 580, measuredH: 220 }),
  ]);

  assert.equal(offsetForTargetGeom(rows, { x: 0, y: 400, w: 1200, h: 100 }), 200);
  assert.equal(offsetForTargetGeom(rows, { x: 900, y: 400, w: 20, h: 100, fullWidth: true }), 200);
});

test('growth from vertically stacked blocks accumulates within the same column', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'upper', x: 0, y: 0, w: 600, h: 100, measuredH: 300 }),
    entry({ id: 'lower', x: 0, y: 150, w: 600, h: 100, measuredH: 150 }),
  ]);

  assert.equal(offsetForTargetGeom(rows, { x: 0, y: 400, w: 600, h: 100 }), 250);
  assert.equal(offsetForTargetGeom(rows, { x: 650, y: 400, w: 550, h: 100 }), 0);
});

test('container growth follows contained lanes but ignores growth in an adjacent column', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'left-accordion', x: 0, w: 580, measuredH: 300 }),
    entry({ id: 'right-accordion', x: 620, w: 580, measuredH: 220 }),
  ]);

  assert.equal(growthForContainedGeom(rows, { x: 0, y: 0, w: 580, h: 500 }), 200);
  assert.equal(growthForContainedGeom(rows, { x: 620, y: 0, w: 580, h: 500 }), 120);
  assert.equal(growthForContainedGeom(rows, { x: 0, y: 0, w: 1200, h: 500 }), 200);
});

test('upstream growth moves a Box and its static content together without growing the Box', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, y: 0, w: 600, h: 100, measuredH: 300 }),
  ]);
  const boxGeom = { x: 0, y: 400, w: 600, h: 300 };
  const memberGeom = { x: 20, y: 440, w: 560, h: 100 };
  const relativeOffset = relativeOffsetWithinContainer(rows, memberGeom, boxGeom);

  assert.equal(offsetForTargetGeom(rows, boxGeom), 200);
  assert.equal(offsetForTargetGeom(rows, memberGeom), 200);
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

test('stage height grows when the deepest block is beneath the accordion lane', () => {
  const accordion = block('accordion', BLOCK_TYPES.ACCORDION, 0, 100, 0, 600);
  const leftDeepest = block('left-deepest', BLOCK_TYPES.IMAGE, 500, 200, 0, 600);
  const rows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, w: 600, measuredH: 300 }),
  ]);

  assert.equal(height({
    baseHeight: 700,
    blocks: [accordion, leftDeepest],
    rowGroups: rows,
  }), 900);
});