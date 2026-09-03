import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addressLookupRequiredComponents,
  isAddressLookupAnswerFilled,
  normalizeAddressLookupAnswer,
} from './formAddressLookup.js';

test('normalizes provider aliases to the persisted address contract', () => {
  assert.deepEqual(normalizeAddressLookupAnswer({
    line1: ' 10 High Street ', post_town: ' Leeds ', region: 'West Yorkshire', post_code: 'ls1 1aa',
  }), {
    line_1: '10 High Street', line_2: '', line_3: '', post_town: 'Leeds', county: 'West Yorkshire', postcode: 'ls1 1aa', country: '',
  });
});

test('address lookup validation respects visible required components', () => {
  const field = { required: true, visible_components: ['line_1', 'post_town', 'postcode'], required_components: ['line_1', 'postcode'] };
  assert.deepEqual(addressLookupRequiredComponents(field), ['line_1', 'postcode']);
  assert.equal(isAddressLookupAnswerFilled(field, { line_1: '10 High Street', postcode: 'LS1 1AA' }), true);
  assert.equal(isAddressLookupAnswerFilled(field, { line_1: '10 High Street', postcode: ' ' }), false);
});