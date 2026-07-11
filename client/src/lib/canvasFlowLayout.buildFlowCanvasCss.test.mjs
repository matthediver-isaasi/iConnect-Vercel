import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlowCanvasCss } from './canvasFlowLayout.js';
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
