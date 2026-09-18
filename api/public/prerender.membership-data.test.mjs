import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./prerender.js', import.meta.url), 'utf8');
const start = source.indexOf('function renderCanvasBlockHtml(');
const end = source.indexOf('// Resolve the landmark wrapper', start);
const render = vm.runInNewContext(`${source.slice(start, end)}; renderCanvasBlockHtml`);

for (const type of ['membership-summary', 'payment-details']) {
  test(`${type} never renders private or state-specific content into shared prerender`, () => {
    const html = render({
      type,
      content: {
        heading: 'Membership Active',
        memberSince: '2018-01-01',
        membershipType: 'Private membership',
        payment: { state: 'active', nextPayment: '2026-10-01' },
        stateCopy: { active: { heading: 'Private success copy' } },
        html: '<p>Private HTML</p>',
      },
    });
    assert.equal(html, '<p>Sign in to view your membership and payment details.</p>');
    const inlineTypes = source.match(/const INLINE_CANVAS_BLOCK_TYPES = new Set\(\[([\s\S]*?)\]\)/)[1];
    assert.ok(!inlineTypes.includes(type));
  });
}