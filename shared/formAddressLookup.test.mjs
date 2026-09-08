import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addressEntryModeSourceFields,
  addressLookupRequiredComponents,
  assertValidAddressLookupMappingComponents,
  isAddressLookupAnswerFilled,
  normalizeAddressLookupAnswer,
  normalizeAddressEntryModeRule,
  resolveAddressManualOnly,
  validateAddressEntryModeRule,
  validateAddressLookupMappingComponent,
} from './formAddressLookup.js';

test('normalizes provider aliases to the persisted address contract', () => {
  assert.deepEqual(normalizeAddressLookupAnswer({
    line1: ' 10 High Street ', post_town: ' Leeds ', region: 'West Yorkshire', post_code: 'ls1 1aa',
  }), {
    line_1: '10 High Street', line_2: '', line_3: '', post_town: 'Leeds', county: 'West Yorkshire', postcode: 'ls1 1aa', country: '',
  });
});

test('manual-only address rules use stable preceding field ids and explicit operators', () => {
  const fields = [
    { id: 'country', type: 'country' },
    { id: 'note', type: 'instructions' },
    { id: 'address', type: 'address_lookup', address_entry_mode_rule: {
      source_field_id: 'country', operator: 'not_equals', value: 'United Kingdom',
    } },
    { id: 'later', type: 'select' },
  ];
  assert.deepEqual(addressEntryModeSourceFields(fields, 'address').map(field => field.id), ['country']);
  assert.equal(validateAddressEntryModeRule(fields[2], fields).valid, true);
  assert.equal(resolveAddressManualOnly(fields[2], fields, { country: 'France' }), true);
  assert.equal(resolveAddressManualOnly(fields[2], fields, { country: 'United Kingdom' }), false);
  assert.equal(resolveAddressManualOnly(fields[2], fields, {}), false);
});

test('BNMS full member form switches its persisted address rule for United States', () => {
  const fields = [
    {
      id: 'field_1786371332409',
      type: 'country',
      label: 'What country are you based in?',
    },
    {
      id: 'field_1788468466745',
      type: 'address_lookup',
      label: 'Address',
      address_entry_mode_rule: {
        source_field_id: 'field_1786371332409',
        operator: 'not_equals',
        value: 'United Kingdom',
      },
    },
  ];

  assert.equal(resolveAddressManualOnly(
    fields[1],
    fields,
    { field_1786371332409: 'United States' },
  ), true);
  assert.equal(resolveAddressManualOnly(
    fields[1],
    fields,
    { field_1786371332409: 'United Kingdom' },
  ), false);
});

test('missing, malformed, deleted, and following source rules safely retain postcode lookup', () => {
  const address = { id: 'address', type: 'address_lookup' };
  const later = { id: 'later', type: 'select' };
  const fields = [address, later];
  assert.equal(normalizeAddressEntryModeRule({ source_field_id: 'later', operator: 'contains', value: 'x' }), null);
  assert.equal(normalizeAddressEntryModeRule({ source_field_id: 'later', operator: 'equals', value: '  ' }), null);
  for (const rule of [
    null,
    { source_field_id: 'missing', operator: 'equals', value: 'x' },
    { source_field_id: 'later', operator: 'equals', value: 'x' },
  ]) {
    assert.equal(resolveAddressManualOnly({ ...address, address_entry_mode_rule: rule }, fields, { later: 'x' }), false);
  }
});

test('manual-only rules support multi-value and boolean source answers', () => {
  const fields = [
    { id: 'countries', type: 'countries' },
    { id: 'address', type: 'address_lookup' },
  ];
  assert.equal(resolveAddressManualOnly({
    ...fields[1],
    address_entry_mode_rule: { source_field_id: 'countries', operator: 'equals', value: 'France' },
  }, fields, { countries: ['France', 'Germany'] }), true);
});

test('address lookup validation respects visible required components', () => {
  const field = { required: true, visible_components: ['line_1', 'post_town', 'postcode'], required_components: ['line_1', 'postcode'] };
  assert.deepEqual(addressLookupRequiredComponents(field), ['line_1', 'postcode']);
  assert.equal(isAddressLookupAnswerFilled(field, { line_1: '10 High Street', postcode: 'LS1 1AA' }), true);
  assert.equal(isAddressLookupAnswerFilled(field, { line_1: '10 High Street', postcode: ' ' }), false);
});

test('field mappings require a currently visible address component', () => {
  const fields = [
    { id: 'address', type: 'address_lookup', visible_components: ['line_1', 'post_town', 'postcode'] },
    { id: 'name', type: 'text' },
  ];
  assert.equal(validateAddressLookupMappingComponent({
    source_type: 'field', source_field_id: 'address', source_component: 'line_1',
  }, fields).valid, true);
  for (const source_component of [undefined, 'county', 'uprn']) {
    assert.equal(validateAddressLookupMappingComponent({
      source_type: 'field', source_field_id: 'address', source_component,
    }, fields).valid, false);
  }
});

test('ordinary and static mappings reject stale address component metadata', () => {
  const fields = [{ id: 'name', type: 'text' }];
  assert.equal(validateAddressLookupMappingComponent({
    source_type: 'field', source_field_id: 'name',
  }, fields).valid, true);
  assert.equal(validateAddressLookupMappingComponent({
    source_type: 'field', source_field_id: 'name', source_component: 'line_1',
  }, fields).valid, false);
  assert.equal(validateAddressLookupMappingComponent({
    source_type: 'static', static_value: 'London', source_component: 'post_town',
  }, fields).valid, false);
  assert.throws(
    () => assertValidAddressLookupMappingComponents([
      { source_type: 'field', source_field_id: 'name' },
      { source_type: 'static', static_value: 'London', source_component: 'post_town' },
    ], fields),
    error => error.code === 'INVALID_FORM_ADDRESS_COMPONENT_MAPPING'
      && error.details[0].startsWith('mapping 2 '),
  );
});