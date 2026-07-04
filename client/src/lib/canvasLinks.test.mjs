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
