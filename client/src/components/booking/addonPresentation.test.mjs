import assert from 'node:assert/strict';
import test from 'node:test';
import { addonPresentationPatch, isAddonModalVisible, previousSameEventPurchase, safeAddonImageUrl, updateAddonPresentationNode } from './addonPresentation.mjs';

test('add-on presentation accepts only safe absolute http(s) or root-relative image URLs', () => {
  assert.equal(safeAddonImageUrl('https://events.example.org/banner.jpg'), 'https://events.example.org/banner.jpg');
  assert.equal(safeAddonImageUrl('/uploads/banner.webp'), '/uploads/banner.webp');
  assert.equal(safeAddonImageUrl('javascript:alert(1)'), '');
  assert.equal(safeAddonImageUrl('//tracking.example.org/image'), '');
  assert.equal(safeAddonImageUrl('/\\evil.example'), '');
});

test('presentation patches omit empty fields and preserve other fields across delayed callbacks', () => {
  const original = [{ id: 'addon', type: 'addon' }];
  const afterHeadingEdit = updateAddonPresentationNode(original, 'addon', 'heading', 'Workshop');
  const afterDetailsEdit = updateAddonPresentationNode(afterHeadingEdit, 'addon', 'bodyHtml', '<p>Details</p>');
  // A file upload started before these text edits resolves against the latest graph state.
  const afterDelayedImage = updateAddonPresentationNode(afterDetailsEdit, 'addon', 'imageUrl', '/uploads/header.jpg');
  assert.deepEqual(afterDetailsEdit[0].presentation, { heading: 'Workshop', bodyHtml: '<p>Details</p>' });
  assert.deepEqual(afterDelayedImage[0].presentation, {
    heading: 'Workshop', bodyHtml: '<p>Details</p>', imageUrl: '/uploads/header.jpg',
  });
  assert.equal(addonPresentationPatch({ heading: 'Workshop' }, 'heading', ''), undefined);
});

test('finds only a previous reachable same-event purchase', () => {
  const source = { id: 'source', type: 'source', event: { id: 'event-a' } };
  const current = { id: 'addon', type: 'addon', event: { id: 'event-a' } };
  assert.equal(previousSameEventPurchase([source, current], current, ['source', 'addon']), source);
  assert.equal(previousSameEventPurchase([source, current], current, ['addon']), null);
});

test('a hidden modal stays hidden for its addon but opens for the next consecutive addon', () => {
  assert.equal(isAddonModalVisible('addon-a', 'addon-a'), false);
  assert.equal(isAddonModalVisible('addon-b', 'addon-a'), true);
  assert.equal(isAddonModalVisible('addon-a', null), true);
  assert.equal(isAddonModalVisible(null, 'addon-a'), false);
});
