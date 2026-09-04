import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coalesceExplicitFallbackMappings,
  validateExplicitFallbackGroups,
} from './formMappingFallbacks.js';

const marked = (id, source, target = 'address') => ({
  id,
  source_field_id: source,
  target_type: 'core',
  target_field: target,
  fallback_group: { version: 1, id: 'address-fallback' },
});

test('legacy duplicate destinations retain their original order and identity', () => {
  const mappings = [
    { id: 'a', source_field_id: 'first', target_field: 'address' },
    { id: 'b', source_field_id: 'second', target_field: 'address' },
  ];
  assert.equal(coalesceExplicitFallbackMappings(mappings, { first: 'A', second: 'B' }), mappings);
});

test('explicit groups choose the first visible non-empty candidate', () => {
  const mappings = [marked('a', 'home'), marked('b', 'work')];
  assert.deepEqual(
    coalesceExplicitFallbackMappings(mappings, { home: '', work: 'Work address' }).map(m => m.id),
    ['b'],
  );
  assert.deepEqual(
    coalesceExplicitFallbackMappings(mappings, { home: 'Home', work: 'Work' }).map(m => m.id),
    ['a'],
  );
  assert.deepEqual(
    coalesceExplicitFallbackMappings(mappings, { home: 'forged', work: 'Work' }, new Set(['home'])).map(m => m.id),
    ['b'],
  );
});

test('false and zero are values, while absent/all-empty groups are no-ops', () => {
  const mappings = [marked('a', 'first'), marked('b', 'second')];
  assert.equal(coalesceExplicitFallbackMappings(mappings, { first: false })[0].id, 'a');
  assert.equal(coalesceExplicitFallbackMappings(mappings, { first: 0 })[0].id, 'a');
  assert.deepEqual(coalesceExplicitFallbackMappings(mappings, { first: '', second: [] }), []);
  assert.deepEqual(coalesceExplicitFallbackMappings(mappings, {}), []);
});

test('explicit clear remains eligible and group destinations must match', () => {
  const clear = { ...marked('clear', null), source_type: 'clear' };
  assert.equal(coalesceExplicitFallbackMappings([clear, marked('b', 'other')], { other: 'later' })[0].id, 'clear');
  assert.equal(validateExplicitFallbackGroups([marked('a', 'one'), marked('b', 'two', 'email')]).length, 1);
});

test('an empty candidate never implies a clear before a later explicit clear', () => {
  const clear = { ...marked('clear', null), source_type: 'clear' };
  const resolved = coalesceExplicitFallbackMappings([marked('empty', 'empty'), clear], { empty: '' });
  assert.deepEqual(resolved.map(mapping => mapping.id), ['clear']);
});

test('field candidates ignore default static placeholders and transformed empties', () => {
  const mappings = [
    { ...marked('first', 'first'), static_value: '', transformation: 'trim' },
    marked('second', 'second'),
  ];
  assert.equal(coalesceExplicitFallbackMappings(mappings, { first: '  ', second: 'chosen' })[0].id, 'second');
  assert.equal(coalesceExplicitFallbackMappings(mappings, { first: 'chosen', second: 'later' })[0].id, 'first');
});

test('fallback destinations cannot also have a legacy mapping', () => {
  assert.equal(validateExplicitFallbackGroups([
    marked('a', 'one'),
    marked('b', 'two'),
    { id: 'legacy', source_field_id: 'three', target_type: 'core', target_field: 'address' },
  ]).some(message => message.includes('mix fallback and legacy')), true);
});