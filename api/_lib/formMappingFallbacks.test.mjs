import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coalesceExplicitFallbackMappings,
  isFormFieldSourceMapping,
  partitionIgnoredHiddenMappings,
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

test('explicit groups choose the first non-empty candidate after opted-in hidden mappings are removed', () => {
  const mappings = [{ ...marked('a', 'home'), ignore_if_hidden: true }, marked('b', 'work')];
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

test('fallback candidates preserve hidden values by default', () => {
  const mappings = [marked('a', 'home'), marked('b', 'work')];
  assert.deepEqual(
    coalesceExplicitFallbackMappings(
      mappings,
      { home: 'Hidden but retained', work: 'Visible fallback' },
      new Set(['home']),
    ).map(mapping => mapping.id),
    ['a'],
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

test('address component candidates choose based on the scalar component value', () => {
  const mappings = [
    { ...marked('home-town', 'home'), source_component: 'post_town', ignore_if_hidden: true },
    { ...marked('work-town', 'work'), source_component: 'post_town' },
  ];
  assert.deepEqual(
    coalesceExplicitFallbackMappings(mappings, {
      home: { line_1: '1 Home Road', post_town: '' },
      work: { line_1: '', post_town: 'London' },
    }).map(mapping => mapping.id),
    ['work-town'],
  );
  assert.deepEqual(
    coalesceExplicitFallbackMappings(mappings, {
      home: { post_town: 'Hidden town' },
      work: { post_town: 'London' },
    }, new Set(['home'])).map(mapping => mapping.id),
    ['work-town'],
  );
});

test('ordinary field fallback candidates remain unchanged when no component is configured', () => {
  const mappings = [marked('first', 'first'), marked('second', 'second')];
  assert.equal(coalesceExplicitFallbackMappings(mappings, { first: { nested: true }, second: 'later' })[0].id, 'first');
});

test('fallback destinations cannot also have a legacy mapping', () => {
  assert.equal(validateExplicitFallbackGroups([
    marked('a', 'one'),
    marked('b', 'two'),
    { id: 'legacy', source_field_id: 'three', target_type: 'core', target_field: 'address' },
  ]).some(message => message.includes('mix fallback and legacy')), true);
});

test('hidden mappings are ignored only when the mapping explicitly opts in', () => {
  const mappings = [
    { id: 'ignored', source_type: 'field', source_field_id: 'hidden', ignore_if_hidden: true },
    { id: 'legacy', source_type: 'field', source_field_id: 'hidden' },
    { id: 'visible', source_type: 'field', source_field_id: 'visible', ignore_if_hidden: true },
  ];
  const result = partitionIgnoredHiddenMappings(mappings, new Set(['hidden']));
  assert.deepEqual(result.ignoredMappings.map(mapping => mapping.id), ['ignored']);
  assert.deepEqual(result.includedMappings.map(mapping => mapping.id), ['legacy', 'visible']);
});

test('non-field mappings are never suppressed by stale hidden source ids', () => {
  const mappings = [
    { id: 'static', source_type: 'static', source_field_id: 'hidden', static_value: 'fixed', ignore_if_hidden: true },
    { id: 'clear', source_type: 'clear', source_field_id: 'hidden', ignore_if_hidden: true },
    { id: 'date-type', source_type: 'current_date', source_field_id: 'hidden', ignore_if_hidden: true },
    { id: 'date-transform', source_field_id: 'hidden', transformation: 'current_date', ignore_if_hidden: true },
  ];
  const result = partitionIgnoredHiddenMappings(mappings, new Set(['hidden']));
  assert.deepEqual(result.ignoredMappings, []);
  assert.deepEqual(result.includedMappings, mappings);
  assert.equal(isFormFieldSourceMapping(mappings[0]), false);
  assert.equal(isFormFieldSourceMapping(mappings[3]), false);
});

test('ignored hidden mappings are removed before ordered fallback selection', () => {
  const hiddenFirst = { ...marked('hidden-first', 'hidden'), ignore_if_hidden: true };
  const visibleSecond = marked('visible-second', 'visible');
  const { includedMappings } = partitionIgnoredHiddenMappings(
    [hiddenFirst, visibleSecond],
    new Set(['hidden']),
  );
  assert.deepEqual(
    coalesceExplicitFallbackMappings(
      includedMappings,
      { hidden: 'forged hidden answer', visible: 'Visible answer' },
      new Set(['hidden']),
    ).map(mapping => mapping.id),
    ['visible-second'],
  );
});

test('source-less fallback candidates survive stale hidden source metadata', () => {
  const mappings = [
    {
      ...marked('static', 'hidden'),
      source_type: 'static',
      static_value: 'Fixed',
      ignore_if_hidden: true,
    },
    {
      ...marked('clear', 'hidden'),
      source_type: 'clear',
      ignore_if_hidden: true,
    },
    {
      ...marked('date', 'hidden'),
      source_type: 'current_date',
      transformation: 'current_date',
      ignore_if_hidden: true,
    },
  ];
  for (const mapping of mappings) {
    assert.deepEqual(
      coalesceExplicitFallbackMappings([mapping], {}, new Set(['hidden']))
        .map(candidate => candidate.id),
      [mapping.id],
    );
  }
});