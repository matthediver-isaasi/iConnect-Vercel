import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK_TYPES } from '../../lib/canvasDesign.js';
import {
  buildReflowRowGroups,
  computeReflowStageHeight,
  growthForContainedGeom,
  offsetForTargetGeom,
  relativeOffsetWithinContainer,
  resolveSectionAwareOffsets,
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
  allowSectionBottomOverflow = true,
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
  allowSectionBottomOverflow,
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

test('a moved Section carries paragraph text from a non-colliding lane with it', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, y: 0, w: 600, h: 100, measuredH: 300 }),
  ]);
  const section = {
    id: 'section',
    x: 0,
    y: 250,
    w: 1200,
    h: 400,
    top: 250,
    bottom: 650,
    fullWidth: true,
  };
  const heading = {
    id: 'heading',
    x: 0,
    y: 250,
    w: 500,
    h: 80,
    top: 250,
    bottom: 330,
  };
  const image = {
    id: 'image',
    x: 0,
    y: 340,
    w: 500,
    h: 120,
    top: 340,
    bottom: 460,
  };
  const paragraph = {
    id: 'paragraph',
    x: 650,
    y: 300,
    w: 500,
    h: 140,
    top: 300,
    bottom: 440,
  };
  const external = {
    id: 'external',
    x: 650,
    y: 800,
    w: 500,
    h: 100,
    top: 800,
    bottom: 900,
  };
  const targets = [section, heading, image, paragraph, external];
  const result = resolveSectionAwareOffsets({
    rowGroups: rows,
    targets,
    sectionTargets: [section],
    relayTargets: [heading, image, external],
  });

  assert.equal(result.offsets.get('section'), 50);
  assert.equal(result.offsets.get('heading'), 50);
  assert.equal(result.offsets.get('image'), 50);
  assert.equal(result.offsets.get('paragraph'), 50);
  assert.equal(result.offsets.get('external'), 0);
  assert.equal(result.owners.get('paragraph'), 'section');
});

test('a moved Box carries the exact BNMS panel contents by one shared offset', () => {
  const expandedRows = buildReflowRowGroups([
    entry({
      id: 'accordion',
      x: 0,
      y: 1784,
      w: 1200,
      h: 426,
      measuredH: 567,
    }),
  ]);
  const collapsedRows = buildReflowRowGroups([
    entry({
      id: 'accordion',
      x: 0,
      y: 1784,
      w: 1200,
      h: 426,
      measuredH: 426,
    }),
  ]);
  const box = {
    id: 'box',
    containerType: BLOCK_TYPES.BOX,
    x: 0,
    y: 2250,
    w: 1200,
    h: 352,
    top: 2250,
    bottom: 2602,
  };
  const icon = {
    id: 'icon',
    x: 16,
    y: 2258,
    w: 88,
    h: 88,
    top: 2258,
    bottom: 2346,
  };
  const heading = {
    id: 'heading',
    x: 112,
    y: 2280,
    w: 392,
    h: 66,
    top: 2280,
    bottom: 2346,
  };
  const paragraph = {
    id: 'paragraph',
    x: 112,
    y: 2330,
    w: 1056,
    h: 255,
    top: 2330,
    bottom: 2585,
    allowSectionBottomOverflow: true,
  };
  const edgeStraddlingText = {
    id: 'edge-straddling-text',
    x: 112,
    y: 2500,
    w: 1056,
    h: 150,
    top: 2500,
    bottom: 2650,
    allowSectionBottomOverflow: true,
  };
  const adjacent = {
    id: 'adjacent',
    x: 1220,
    y: 2330,
    w: 300,
    h: 100,
    top: 2330,
    bottom: 2430,
  };
  const targets = [box, icon, heading, paragraph, edgeStraddlingText, adjacent];

  const expanded = resolveSectionAwareOffsets({
    rowGroups: expandedRows,
    targets,
    containerTargets: [box],
    relayTargets: [icon, heading, edgeStraddlingText, adjacent],
  });

  assert.equal(expanded.offsets.get('box'), 101);
  assert.equal(expanded.offsets.get('icon'), 101);
  assert.equal(expanded.offsets.get('heading'), 101);
  assert.equal(expanded.offsets.get('paragraph'), 101);
  assert.equal(expanded.owners.get('icon'), 'box');
  assert.equal(expanded.owners.get('heading'), 'box');
  assert.equal(expanded.owners.get('paragraph'), 'box');
  assert.equal(expanded.offsets.get('edge-straddling-text'), 0);
  assert.equal(expanded.owners.has('edge-straddling-text'), false);
  assert.equal(expanded.offsets.get('adjacent'), 0);
  assert.equal(expanded.owners.has('adjacent'), false);

  const collapsed = resolveSectionAwareOffsets({
    rowGroups: collapsedRows,
    targets,
    containerTargets: [box],
    relayTargets: [icon, heading, edgeStraddlingText, adjacent],
  });
  assert.equal(collapsed.offsets.get('box'), 0);
  assert.equal(collapsed.offsets.get('icon'), 0);
  assert.equal(collapsed.offsets.get('heading'), 0);
  assert.equal(collapsed.offsets.get('paragraph'), 0);
});

test('a moved Section carries an edge-straddling auto-height paragraph before and after measurement', () => {
  const unmeasuredTextRows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, y: 0, w: 600, h: 100, measuredH: 300 }),
  ]);
  const measuredTextRows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, y: 0, w: 600, h: 100, measuredH: 300 }),
    entry({
      id: 'paragraph',
      x: 650,
      y: 300,
      w: 500,
      h: 180,
      measuredH: 220,
    }),
  ]);
  const collapsedRows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, y: 0, w: 600, h: 100, measuredH: 100 }),
    entry({
      id: 'paragraph',
      x: 650,
      y: 300,
      w: 500,
      h: 180,
      measuredH: 220,
    }),
  ]);
  const section = {
    id: 'section',
    x: 0,
    y: 250,
    w: 1200,
    h: 200,
    top: 250,
    bottom: 450,
    fullWidth: true,
  };
  const heading = {
    id: 'heading',
    x: 0,
    y: 270,
    w: 500,
    h: 50,
    top: 270,
    bottom: 320,
  };
  const image = {
    id: 'image',
    x: 0,
    y: 330,
    w: 500,
    h: 100,
    top: 330,
    bottom: 430,
  };
  // Real public text can begin inside a Section while its stored auto-height
  // box extends below the Section's authored edge.
  const paragraph = {
    id: 'paragraph',
    x: 650,
    y: 300,
    w: 500,
    h: 180,
    top: 300,
    bottom: 480,
    allowSectionBottomOverflow: true,
  };
  const fixedOverlay = {
    id: 'fixed-overlay',
    x: 875,
    y: 300,
    w: 100,
    h: 300,
    top: 300,
    bottom: 600,
  };
  const childBox = {
    id: 'child-box',
    x: 1000,
    y: 300,
    w: 100,
    h: 300,
    top: 300,
    bottom: 600,
  };
  const nestedSection = {
    id: 'nested-section',
    x: 1120,
    y: 300,
    w: 80,
    h: 300,
    top: 300,
    bottom: 600,
  };
  const adjacentParagraph = {
    id: 'adjacent-paragraph',
    x: 1220,
    y: 300,
    w: 300,
    h: 180,
    top: 300,
    bottom: 480,
    allowSectionBottomOverflow: true,
  };
  const targets = [
    section,
    heading,
    image,
    paragraph,
    fixedOverlay,
    childBox,
    nestedSection,
    adjacentParagraph,
  ];
  const relays = [heading, image, fixedOverlay, adjacentParagraph];
  const sectionTargets = [section, nestedSection];

  for (const rowGroups of [unmeasuredTextRows, measuredTextRows]) {
    const result = resolveSectionAwareOffsets({
      rowGroups,
      targets,
      sectionTargets,
      relayTargets: relays,
    });

    assert.equal(result.offsets.get('section'), 50);
    assert.equal(result.offsets.get('heading'), 50);
    assert.equal(result.offsets.get('image'), 50);
    assert.equal(result.offsets.get('paragraph'), 50);
    assert.equal(result.owners.get('paragraph'), 'section');
    assert.equal(result.offsets.get('fixed-overlay'), 0);
    assert.equal(result.owners.has('fixed-overlay'), false);
    assert.equal(result.offsets.get('child-box'), 0);
    assert.equal(result.owners.has('child-box'), false);
    assert.equal(result.offsets.get('nested-section'), 0);
    assert.equal(result.owners.has('nested-section'), false);
    assert.equal(result.offsets.get('adjacent-paragraph'), 0);
    assert.equal(result.owners.has('adjacent-paragraph'), false);
  }

  const collapsedResult = resolveSectionAwareOffsets({
    rowGroups: collapsedRows,
    targets,
    sectionTargets,
    relayTargets: relays,
  });
  assert.equal(collapsedResult.offsets.get('section'), 0);
  assert.equal(collapsedResult.offsets.get('paragraph'), 0);
  assert.equal(collapsedResult.owners.get('paragraph'), 'section');

  const measuredResult = resolveSectionAwareOffsets({
    rowGroups: measuredTextRows,
    targets,
    sectionTargets,
    relayTargets: relays,
  });
  const containedTargets = [
    heading,
    image,
    paragraph,
    fixedOverlay,
    childBox,
    nestedSection,
  ];
  const sectionGrowth = growthForContainedGeom(
    measuredTextRows,
    section,
    containedTargets,
    {
      relayTargets: relays,
      inheritedOffsets: measuredResult.inheritedOffsets,
      allowBottomOverflow: true,
    },
  );

  // The moved Section ends at 500. The measured paragraph ends at 570 after
  // inheriting the same 50px movement, so the wrapper grows by the remaining
  // 70px and the stage uses that same final bottom.
  assert.equal(sectionGrowth, 70);
  assert.equal(computeReflowStageHeight({
    baseHeight: 450,
    blocks: [
      {
        id: 'section',
        type: BLOCK_TYPES.SECTION,
        fullWidth: true,
        geom: { x: 0, y: 250, w: 1200, h: 200, hidden: false },
      },
      block('heading', BLOCK_TYPES.TEXT, 270, 50, 0, 500),
      block('image', BLOCK_TYPES.IMAGE, 330, 100, 0, 500),
      block('paragraph', BLOCK_TYPES.TEXT, 300, 180, 650, 500),
      block('adjacent-paragraph', BLOCK_TYPES.TEXT, 300, 180, 1220, 300),
    ],
    resolveGeom,
    rowGroups: measuredTextRows,
    relayTargets: relays,
    inheritedOffsets: measuredResult.inheritedOffsets,
    getContainerGrowth: (containerBlock) => (
      containerBlock.id === 'section' ? sectionGrowth : 0
    ),
  }), 570);
});

test('a contained block can move farther than its displaced Section after a local collision', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'outer-accordion', x: 0, y: 0, w: 600, h: 100, measuredH: 300 }),
    entry({ id: 'inner-accordion', x: 0, y: 400, w: 600, h: 100, measuredH: 300 }),
  ]);
  const section = {
    id: 'section',
    x: 0,
    y: 250,
    w: 1200,
    h: 600,
    top: 250,
    bottom: 850,
    fullWidth: true,
  };
  const innerAccordion = {
    id: 'inner-accordion',
    x: 0,
    y: 400,
    w: 600,
    h: 100,
    top: 400,
    bottom: 500,
  };
  const child = {
    id: 'child',
    x: 0,
    y: 680,
    w: 600,
    h: 100,
    top: 680,
    bottom: 780,
  };
  const result = resolveSectionAwareOffsets({
    rowGroups: rows,
    targets: [section, innerAccordion, child],
    sectionTargets: [section],
    relayTargets: [child],
  });

  assert.equal(result.offsets.get('section'), 50);
  assert.equal(result.offsets.get('inner-accordion'), 50);
  assert.equal(result.offsets.get('child'), 70);
});

test('a contained block can move farther than its displaced Box after a local collision', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'outer-accordion', x: 0, y: 0, w: 600, h: 100, measuredH: 300 }),
    entry({ id: 'inner-accordion', x: 0, y: 400, w: 600, h: 100, measuredH: 300 }),
  ]);
  const box = {
    id: 'box',
    containerType: BLOCK_TYPES.BOX,
    x: 0,
    y: 250,
    w: 1200,
    h: 600,
    top: 250,
    bottom: 850,
  };
  const innerAccordion = {
    id: 'inner-accordion',
    x: 0,
    y: 400,
    w: 600,
    h: 100,
    top: 400,
    bottom: 500,
  };
  const child = {
    id: 'child',
    x: 0,
    y: 680,
    w: 600,
    h: 100,
    top: 680,
    bottom: 780,
  };
  const result = resolveSectionAwareOffsets({
    rowGroups: rows,
    targets: [box, innerAccordion, child],
    containerTargets: [box],
    relayTargets: [child],
  });

  assert.equal(result.offsets.get('box'), 50);
  assert.equal(result.offsets.get('inner-accordion'), 50);
  assert.equal(result.offsets.get('child'), 70);
  assert.equal(result.owners.get('child'), 'box');
});

test('a Section-inherited auto-height child relays from its final rendered bottom', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, y: 0, w: 600, h: 100, measuredH: 300 }),
    entry({
      id: 'paragraph',
      x: 650,
      y: 300,
      w: 500,
      h: 140,
      measuredH: 140,
    }),
  ]);
  const section = {
    id: 'section',
    x: 0,
    y: 250,
    w: 1200,
    h: 200,
    top: 250,
    bottom: 450,
    fullWidth: true,
  };
  const paragraph = {
    id: 'paragraph',
    x: 650,
    y: 300,
    w: 500,
    h: 140,
    top: 300,
    bottom: 440,
  };
  const laterContent = {
    id: 'later-content',
    x: 650,
    y: 460,
    w: 500,
    h: 100,
    top: 460,
    bottom: 560,
  };
  const result = resolveSectionAwareOffsets({
    rowGroups: rows,
    targets: [section, paragraph, laterContent],
    sectionTargets: [section],
    relayTargets: [laterContent],
  });

  assert.equal(result.offsets.get('section'), 50);
  assert.equal(result.offsets.get('paragraph'), 50);
  // Paragraph's final bottom is 490, so content outside the Section at y=460
  // follows by only the 30px collision that remains.
  assert.equal(result.offsets.get('later-content'), 30);
  assert.equal(result.owners.has('later-content'), false);
});

test('full-width rendering does not attach a block outside the Section rectangle', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'outer-accordion', x: 0, y: 0, w: 600, h: 100, measuredH: 300 }),
    entry({ id: 'inner-content', x: 0, y: 300, w: 600, h: 100, measuredH: 100 }),
    entry({ id: 'external', x: 650, y: 300, w: 100, h: 100, measuredH: 300 }),
  ]);
  const section = {
    id: 'section',
    x: 0,
    y: 250,
    w: 600,
    h: 300,
    top: 250,
    bottom: 550,
    left: 0,
    right: 600,
    fullWidth: true,
  };
  const innerContent = {
    id: 'inner-content',
    x: 0,
    y: 300,
    w: 600,
    h: 100,
    top: 300,
    bottom: 400,
    left: 0,
    right: 600,
  };
  const external = {
    id: 'external',
    x: 650,
    y: 300,
    w: 100,
    h: 100,
    top: 300,
    bottom: 400,
    left: 650,
    right: 750,
  };
  const targets = [section, innerContent, external];
  const result = resolveSectionAwareOffsets({
    rowGroups: rows,
    targets,
    sectionTargets: [section],
    relayTargets: [],
  });

  assert.equal(result.offsets.get('section'), 50);
  assert.equal(result.offsets.get('inner-content'), 50);
  assert.equal(result.offsets.get('external'), 0);
  assert.equal(result.owners.has('external'), false);

  const sectionGrowth = growthForContainedGeom(rows, section, [innerContent, external], {
    relayTargets: [],
    inheritedOffsets: result.inheritedOffsets,
  });
  assert.equal(sectionGrowth, 0);

  const sectionBlock = {
    id: 'section',
    type: BLOCK_TYPES.SECTION,
    fullWidth: true,
    geom: { x: 0, y: 250, w: 600, h: 300, hidden: false },
  };
  const innerBlock = block('inner-content', BLOCK_TYPES.TEXT, 300, 100, 0, 600);
  const externalBlock = block('external', BLOCK_TYPES.TEXT, 300, 100, 650, 100);
  assert.equal(computeReflowStageHeight({
    baseHeight: 600,
    blocks: [sectionBlock, innerBlock, externalBlock],
    resolveGeom,
    rowGroups: rows,
    relayTargets: [],
    inheritedOffsets: result.inheritedOffsets,
    getContainerGrowth: () => sectionGrowth,
  }), 600);
});

test('container growth uses inherited and local child displacement consistently', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'outer-accordion', x: 0, y: 0, w: 600, h: 100, measuredH: 300 }),
    entry({ id: 'inner-accordion', x: 0, y: 400, w: 600, h: 100, measuredH: 300 }),
  ]);
  const section = {
    id: 'section',
    x: 0,
    y: 250,
    w: 1200,
    h: 500,
    top: 250,
    bottom: 750,
    fullWidth: true,
  };
  const innerAccordion = {
    id: 'inner-accordion',
    x: 0,
    y: 400,
    w: 600,
    h: 100,
    top: 400,
    bottom: 500,
  };
  const child = {
    id: 'child',
    x: 0,
    y: 640,
    w: 600,
    h: 100,
    top: 640,
    bottom: 740,
  };
  const targets = [section, innerAccordion, child];
  const relays = [child];
  const result = resolveSectionAwareOffsets({
    rowGroups: rows,
    targets,
    sectionTargets: [section],
    relayTargets: relays,
  });

  assert.equal(result.offsets.get('section'), 50);
  assert.equal(result.offsets.get('child'), 110);
  // The moved Section ends at 800; the child ends at 850, so only 50px of
  // additional height is required.
  assert.equal(growthForContainedGeom(rows, section, targets, {
    relayTargets: relays,
    inheritedOffsets: result.inheritedOffsets,
  }), 50);
});

test('nested Sections inherit once and adjacent Section contents remain independent', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, y: 0, w: 600, h: 100, measuredH: 300 }),
  ]);
  const outer = {
    id: 'outer',
    x: 0,
    y: 250,
    w: 1200,
    h: 500,
    top: 250,
    bottom: 750,
    fullWidth: true,
  };
  const inner = {
    id: 'inner',
    x: 100,
    y: 300,
    w: 500,
    h: 300,
    top: 300,
    bottom: 600,
  };
  const nestedText = {
    id: 'nested-text',
    x: 150,
    y: 350,
    w: 400,
    h: 100,
    top: 350,
    bottom: 450,
  };
  const adjacent = {
    id: 'adjacent',
    x: 650,
    y: 800,
    w: 500,
    h: 300,
    top: 800,
    bottom: 1100,
  };
  const adjacentText = {
    id: 'adjacent-text',
    x: 700,
    y: 850,
    w: 400,
    h: 100,
    top: 850,
    bottom: 950,
  };
  const result = resolveSectionAwareOffsets({
    rowGroups: rows,
    targets: [outer, inner, nestedText, adjacent, adjacentText],
    sectionTargets: [outer, inner, adjacent],
    relayTargets: [nestedText, adjacentText],
  });

  assert.equal(result.offsets.get('outer'), 50);
  assert.equal(result.offsets.get('inner'), 50);
  assert.equal(result.offsets.get('nested-text'), 50);
  assert.equal(result.offsets.get('adjacent'), 0);
  assert.equal(result.offsets.get('adjacent-text'), 0);
  assert.equal(result.owners.get('inner'), 'outer');
  assert.equal(result.owners.get('nested-text'), 'inner');
});

test('nested Section and Box containers use the smallest owner and inherit once', () => {
  const rows = buildReflowRowGroups([
    entry({ id: 'accordion', x: 0, y: 0, w: 600, h: 100, measuredH: 300 }),
  ]);
  const outerSection = {
    id: 'outer-section',
    containerType: BLOCK_TYPES.SECTION,
    x: 0,
    y: 250,
    w: 1200,
    h: 600,
    top: 250,
    bottom: 850,
  };
  const innerBox = {
    id: 'inner-box',
    containerType: BLOCK_TYPES.BOX,
    x: 100,
    y: 300,
    w: 500,
    h: 300,
    top: 300,
    bottom: 600,
  };
  const nestedText = {
    id: 'nested-text',
    x: 150,
    y: 350,
    w: 400,
    h: 100,
    top: 350,
    bottom: 450,
  };
  const sectionOnlyText = {
    id: 'section-only-text',
    x: 700,
    y: 350,
    w: 400,
    h: 100,
    top: 350,
    bottom: 450,
  };
  const adjacentBox = {
    id: 'adjacent-box',
    containerType: BLOCK_TYPES.BOX,
    x: 0,
    y: 900,
    w: 500,
    h: 300,
    top: 900,
    bottom: 1200,
  };
  const adjacentText = {
    id: 'adjacent-text',
    x: 50,
    y: 950,
    w: 400,
    h: 100,
    top: 950,
    bottom: 1050,
  };
  const result = resolveSectionAwareOffsets({
    rowGroups: rows,
    targets: [
      outerSection,
      innerBox,
      nestedText,
      sectionOnlyText,
      adjacentBox,
      adjacentText,
    ],
    containerTargets: [outerSection, innerBox, adjacentBox],
    relayTargets: [nestedText, sectionOnlyText, adjacentText],
  });

  assert.equal(result.offsets.get('outer-section'), 50);
  assert.equal(result.offsets.get('inner-box'), 50);
  assert.equal(result.offsets.get('nested-text'), 50);
  assert.equal(result.offsets.get('section-only-text'), 50);
  assert.equal(result.offsets.get('adjacent-box'), 0);
  assert.equal(result.offsets.get('adjacent-text'), 0);
  assert.equal(result.owners.get('inner-box'), 'outer-section');
  assert.equal(result.owners.get('nested-text'), 'inner-box');
  assert.equal(result.owners.get('section-only-text'), 'outer-section');
  assert.equal(result.owners.get('adjacent-text'), 'adjacent-box');
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

test('public reflow provider gives Section and live Box contents their wrapper offsets', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    React: globalThis.React,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const React = (await import('react')).default;
  globalThis.React = React;
  const { act, createElement } = React;
  const { createRoot } = await import('react-dom/client');
  const {
    AccordionReflowProvider,
    useAccordionReflow,
  } = await import('./AccordionReflowContext.jsx');

  const sectionBlock = block('section', BLOCK_TYPES.SECTION, 250, 200, 0, 1200);
  sectionBlock.fullWidth = true;
  const blocks = [
    block('accordion', BLOCK_TYPES.ACCORDION, 0, 100, 0, 600),
    sectionBlock,
    block('heading', BLOCK_TYPES.TEXT, 270, 50, 0, 500),
    block('image', BLOCK_TYPES.IMAGE, 330, 100, 0, 500),
    block('paragraph', BLOCK_TYPES.TEXT, 300, 180, 650, 500),
    block('fixed-overlay', BLOCK_TYPES.IMAGE, 300, 300, 875, 100),
  ];
  const boxBlock = block('live-box', BLOCK_TYPES.BOX, 2250, 352, 0, 1200);
  const boxBlocks = [
    block('live-accordion', BLOCK_TYPES.ADVANCED_ACCORDION, 1784, 426, 0, 1200),
    boxBlock,
    block('live-icon', BLOCK_TYPES.IMAGE, 2258, 88, 16, 88),
    block('live-heading', BLOCK_TYPES.TEXT, 2280, 66, 112, 392),
    block('live-paragraph', BLOCK_TYPES.TEXT, 2330, 255, 112, 1056),
    block('live-adjacent', BLOCK_TYPES.IMAGE, 2330, 100, 1220, 300),
  ];
  const api = { reflow: null };

  function Probe() {
    const reflow = useAccordionReflow();
    api.reflow = reflow;
    const sectionOffset = reflow.getOffset('section', 250);
    const paragraphOffset = reflow.getOffset('paragraph', 300);
    const fixedOffset = reflow.getOffset('fixed-overlay', 300);
    const sectionGrowth = reflow.getContainerGrowth(sectionBlock, sectionBlock.geom);
    return createElement('div', {
      'data-section-top': 250 + sectionOffset,
      'data-paragraph-top': 300 + paragraphOffset,
      'data-fixed-top': 300 + fixedOffset,
      'data-section-growth': sectionGrowth,
    });
  }

  function BoxProbe() {
    const reflow = useAccordionReflow();
    api.reflow = reflow;
    return createElement('div', {
      'data-box-top': 2250 + reflow.getOffset('live-box', 2250),
      'data-icon-top': 2258 + reflow.getOffset('live-icon', 2258),
      'data-heading-top': 2280 + reflow.getOffset('live-heading', 2280),
      'data-paragraph-top': 2330 + reflow.getOffset('live-paragraph', 2330),
      'data-adjacent-top': 2330 + reflow.getOffset('live-adjacent', 2330),
      'data-box-growth': reflow.getContainerGrowth(boxBlock, boxBlock.geom),
    });
  }

  const rootElement = document.getElementById('root');
  const reactRoot = createRoot(rootElement);
  try {
    await act(async () => {
      reactRoot.render(createElement(
        AccordionReflowProvider,
        {
          blocks,
          breakpoint: 'desktop',
          resolveGeom,
        },
        createElement(Probe),
      ));
    });

    await act(async () => {
      api.reflow.reportHeight('accordion', 300);
    });
    assert.equal(rootElement.firstChild.dataset.sectionTop, '300');
    assert.equal(rootElement.firstChild.dataset.paragraphTop, '350');
    assert.equal(rootElement.firstChild.dataset.fixedTop, '300');

    await act(async () => {
      api.reflow.reportHeight('paragraph', 220);
    });
    assert.equal(rootElement.firstChild.dataset.paragraphTop, '350');
    assert.equal(rootElement.firstChild.dataset.sectionGrowth, '70');

    await act(async () => {
      api.reflow.reportHeight('accordion', 100);
    });
    assert.equal(rootElement.firstChild.dataset.sectionTop, '250');
    assert.equal(rootElement.firstChild.dataset.paragraphTop, '300');

    await act(async () => {
      reactRoot.render(createElement(
        AccordionReflowProvider,
        {
          key: 'live-box-provider',
          blocks: boxBlocks,
          breakpoint: 'desktop',
          resolveGeom,
        },
        createElement(BoxProbe),
      ));
    });
    assert.equal(rootElement.firstChild.dataset.boxTop, '2250');
    assert.equal(rootElement.firstChild.dataset.iconTop, '2258');
    assert.equal(rootElement.firstChild.dataset.headingTop, '2280');
    assert.equal(rootElement.firstChild.dataset.paragraphTop, '2330');

    await act(async () => {
      api.reflow.reportHeight('live-accordion', 426);
    });
    assert.equal(rootElement.firstChild.dataset.boxTop, '2250');
    assert.equal(rootElement.firstChild.dataset.paragraphTop, '2330');

    await act(async () => {
      api.reflow.reportHeight('live-accordion', 567);
    });
    assert.equal(rootElement.firstChild.dataset.boxTop, '2351');
    assert.equal(rootElement.firstChild.dataset.iconTop, '2359');
    assert.equal(rootElement.firstChild.dataset.headingTop, '2381');
    assert.equal(rootElement.firstChild.dataset.paragraphTop, '2431');
    assert.equal(rootElement.firstChild.dataset.adjacentTop, '2330');

    await act(async () => {
      api.reflow.reportHeight('live-paragraph', 270);
    });
    assert.equal(rootElement.firstChild.dataset.paragraphTop, '2431');
    assert.equal(rootElement.firstChild.dataset.boxGrowth, '0');

    await act(async () => {
      api.reflow.reportHeight('live-accordion', 426);
    });
    assert.equal(rootElement.firstChild.dataset.boxTop, '2250');
    assert.equal(rootElement.firstChild.dataset.iconTop, '2258');
    assert.equal(rootElement.firstChild.dataset.headingTop, '2280');
    assert.equal(rootElement.firstChild.dataset.paragraphTop, '2330');
  } finally {
    await act(async () => {
      reactRoot.unmount();
    });
    dom.window.close();
    for (const [key, value] of Object.entries(previousGlobals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});