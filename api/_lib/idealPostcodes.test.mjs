import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lookupIdealPostcodes,
  normalizeUkPostcode,
  invalidRequiredAddressLookupFields,
} from './idealPostcodes.js';

test('normalizes and validates UK postcode input', () => {
  const accepted = {
    ' m1 1ae ': 'M1 1AE',
    'M60 1NW': 'M60 1NW',
    'cr2 6xh': 'CR2 6XH',
    'DN55 1PT': 'DN55 1PT',
    'W1A 1HQ': 'W1A 1HQ',
    'EC1A1BB': 'EC1A 1BB',
    'gir0aa': 'GIR 0AA',
  };
  for (const [input, expected] of Object.entries(accepted)) {
    assert.equal(normalizeUkPostcode(input), expected, input);
  }
  for (const invalid of ['', 'SW1', 'SW1A 1A', 'Q1 1AA', 'W1P 1AA', 'not a postcode', 'SW1A 1AA&api_key=leak']) {
    assert.equal(normalizeUkPostcode(invalid), null, invalid);
  }
});

test('provider lookup returns only normalized address components', async () => {
  let requestedUrl;
  const addresses = await lookupIdealPostcodes('SW1A 1AA', 'platform-secret', async url => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => ({ result: [{ line_1: '10 Downing Street', post_town: 'London', postcode: 'SW1A 1AA', uprn: '100', longitude: 1 }] }),
    };
  });
  assert.match(requestedUrl, /api\.ideal-postcodes\.co\.uk\/v1\/postcodes\/SW1A%201AA/);
  assert.equal(new URL(requestedUrl).searchParams.get('api_key'), 'platform-secret');
  assert.deepEqual(addresses, [{
    line_1: '10 Downing Street', line_2: '', line_3: '', post_town: 'London',
    county: '', postcode: 'SW1A 1AA', country: 'United Kingdom',
  }]);
  assert.equal(JSON.stringify(addresses).includes('platform-secret'), false);
  assert.equal(JSON.stringify(addresses).includes('uprn'), false);
});

test('required address components are enforced server-side', () => {
  const fields = [{ id: 'address', type: 'address_lookup', required: true }];
  assert.deepEqual(invalidRequiredAddressLookupFields(fields, { address: { line_1: '1 Road', postcode: 'AB1 2CD' } }), ['address']);
  assert.deepEqual(invalidRequiredAddressLookupFields(fields, {
    address: { line_1: '1 Road', post_town: 'Town', postcode: 'AB1 2CD', country: 'United Kingdom' },
  }), []);
});

test('optional address fields may be blank but validate configured components once started', () => {
  const fields = [{
    id: 'address',
    type: 'address_lookup',
    required: false,
    visible_components: ['line_1', 'post_town', 'postcode', 'country'],
    required_components: ['line_1', 'post_town', 'postcode', 'country'],
  }];
  assert.deepEqual(invalidRequiredAddressLookupFields(fields, {}), []);
  assert.deepEqual(invalidRequiredAddressLookupFields(fields, { address: {} }), []);
  assert.deepEqual(invalidRequiredAddressLookupFields(fields, {
    address: { line_1: '1 Road', postcode: 'AB1 2CD' },
  }), ['address']);
  assert.deepEqual(invalidRequiredAddressLookupFields(fields, {
    address: {
      line_1: '1 Road',
      post_town: 'Town',
      postcode: 'AB1 2CD',
      country: 'United Kingdom',
    },
  }), []);
});

test('a globally required address cannot be blank when no components are individually required', () => {
  const fields = [{
    id: 'address',
    type: 'address_lookup',
    required: true,
    visible_components: ['line_1', 'postcode'],
    required_components: [],
  }];
  assert.deepEqual(invalidRequiredAddressLookupFields(fields, {}), ['address']);
  assert.deepEqual(invalidRequiredAddressLookupFields(fields, { address: {} }), ['address']);
  assert.deepEqual(invalidRequiredAddressLookupFields(fields, {
    address: { postcode: 'AB1 2CD' },
  }), []);
});