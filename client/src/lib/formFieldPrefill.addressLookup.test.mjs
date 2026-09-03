import assert from 'node:assert/strict';
import test from 'node:test';
import { isFieldValueFilled } from './formFieldPrefill.js';

test('address lookup required validation uses its required components', () => {
  const field = {
    type: 'address_lookup',
    required: true,
    visible_components: ['line_1', 'post_town', 'postcode'],
    required_components: ['line_1', 'postcode'],
  };
  assert.equal(isFieldValueFilled(field, {
    line_1: '1 Test Street',
    post_town: '',
    postcode: 'LS1 1AA',
  }), true);
  assert.equal(isFieldValueFilled(field, {
    line_1: '1 Test Street',
    post_town: 'Leeds',
    postcode: '',
  }), false);
});

test('a required address lookup default excludes optional address lines and county', () => {
  const field = { type: 'address_lookup', required: true };
  assert.equal(isFieldValueFilled(field, {
    line_1: '1 Test Street',
    post_town: 'Leeds',
    postcode: 'LS1 1AA',
    country: 'United Kingdom',
  }), true);
});