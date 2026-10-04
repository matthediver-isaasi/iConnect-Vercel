import test from 'node:test';
import assert from 'node:assert/strict';
import { correctPortalDesign, BLOCK, DESTINATION } from './correct-bnms-portal-renewal-link.mjs';

export const originalBlock = { id: BLOCK, type: 'payment-details', style: { paddingTop: 28 },
  content: { manageLink: DESTINATION, manageLinkText: 'Renew subscription', manageLinkNewTab: false,
    renewalLink: '', renewalLinkNewTab: false, eyebrow: 'PAYMENT DETAILS' } };

test('targeted correction changes only destinations, preserves other edits and is idempotent', () => {
  const original = { root: { children: [originalBlock, { id: 'other', content: { manageLink: '/payments' } }] } };
  const before = structuredClone(original);
  const result = correctPortalDesign(original);
  assert.equal(result.changed, true);
  const expected = structuredClone(original);
  expected.root.children[0].content.manageLink = '';
  expected.root.children[0].content.renewalLink = DESTINATION;
  assert.deepEqual(result.design, expected);
  assert.deepEqual(original, before);
  assert.equal(correctPortalDesign(result.design).changed, false);
});
test('ambiguous blocks and concurrently changed links fail closed', () => {
  for (const design of [{}, { children: [originalBlock, originalBlock] },
    { children: [{ ...originalBlock, content: { ...originalBlock.content, renewalLink: '/different' } }] },
    { children: [{ ...originalBlock, content: { ...originalBlock.content, manageLink: '/payments' } }] }]) {
    assert.throws(() => correctPortalDesign(design));
  }
});