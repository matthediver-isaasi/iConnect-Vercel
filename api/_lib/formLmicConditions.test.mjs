import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateLmicCondition,
  isLmicOperator,
  rulesUseLmicOperators,
  toLmicCodeSet,
} from './formLmicConditions.js';

const LMIC = ['KE', 'IN', 'BD'];

test('non-LMIC operators return undefined (fall through)', () => {
  assert.equal(evaluateLmicCondition('Kenya', 'equals', LMIC), undefined);
  assert.equal(evaluateLmicCondition('Kenya', 'contains', LMIC), undefined);
  assert.equal(isLmicOperator('equals'), false);
  assert.equal(isLmicOperator('is_lmic'), true);
  assert.equal(isLmicOperator('is_not_lmic'), true);
});

test('country names and ISO codes both resolve', () => {
  assert.equal(evaluateLmicCondition('Kenya', 'is_lmic', LMIC), true);
  assert.equal(evaluateLmicCondition('KE', 'is_lmic', LMIC), true);
  assert.equal(evaluateLmicCondition('ke', 'is_lmic', LMIC), true);
  assert.equal(evaluateLmicCondition('United Kingdom', 'is_lmic', LMIC), false);
  assert.equal(evaluateLmicCondition('GB', 'is_not_lmic', LMIC), true);
  assert.equal(evaluateLmicCondition('India', 'is_not_lmic', LMIC), false);
});

test('empty/unknown values match NEITHER operator', () => {
  for (const v of ['', null, undefined, [], 'Narnia', '  ']) {
    assert.equal(evaluateLmicCondition(v, 'is_lmic', LMIC), false, `is_lmic ${JSON.stringify(v)}`);
    assert.equal(evaluateLmicCondition(v, 'is_not_lmic', LMIC), false, `is_not_lmic ${JSON.stringify(v)}`);
  }
});

test('multi-country values: is_lmic matches when ANY is LMIC', () => {
  assert.equal(evaluateLmicCondition(['United Kingdom', 'Kenya'], 'is_lmic', LMIC), true);
  assert.equal(evaluateLmicCondition(['United Kingdom', 'France'], 'is_lmic', LMIC), false);
  // is_not_lmic is the complement over answered values
  assert.equal(evaluateLmicCondition(['United Kingdom', 'Kenya'], 'is_not_lmic', LMIC), false);
  assert.equal(evaluateLmicCondition(['United Kingdom', 'France'], 'is_not_lmic', LMIC), true);
  // unresolvable entries are ignored when others resolve
  assert.equal(evaluateLmicCondition(['Narnia', 'Kenya'], 'is_lmic', LMIC), true);
});

test('empty tenant list: is_lmic matches nothing, is_not_lmic matches resolved countries', () => {
  assert.equal(evaluateLmicCondition('Kenya', 'is_lmic', []), false);
  assert.equal(evaluateLmicCondition('Kenya', 'is_not_lmic', []), true);
  assert.equal(evaluateLmicCondition('Kenya', 'is_lmic', null), false);
});

test('code set accepts arrays and Sets, case-insensitively', () => {
  assert.equal(evaluateLmicCondition('Kenya', 'is_lmic', new Set(['ke'])), true);
  assert.deepEqual([...toLmicCodeSet([' ke ', 'IN'])].sort(), ['IN', 'KE']);
});

test('rulesUseLmicOperators detects legacy and conditions-array shapes', () => {
  assert.equal(rulesUseLmicOperators(null), false);
  assert.equal(rulesUseLmicOperators([]), false);
  assert.equal(rulesUseLmicOperators([{ trigger_field_id: 'f1', operator: 'equals' }]), false);
  assert.equal(rulesUseLmicOperators([{ trigger_field_id: 'f1', operator: 'is_lmic' }]), true);
  assert.equal(rulesUseLmicOperators([{ conditions: [{ field_id: 'f1', operator: 'is_not_lmic' }] }]), true);
  assert.equal(rulesUseLmicOperators([{ conditions: [{ field_id: 'f1', operator: 'contains' }] }]), false);
});
