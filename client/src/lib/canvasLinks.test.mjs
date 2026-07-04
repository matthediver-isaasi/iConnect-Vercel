import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCanvasLinks } from './canvasLinks.js';
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
