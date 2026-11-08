import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { termEndFieldsFromConfig, memberDateTermPolicyErrors } from './memberDateTermPolicy.js';

const fieldId = 'a9d3b75c-35ab-4df7-a395-ffaf10981232';
const valid = {
  term_end_mode: 'member_date_field',
  term_end_field_id: fieldId,
  structure_scope_type: 'member',
  pricing_model: 'flat',
  flat_cost: '0',
};

test('legacy and new structures default to standard with no field', () => {
  for (const config of [null, undefined, {}, { term_end_mode: null }]) {
    assert.deepEqual(termEndFieldsFromConfig(config), { term_end_mode: 'standard', term_end_field_id: null });
  }
});

test('saved mode and UUID roundtrip without requiring successful field discovery', () => {
  assert.deepEqual(termEndFieldsFromConfig(valid), {
    term_end_mode: 'member_date_field', term_end_field_id: fieldId,
  });
  assert.deepEqual(termEndFieldsFromConfig({ term_end_mode: 'standard', term_end_field_id: fieldId }), {
    term_end_mode: 'standard', term_end_field_id: fieldId,
  });
});

test('standard schedules keep existing behavior even with paid or recurring settings', () => {
  assert.deepEqual(memberDateTermPolicyErrors({ ...valid, term_end_mode: 'standard', flat_cost: 87.5, dd_enabled: true }), []);
});

test('flat explicitly zero-cost member terms pass without changing input', () => {
  for (const flat_cost of [0, '0', '0.00']) {
    const config = Object.freeze({ ...valid, flat_cost });
    assert.deepEqual(memberDateTermPolicyErrors(config), []);
    assert.equal(config.flat_cost, flat_cost);
  }
});

test('nonzero, missing and invalid prices block instead of becoming free', () => {
  for (const flat_cost of [87.5, '0.01', '', null, undefined, 'invalid', -1]) {
    const config = Object.freeze({ ...valid, flat_cost });
    assert.match(memberDateTermPolicyErrors(config).join(' '), /explicitly enter a cost of 0/);
    assert.equal(config.flat_cost, flat_cost);
  }
});

test('organization scope and tiered pricing are blocked', () => {
  assert.match(memberDateTermPolicyErrors({ ...valid, structure_scope_type: 'organization' }).join(' '), /member-scoped/);
  assert.match(memberDateTermPolicyErrors({ ...valid, pricing_model: 'tiered' }).join(' '), /flat pricing/);
});

test('every unsupported setting produces a clear blocking message', () => {
  for (const [key, value, message] of [
    ['dd_enabled', true, /Direct Debit/],
    ['card_monthly_enabled', true, /monthly card/],
    ['prorata_enabled', true, /pro-rata/],
    ['free_period_enabled', true, /free period/],
    ['free_period_amount', 3, /free period/],
    ['rollover_enabled', true, /rollover/],
  ]) {
    assert.match(memberDateTermPolicyErrors({ ...valid, [key]: value }).join(' '), message, key);
  }
});

test('a UUID date field selection is required', () => {
  for (const term_end_field_id of [null, '', 'core:expiry', 'not-a-uuid']) {
    assert.match(memberDateTermPolicyErrors({ ...valid, term_end_field_id }).join(' '), /Choose a member date custom field/);
  }
});

test('all page hydration and clone paths use shared term policy hydration', () => {
  const source = readFileSync(new URL('../pages/MembershipTierManagement.jsx', import.meta.url), 'utf8');
  assert.equal((source.match(/\.\.\.renewalFieldsFromConfig\(c\)/g) || []).length, 3);
  assert.match(source, /const renewalFieldsFromConfig = \(c\) => \(\{\s*\.\.\.termEndFieldsFromConfig\(c\)/);
  assert.match(source, /\.\.\.renewalFieldsFromConfig\(null\)/);
  assert.match(source, /\.\.\.configWithoutUiFlags,\s*\.\.\.termEndFieldsFromConfig\(config\)/);
  assert.match(source, /if \(termEndFieldsFailed\) errors\.push/);
  assert.match(source, /else if \(!selectedTermEndField\) errors\.push/);
  assert.doesNotMatch(source, /setConfig[^;]*\btermEndFields\b/s);
});
