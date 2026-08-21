import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCanvasLinks, applyCanvasLinkUpdate } from './canvasLinks.js';
import { BLOCK_TYPES } from './canvasDesign.js';

function makeCardDesign(content) {
  return {
    version: 1,
    root: {
      sections: [
        { id: 's1', children: [{ id: 'b1', type: BLOCK_TYPES.CARD, content }] },
      ],
    },
  };
}

test('card with CTA disabled produces no link row', () => {
  const rows = extractCanvasLinks(
    makeCardDesign({ ctaEnabled: false, ctaLabel: 'Learn more', ctaHref: '', heading: 'Society Milestones' })
  );
  const ctaRows = rows.filter((r) => r.label === 'Card CTA');
  assert.equal(ctaRows.length, 0);
});

test('card with CTA enabled keeps its row, button label and heading context', () => {
  const rows = extractCanvasLinks(
    makeCardDesign({ ctaEnabled: true, ctaLabel: 'Learn more', ctaHref: '/about', heading: 'Our Story' })
  );
  const ctaRows = rows.filter((r) => r.label === 'Card CTA');
  assert.equal(ctaRows.length, 1);
  assert.equal(ctaRows[0].value, '/about');
  assert.equal(ctaRows[0].buttonLabel, 'Learn more');
  assert.equal(ctaRows[0].context, 'Our Story');
});

test('legacy card missing the ctaEnabled flag still surfaces a row', () => {
  const rows = extractCanvasLinks(
    makeCardDesign({ ctaLabel: 'Learn more', ctaHref: '#', heading: 'Legacy' })
  );
  const ctaRows = rows.filter((r) => r.label === 'Card CTA');
  assert.equal(ctaRows.length, 1);
  assert.equal(ctaRows[0].value, '#');
});

function makeImageDesign(content) {
  return {
    version: 1,
    root: {
      sections: [
        { id: 's1', children: [{ id: 'b1', type: BLOCK_TYPES.IMAGE, content }] },
      ],
    },
  };
}

test('decorative image with no href produces no link row', () => {
  const rows = extractCanvasLinks(
    makeImageDesign({ src: 'https://cdn.example.com/photo.jpg', alt: 'Decorative', href: '' })
  );
  const imageRows = rows.filter((r) => r.label === 'Image link');
  assert.equal(imageRows.length, 0);
});

test('icon-only image with no src and no href produces no link row', () => {
  const rows = extractCanvasLinks(
    makeImageDesign({ src: '', alt: '', href: '', iconClass: 'fa-star' })
  );
  const imageRows = rows.filter((r) => r.label === 'Image link');
  assert.equal(imageRows.length, 0);
});

test('image with a whitespace-only href produces no link row', () => {
  const rows = extractCanvasLinks(
    makeImageDesign({ src: 'https://cdn.example.com/photo.jpg', alt: 'Photo', href: '   ' })
  );
  const imageRows = rows.filter((r) => r.label === 'Image link');
  assert.equal(imageRows.length, 0);
});

test('image with an href produces exactly one editable link row', () => {
  const rows = extractCanvasLinks(
    makeImageDesign({ src: 'https://cdn.example.com/photo.jpg', alt: 'Photo', href: '/about' })
  );
  const imageRows = rows.filter((r) => r.label === 'Image link');
  assert.equal(imageRows.length, 1);
  assert.equal(imageRows[0].value, '/about');
  assert.deepEqual(imageRows[0].path.contentPath, ['href']);
  assert.equal(imageRows[0].imageSrc, 'https://cdn.example.com/photo.jpg');
  assert.equal(imageRows[0].imageAlt, 'Photo');
});

test('other block types are unaffected by the image-only-when-populated rule', () => {
  const design = {
    version: 1,
    root: {
      sections: [
        { id: 's1', children: [{ id: 'b1', type: BLOCK_TYPES.BUTTON, content: { label: 'Click', href: '' } }] },
      ],
    },
  };
  const buttonRows = extractCanvasLinks(design).filter((r) => r.label === 'Button');
  assert.equal(buttonRows.length, 1);
  assert.equal(buttonRows[0].value, '');
});

// -- Advanced Accordion deep nesting ----------------------------------------

// Build a design with a single advanced-accordion block whose panel `items`
// carry arbitrary nested `children`. `items` is passed through verbatim so
// tests can craft any depth of child.children[] layout tree.
function makeAdvAccDesign(items) {
  return {
    version: 1,
    root: {
      sections: [
        {
          id: 's1',
          children: [
            { id: 'acc1', type: BLOCK_TYPES.ADVANCED_ACCORDION, content: { items } },
          ],
        },
      ],
    },
  };
}

test('advanced accordion: direct child link is extracted (unchanged behavior)', () => {
  const design = makeAdvAccDesign([
    {
      title: 'Panel A',
      children: [
        { id: 'c1', type: BLOCK_TYPES.BUTTON, content: { label: 'Go', href: '/direct' } },
      ],
    },
  ]);
  const rows = extractCanvasLinks(design).filter((r) => r.label === 'Button');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, '/direct');
  assert.deepEqual(rows[0].path.contentPath, ['items', 0, 'children', 0, 'content', 'href']);
});

test('advanced accordion: grandchild structured link is extracted with a deep path', () => {
  // Panel > group (child) > button (grandchild).
  const design = makeAdvAccDesign([
    {
      title: 'Panel A',
      children: [
        {
          id: 'grp',
          type: BLOCK_TYPES.GROUP,
          content: {},
          children: [
            { id: 'gb', type: BLOCK_TYPES.BUTTON, content: { label: 'Nested', href: '/grandchild' } },
          ],
        },
      ],
    },
  ]);
  const rows = extractCanvasLinks(design).filter((r) => r.label === 'Button');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, '/grandchild');
  assert.deepEqual(
    rows[0].path.contentPath,
    ['items', 0, 'children', 0, 'children', 0, 'content', 'href'],
  );
});

test('advanced accordion: deeply nested (great-grandchild) image link is extracted', () => {
  // Panel > group > group > image (populated href).
  const design = makeAdvAccDesign([
    {
      title: 'Panel A',
      children: [
        {
          id: 'g1',
          type: BLOCK_TYPES.GROUP,
          children: [
            {
              id: 'g2',
              type: BLOCK_TYPES.GROUP,
              children: [
                {
                  id: 'img',
                  type: BLOCK_TYPES.IMAGE,
                  content: { src: 'https://cdn.example.com/p.jpg', alt: 'Deep', href: '/deep' },
                },
              ],
            },
          ],
        },
      ],
    },
  ]);
  const rows = extractCanvasLinks(design).filter((r) => r.label === 'Image link');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, '/deep');
  assert.deepEqual(
    rows[0].path.contentPath,
    ['items', 0, 'children', 0, 'children', 0, 'children', 0, 'content', 'href'],
  );
});

test('advanced accordion: custom-extractor grandchild (nested card links) rebase correctly', () => {
  // Panel > group > card CTA (card uses the plain ctaHref field spec).
  const design = makeAdvAccDesign([
    {
      title: 'Panel A',
      children: [
        {
          id: 'grp',
          type: BLOCK_TYPES.GROUP,
          children: [
            {
              id: 'card',
              type: BLOCK_TYPES.CARD,
              content: { ctaEnabled: true, ctaLabel: 'Open', ctaHref: '/card', heading: 'Deep card' },
            },
          ],
        },
      ],
    },
  ]);
  const rows = extractCanvasLinks(design).filter((r) => r.label === 'Card CTA');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, '/card');
  assert.deepEqual(
    rows[0].path.contentPath,
    ['items', 0, 'children', 0, 'children', 0, 'content', 'ctaHref'],
  );
});

test('advanced accordion: inline anchor inside a grandchild text block is extracted', () => {
  const design = makeAdvAccDesign([
    {
      title: 'Panel A',
      children: [
        {
          id: 'grp',
          type: BLOCK_TYPES.GROUP,
          children: [
            {
              id: 'txt',
              type: BLOCK_TYPES.TEXT,
              content: { html: 'See <a href="/inline-deep">our page</a> for more.' },
            },
          ],
        },
      ],
    },
  ]);
  const rows = extractCanvasLinks(design).filter((r) => r.kind === 'html-anchor');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, '/inline-deep');
  assert.equal(rows[0].path.anchorIndex, 0);
  assert.deepEqual(
    rows[0].path.contentPath,
    ['items', 0, 'children', 0, 'children', 0, 'content', 'html'],
  );
});

test('advanced accordion: applyCanvasLinkUpdate rewrites a grandchild structured link', () => {
  const design = makeAdvAccDesign([
    {
      title: 'Panel A',
      children: [
        {
          id: 'grp',
          type: BLOCK_TYPES.GROUP,
          children: [
            { id: 'gb', type: BLOCK_TYPES.BUTTON, content: { label: 'Nested', href: '/old' } },
          ],
        },
      ],
    },
  ]);
  const row = extractCanvasLinks(design).find((r) => r.label === 'Button');
  applyCanvasLinkUpdate(design, row.blockId, row.path, '/new');
  const btn = design.root.sections[0].children[0].content.items[0].children[0].children[0];
  assert.equal(btn.content.href, '/new');
});

test('advanced accordion: applyCanvasLinkUpdate rewrites a grandchild inline anchor', () => {
  const design = makeAdvAccDesign([
    {
      title: 'Panel A',
      children: [
        {
          id: 'grp',
          type: BLOCK_TYPES.GROUP,
          children: [
            {
              id: 'txt',
              type: BLOCK_TYPES.TEXT,
              content: { html: 'Visit <a href="/old">here</a> now.' },
            },
          ],
        },
      ],
    },
  ]);
  const row = extractCanvasLinks(design).find((r) => r.kind === 'html-anchor');
  applyCanvasLinkUpdate(design, row.blockId, row.path, '/new');
  const txt = design.root.sections[0].children[0].content.items[0].children[0].children[0];
  assert.match(txt.content.html, /href="\/new"/);
  assert.doesNotMatch(txt.content.html, /href="\/old"/);
});

test('advanced accordion: mixed depths all extracted with correct paths', () => {
  const design = makeAdvAccDesign([
    {
      title: 'Panel A',
      children: [
        // direct child
        { id: 'd', type: BLOCK_TYPES.BUTTON, content: { label: 'Direct', href: '/a' } },
        // grandchild via a group
        {
          id: 'grp',
          type: BLOCK_TYPES.GROUP,
          children: [
            { id: 'gb', type: BLOCK_TYPES.BUTTON, content: { label: 'Grand', href: '/b' } },
          ],
        },
      ],
    },
  ]);
  const rows = extractCanvasLinks(design).filter((r) => r.label === 'Button');
  const paths = rows.map((r) => r.path.contentPath);
  assert.equal(rows.length, 2);
  assert.deepEqual(paths, [
    ['items', 0, 'children', 0, 'content', 'href'],
    ['items', 0, 'children', 1, 'children', 0, 'content', 'href'],
  ]);
});

test('legacy Accordion links are unchanged by advanced-accordion recursion', () => {
  const design = {
    version: 1,
    root: {
      sections: [
        {
          id: 's1',
          children: [
            {
              id: 'acc',
              type: BLOCK_TYPES.ACCORDION,
              content: {
                items: [
                  { q: 'Q1', links: [{ label: 'FAQ', url: '/faq' }] },
                ],
              },
            },
          ],
        },
      ],
    },
  };
  const rows = extractCanvasLinks(design).filter((r) => r.label === 'Accordion link');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, '/faq');
  assert.deepEqual(rows[0].path.contentPath, ['items', 0, 'links', 0, 'url']);
});
