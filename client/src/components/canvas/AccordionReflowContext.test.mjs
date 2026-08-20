import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK_TYPES } from '../../lib/canvasDesign.js';
import { computeReflowStageHeight } from './reflowStageHeight.js';

const block = (id, type, y, h) => ({ id, type, geom: { x: 0, y, w: 100, h, hidden: false } });
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