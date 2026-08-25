import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlowCanvasCss, resolveFlowLayout } from './canvasFlowLayout.js';
import { BLOCK_TYPES, BREAKPOINT_WIDTHS } from './canvasDesign.js';

// A minimal v2 (flow) design: one section stacking a fixed-height image over an
// auto-height text leaf.
function makeFlowDesign() {
  return {
    version: 2,
    root: {
      sections: [
        {
          id: 'sec1',
          type: BLOCK_TYPES.SECTION,
          flow: { padTop: 20, padBottom: 20 },
          children: [
            {
              id: 'img1',
              type: BLOCK_TYPES.IMAGE,
              flow: { heightMode: 'fixed', height: 200 },
              content: {},
            },
            {
              id: 'txt1',
              type: BLOCK_TYPES.TEXT,
              flow: { heightMode: 'auto' },
              content: { html: '<p>Hello</p>' },
            },
          ],
        },
      ],
    },
  };
}

test('returns empty string for a design with no placed nodes', () => {
  assert.equal(buildFlowCanvasCss({ version: 2, root: { sections: [] } }, '#cb'), '');
});

test('emits scoped stage rule with fluid width capped at the desktop stage width', () => {
  const css = buildFlowCanvasCss(makeFlowDesign(), '#cb');
  assert.match(css, /#cb \.canvas-stage\{position:relative;width:100%;max-width:1200px;margin:0 auto;min-height:\d+px;\}/);
  assert.equal(BREAKPOINT_WIDTHS.desktop, 1200);
});

test('emits a per-node absolute-box rule for every placed node, scoped by data-cb', () => {
  const css = buildFlowCanvasCss(makeFlowDesign(), '#cb');
  assert.match(css, /#cb \[data-cb="sec1"\]\{/);
  assert.match(css, /#cb \[data-cb="img1"\]\{/);
  assert.match(css, /#cb \[data-cb="txt1"\]\{/);
});

test('auto-height leaf gets height:auto; fixed leaf gets a pixel height', () => {
  const css = buildFlowCanvasCss(makeFlowDesign(), '#cb');
  const txtRule = css.match(/#cb \[data-cb="txt1"\]\{([^}]*)\}/)[1];
  assert.match(txtRule, /height:auto;/);
  const imgRule = css.match(/#cb \[data-cb="img1"\]\{([^}]*)\}/)[1];
  assert.match(imgRule, /height:200px;/);
});

test('live Member Group leaves are content-sized in flow layouts', () => {
  const design = makeFlowDesign();
  design.root.sections[0].children.push(
    {
      id: 'members1',
      type: BLOCK_TYPES.MEMBER_GROUP,
      flow: { heightMode: 'auto' },
      content: {},
    },
    {
      id: 'groups1',
      type: BLOCK_TYPES.MEMBER_GROUP_CARDS,
      flow: { heightMode: 'auto' },
      content: {},
    },
  );
  const css = buildFlowCanvasCss(design, '#cb');
  assert.match(css.match(/#cb \[data-cb="members1"\]\{([^}]*)\}/)[1], /height:auto;/);
  assert.match(css.match(/#cb \[data-cb="groups1"\]\{([^}]*)\}/)[1], /height:auto;/);
});

test('measured Member Group content repositions downstream flow leaves and page height', () => {
  const design = {
    version: 2,
    root: {
      sections: [{
        id: 'section',
        type: BLOCK_TYPES.SECTION,
        flow: { padTop: 10, padBottom: 10, gap: 12 },
        children: [
          {
            id: 'members',
            type: BLOCK_TYPES.MEMBER_GROUP,
            bp: {
              desktop: { x: 0, y: 0, w: 800, h: 620 },
              mobile: { x: 0, y: 0, w: 375, h: 620 },
            },
            flow: { heightMode: 'auto' },
            content: {},
          },
          {
            id: 'groups',
            type: BLOCK_TYPES.MEMBER_GROUP_CARDS,
            bp: {
              desktop: { x: 0, y: 0, w: 800, h: 760 },
              mobile: { x: 0, y: 0, w: 375, h: 760 },
            },
            flow: { heightMode: 'auto' },
            content: {},
          },
        ],
      }],
    },
  };
  const initial = resolveFlowLayout(design, {
    breakpoint: 'mobile',
    containerWidth: BREAKPOINT_WIDTHS.mobile,
  });
  const measured = resolveFlowLayout(design, {
    breakpoint: 'mobile',
    containerWidth: BREAKPOINT_WIDTHS.mobile,
    measured: {
      members: { height: 240 },
      groups: { height: 510 },
    },
  });

  assert.ok(measured.boxes.groups.y < initial.boxes.groups.y);
  assert.equal(measured.boxes.groups.y, measured.boxes.members.y + 240 + 12);
  assert.ok(measured.height < initial.height);
});

test('emits tablet and mobile @media breakpoint blocks with stage min-height', () => {
  const css = buildFlowCanvasCss(makeFlowDesign(), '#cb');
  assert.match(css, /@media \(max-width: 1023\.98px\)\{/);
  assert.match(css, /@media \(max-width: 639\.98px\)\{/);
  // Each breakpoint re-declares the stage min-height for correct reserved space.
  const mediaMinHeights = css.match(/\.canvas-stage\{min-height:\d+px;\}/g) || [];
  assert.ok(mediaMinHeights.length >= 2, 'expected per-breakpoint stage min-heights');
});

test('CSS identifiers with unsafe characters are sanitized', () => {
  const d = makeFlowDesign();
  d.root.sections[0].children[0].id = 'img"1';
  const css = buildFlowCanvasCss(d, '#cb');
  assert.doesNotMatch(css, /data-cb="img"1"/);
  assert.match(css, /data-cb="img_1"/);
});
