// Tests for Advanced Accordion nested child traversal in the React-free Canvas
// utility modules: canvasLinks.js, canvasText.js, canvasA11y.js.
//
// Run: node --test client/src/lib/canvasAdvancedAccordion.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractCanvasLinks, applyCanvasLinkUpdate } from './canvasLinks.js';
import { extractCanvasPageText } from './canvasText.js';
import { auditCanvasDesign } from './canvasA11y.js';
import { BLOCK_TYPES } from './canvasDesign.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADVANCED_ACCORDION_TYPE = 'advanced-accordion'; // literal to stay registry-free

function makeDesign(blocks) {
  return {
    version: 1,
    root: {
      sections: [
        { id: 's1', children: Array.isArray(blocks) ? blocks : [blocks] },
      ],
    },
  };
}

// Build a minimal advanced-accordion block.
function makeAdvAcc({ id = 'aa1', items = [] } = {}) {
  return {
    id,
    type: ADVANCED_ACCORDION_TYPE,
    content: {
      items,
      mode: 'single',
      initialId: '',
      itemGap: 8,
    },
  };
}

// Build a panel item with a single text child.
function textPanel({ panelId = 'p1', title = 'Panel', html = '<p>Hello</p>', links = [] } = {}) {
  return {
    id: panelId,
    title,
    anchor: '',
    children: [
      {
        id: `${panelId}-text`,
        type: BLOCK_TYPES.TEXT,
        name: 'Text',
        content: { html },
      },
    ],
  };
}

// Build a panel item with a button child.
function buttonPanel({ panelId = 'p2', title = 'Panel 2', href = '/page', label = 'Go' } = {}) {
  return {
    id: panelId,
    title,
    anchor: '',
    children: [
      {
        id: `${panelId}-btn`,
        type: BLOCK_TYPES.BUTTON,
        name: 'Button',
        content: { href, label },
      },
    ],
  };
}

// Build a panel item with an image child.
function imagePanel({ panelId = 'p3', title = 'Panel 3', src = 'https://cdn/img.jpg', alt = '', href = '' } = {}) {
  return {
    id: panelId,
    title,
    anchor: '',
    children: [
      {
        id: `${panelId}-img`,
        type: BLOCK_TYPES.IMAGE,
        name: 'Image',
        content: { src, alt, href },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// canvasLinks — structured link extraction from advanced accordion children
// ---------------------------------------------------------------------------

test('advanced-accordion: button child link is extracted', () => {
  const block = makeAdvAcc({
    items: [buttonPanel({ panelId: 'p1', title: 'Intro', href: '/intro', label: 'Read more' })],
  });
  const rows = extractCanvasLinks(makeDesign(block));
  const btnRows = rows.filter((r) => r.label === 'Button');
  assert.equal(btnRows.length, 1, 'should extract exactly one Button link row');
  assert.equal(btnRows[0].value, '/intro');
  assert.equal(btnRows[0].blockId, 'aa1');
  assert.equal(btnRows[0].blockType, ADVANCED_ACCORDION_TYPE);
  // Content path should point inside items[0].children[0].content.href
  assert.deepEqual(btnRows[0].path.contentPath, ['items', 0, 'children', 0, 'content', 'href']);
});

test('advanced-accordion: image child with href emits link row (onlyWhenPopulated)', () => {
  const block = makeAdvAcc({
    items: [imagePanel({ panelId: 'p1', src: 'https://cdn/img.jpg', alt: 'Photo', href: '/gallery' })],
  });
  const rows = extractCanvasLinks(makeDesign(block));
  const imgRows = rows.filter((r) => r.label === 'Image link');
  assert.equal(imgRows.length, 1);
  assert.equal(imgRows[0].value, '/gallery');
  assert.deepEqual(imgRows[0].path.contentPath, ['items', 0, 'children', 0, 'content', 'href']);
});

test('advanced-accordion: image child with NO href emits no link row (onlyWhenPopulated)', () => {
  const block = makeAdvAcc({
    items: [imagePanel({ panelId: 'p1', src: 'https://cdn/img.jpg', alt: 'Photo', href: '' })],
  });
  const rows = extractCanvasLinks(makeDesign(block));
  const imgRows = rows.filter((r) => r.label === 'Image link');
  assert.equal(imgRows.length, 0);
});

test('advanced-accordion: multiple panels with buttons emit one row each', () => {
  const block = makeAdvAcc({
    items: [
      buttonPanel({ panelId: 'p1', title: 'P1', href: '/one', label: 'One' }),
      buttonPanel({ panelId: 'p2', title: 'P2', href: '/two', label: 'Two' }),
    ],
  });
  const rows = extractCanvasLinks(makeDesign(block));
  const btnRows = rows.filter((r) => r.label === 'Button');
  assert.equal(btnRows.length, 2);
  assert.equal(btnRows[0].value, '/one');
  assert.deepEqual(btnRows[0].path.contentPath, ['items', 0, 'children', 0, 'content', 'href']);
  assert.equal(btnRows[1].value, '/two');
  assert.deepEqual(btnRows[1].path.contentPath, ['items', 1, 'children', 0, 'content', 'href']);
});

test('advanced-accordion: inline html anchors from text child are extracted', () => {
  const block = makeAdvAcc({
    items: [
      textPanel({ panelId: 'p1', html: '<p>Visit <a href="/about">About us</a> now.</p>' }),
    ],
  });
  const rows = extractCanvasLinks(makeDesign(block));
  const htmlRows = rows.filter((r) => r.kind === 'html-anchor');
  assert.equal(htmlRows.length, 1);
  assert.equal(htmlRows[0].value, '/about');
  assert.equal(htmlRows[0].context, 'About us');
  assert.equal(htmlRows[0].path.anchorIndex, 0);
  assert.deepEqual(htmlRows[0].path.contentPath, ['items', 0, 'children', 0, 'content', 'html']);
  assert.equal(htmlRows[0].blockId, 'aa1');
});

test('advanced-accordion: multiple inline anchors in a text child are all extracted', () => {
  const html = '<p><a href="/a">Link A</a> and <a href="/b">Link B</a></p>';
  const block = makeAdvAcc({
    items: [textPanel({ panelId: 'p1', html })],
  });
  const rows = extractCanvasLinks(makeDesign(block));
  const htmlRows = rows.filter((r) => r.kind === 'html-anchor');
  assert.equal(htmlRows.length, 2);
  assert.equal(htmlRows[0].value, '/a');
  assert.equal(htmlRows[0].path.anchorIndex, 0);
  assert.equal(htmlRows[1].value, '/b');
  assert.equal(htmlRows[1].path.anchorIndex, 1);
});

test('advanced-accordion: empty items array produces no rows', () => {
  const block = makeAdvAcc({ items: [] });
  const rows = extractCanvasLinks(makeDesign(block));
  assert.equal(rows.length, 0);
});

test('advanced-accordion: panel with no children produces no link rows', () => {
  const block = makeAdvAcc({
    items: [{ id: 'p1', title: 'Empty panel', anchor: '', children: [] }],
  });
  const rows = extractCanvasLinks(makeDesign(block));
  assert.equal(rows.length, 0);
});

test('advanced-accordion: legacy accordion is unaffected', () => {
  const legacyBlock = {
    id: 'leg1',
    type: BLOCK_TYPES.ACCORDION,
    content: {
      items: [
        { q: 'Q1', a: '<p>A1</p>', links: [{ url: '/old', label: 'Old link' }] },
      ],
    },
  };
  const rows = extractCanvasLinks(makeDesign(legacyBlock));
  const linkRows = rows.filter((r) => r.label === 'Accordion link');
  assert.equal(linkRows.length, 1);
  assert.equal(linkRows[0].value, '/old');
  assert.deepEqual(linkRows[0].path.contentPath, ['items', 0, 'links', 0, 'url']);
  // Advanced accordion produces no extra rows
  const advRows = rows.filter((r) => r.blockType === ADVANCED_ACCORDION_TYPE);
  assert.equal(advRows.length, 0);
});

// ---------------------------------------------------------------------------
// canvasLinks — applyCanvasLinkUpdate for advanced accordion children
// ---------------------------------------------------------------------------

test('advanced-accordion: applyCanvasLinkUpdate updates a button child href', () => {
  const block = makeAdvAcc({
    items: [buttonPanel({ panelId: 'p1', href: '/old', label: 'Go' })],
  });
  const design = makeDesign(block);
  applyCanvasLinkUpdate(
    design,
    'aa1',
    { contentPath: ['items', 0, 'children', 0, 'content', 'href'] },
    '/new',
  );
  assert.equal(design.root.sections[0].children[0].content.items[0].children[0].content.href, '/new');
});

test('advanced-accordion: applyCanvasLinkUpdate rewrites inline html anchor', () => {
  const block = makeAdvAcc({
    items: [textPanel({ panelId: 'p1', html: '<p><a href="/old">Click</a></p>' })],
  });
  const design = makeDesign(block);
  applyCanvasLinkUpdate(
    design,
    'aa1',
    { contentPath: ['items', 0, 'children', 0, 'content', 'html'], anchorIndex: 0 },
    '/new',
  );
  const updated = design.root.sections[0].children[0].content.items[0].children[0].content.html;
  assert.ok(updated.includes('/new'), 'anchor href should be updated');
  assert.ok(!updated.includes('/old'), 'old href should be replaced');
});

// ---------------------------------------------------------------------------
// canvasText — text extraction from advanced accordion
// ---------------------------------------------------------------------------

test('canvasText: advanced-accordion panel titles are extracted', () => {
  const block = makeAdvAcc({
    items: [
      textPanel({ panelId: 'p1', title: 'What is this?', html: '<p>It is awesome.</p>' }),
      textPanel({ panelId: 'p2', title: 'How does it work?', html: '<p>Very well.</p>' }),
    ],
  });
  const text = extractCanvasPageText(makeDesign(block));
  assert.ok(text.includes('What is this?'), 'panel 1 title should be in text');
  assert.ok(text.includes('How does it work?'), 'panel 2 title should be in text');
});

test('canvasText: advanced-accordion child block html is extracted as stripped prose', () => {
  const block = makeAdvAcc({
    items: [
      textPanel({ panelId: 'p1', title: 'FAQ 1', html: '<p>The <strong>answer</strong> is here.</p>' }),
    ],
  });
  const text = extractCanvasPageText(makeDesign(block));
  assert.ok(text.includes('The answer is here.'), 'stripped html should appear in text');
});

test('canvasText: advanced-accordion button child label is extracted', () => {
  const block = makeAdvAcc({
    items: [buttonPanel({ panelId: 'p1', title: 'Action', href: '/go', label: 'Click here' })],
  });
  const text = extractCanvasPageText(makeDesign(block));
  assert.ok(text.includes('Click here'), 'button label should appear in text');
  assert.ok(text.includes('Action'), 'panel title should appear in text');
});

test('canvasText: no duplication from advanced-accordion on a design with repeated text', () => {
  const block = makeAdvAcc({
    items: [
      textPanel({ panelId: 'p1', title: 'Same', html: '<p>Repeated</p>' }),
      textPanel({ panelId: 'p2', title: 'Same', html: '<p>Repeated</p>' }),
    ],
  });
  const text = extractCanvasPageText(makeDesign(block));
  // Duplicate strings are removed. 'Repeated' should appear once; 'Same' once.
  const repeatedOccurrences = (text.match(/Repeated/g) || []).length;
  assert.equal(repeatedOccurrences, 1, 'duplicate text should be de-duplicated');
});

test('canvasText: advanced-accordion alongside other blocks emits all text', () => {
  const accBlock = makeAdvAcc({
    items: [textPanel({ panelId: 'p1', title: 'Accordion heading', html: '<p>Accordion body</p>' })],
  });
  const textBlock = {
    id: 't1',
    type: BLOCK_TYPES.TEXT,
    content: { html: '<p>Page intro</p>' },
  };
  const text = extractCanvasPageText(makeDesign([accBlock, textBlock]));
  assert.ok(text.includes('Accordion heading'));
  assert.ok(text.includes('Accordion body'));
  assert.ok(text.includes('Page intro'));
});

// ---------------------------------------------------------------------------
// canvasA11y — audit visits advanced accordion child blocks
// ---------------------------------------------------------------------------

test('canvasA11y: advanced-accordion child image without alt emits image-alt-missing', () => {
  const block = {
    id: 'aa1',
    type: ADVANCED_ACCORDION_TYPE,
    content: {
      items: [
        {
          id: 'p1',
          title: 'Panel 1',
          anchor: '',
          children: [
            {
              id: 'img1',
              type: BLOCK_TYPES.IMAGE,
              name: 'Image',
              content: { src: 'https://cdn/img.jpg', alt: '' },
            },
          ],
        },
      ],
      mode: 'single',
    },
  };
  const design = makeDesign(block);
  const issues = auditCanvasDesign(design);
  const altIssues = issues.filter((i) => i.rule === 'image-alt-missing');
  assert.ok(altIssues.length > 0, 'should report image-alt-missing for child image');
  assert.equal(altIssues[0].blockId, 'aa1', 'issue should be keyed to the accordion block');
});

test('canvasA11y: advanced-accordion child image WITH alt has no image-alt-missing', () => {
  const block = {
    id: 'aa1',
    type: ADVANCED_ACCORDION_TYPE,
    content: {
      items: [
        {
          id: 'p1',
          title: 'Panel 1',
          anchor: '',
          children: [
            {
              id: 'img1',
              type: BLOCK_TYPES.IMAGE,
              name: 'Image',
              content: { src: 'https://cdn/img.jpg', alt: 'A descriptive alt' },
            },
          ],
        },
      ],
      mode: 'single',
    },
  };
  const design = makeDesign(block);
  const issues = auditCanvasDesign(design);
  const altIssues = issues.filter((i) => i.rule === 'image-alt-missing');
  assert.equal(altIssues.length, 0, 'no image-alt-missing when child image has alt');
});

test('canvasA11y: advanced-accordion child button without label emits button-no-accessible-name', () => {
  const block = {
    id: 'aa1',
    type: ADVANCED_ACCORDION_TYPE,
    content: {
      items: [
        {
          id: 'p1',
          title: 'Panel 1',
          anchor: '',
          children: [
            {
              id: 'btn1',
              type: BLOCK_TYPES.BUTTON,
              name: 'Button',
              content: { href: '/go', label: '' },
            },
          ],
        },
      ],
      mode: 'single',
    },
  };
  const design = makeDesign(block);
  const issues = auditCanvasDesign(design);
  const btnIssues = issues.filter((i) => i.rule === 'button-no-accessible-name');
  assert.ok(btnIssues.length > 0, 'should report button-no-accessible-name for labelless child button');
  assert.equal(btnIssues[0].blockId, 'aa1');
});

test('canvasA11y: advanced-accordion with no children emits no child-traversal issues', () => {
  const block = {
    id: 'aa1',
    type: ADVANCED_ACCORDION_TYPE,
    content: {
      items: [],
      mode: 'single',
    },
  };
  const design = makeDesign(block);
  const issues = auditCanvasDesign(design);
  // Child-traversal rules (image-alt, button-no-accessible-name, etc.) must NOT
  // fire when there are no children. Generic geometry/mobile rules may still
  // fire and that is acceptable — we only verify that the child-specific rules
  // are silent.
  const childRuleIds = new Set([
    'image-alt-missing',
    'button-no-accessible-name',
    'link-image-no-accessible-name',
    'icon-no-accessible-name',
    'aria-hidden-focusable',
  ]);
  const childIssues = issues.filter((i) => i.blockId === 'aa1' && childRuleIds.has(i.rule));
  assert.equal(childIssues.length, 0, 'no child-traversal issues for empty advanced accordion');
});

test('canvasA11y: advanced-accordion traversal does not affect legacy accordion', () => {
  const block = {
    id: 'leg1',
    type: BLOCK_TYPES.ACCORDION,
    content: {
      items: [{ q: 'Question?', a: '<p>Answer.</p>' }],
    },
  };
  const design = makeDesign(block);
  const issues = auditCanvasDesign(design);
  // Legacy accordion should produce no errors (has no images, no buttons, etc.)
  const errors = issues.filter((i) => i.severity === 'error' && i.blockId === 'leg1');
  assert.equal(errors.length, 0, 'legacy accordion should have no block-level errors');
});
