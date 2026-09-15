import assert from 'node:assert/strict';
import test from 'node:test';
import { formatReviewAddress } from './reviewAddressDisplay.js';

test('review address uses canonical order without blank lines', () => {
  assert.equal(formatReviewAddress({
    country: 'UK', postcode: 'SW1A 1AA', county: 'London',
    post_town: 'Westminster', line_3: '', line_2: ' ', line_1: '1 Main Street',
  }), '1 Main Street\nWestminster\nLondon\nSW1A 1AA\nUK');
});

test('empty, partial, alias and unexpected legacy source addresses stay readable', () => {
  for (const value of [null, undefined, '', {}, { line_1: '', county: ' ' }]) {
    assert.equal(formatReviewAddress(value), '');
  }
  assert.equal(formatReviewAddress({ postcode: 'SW1A 1AA' }), 'SW1A 1AA');
  assert.equal(formatReviewAddress({ address1: '1 Main Street', city: 'Town' }), '1 Main Street\nTown');
  assert.equal(formatReviewAddress('One\n\nTwo'), 'One\nTwo');
  assert.equal(formatReviewAddress('{"line_1":"One","post_town":"Town"}'), 'One\nTown');
  assert.equal(formatReviewAddress({ legacy: ['One', { text: 'Two' }] }), 'One\nTwo');
  assert.equal(formatReviewAddress({ postcode: 'SW1A 1AA', legacy_street: 'One' }), 'SW1A 1AA\nOne');
  assert.equal(formatReviewAddress({ line_1: '<script>text</script>' }), '<script>text</script>');
});