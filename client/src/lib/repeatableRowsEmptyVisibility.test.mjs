import assert from 'node:assert/strict';
import test from 'node:test';
import {
  repeatableAvailabilityState,
  resolveRepeatableFirstColumnVisibility,
  REPEATABLE_EMPTY_AVAILABILITY_ERROR,
  REPEATABLE_EMPTY_AVAILABILITY_MISSING_PREREQUISITE,
  REPEATABLE_EMPTY_AVAILABILITY_PENDING,
  REPEATABLE_EMPTY_AVAILABILITY_RESOLVED,
} from './repeatableRowsEmptyVisibility.js';

const supported = { supported: true, reason: 'organisation_options' };

test('hides only after every row sees a resolved empty underlying domain', () => {
  assert.deepEqual(
    resolveRepeatableFirstColumnVisibility({
      enabled: true,
      support: supported,
      states: [
        repeatableAvailabilityState({ support: supported, optionCount: 0 }),
      ],
    }),
    { hidden: true, status: REPEATABLE_EMPTY_AVAILABILITY_RESOLVED, reason: 'empty_domain' },
  );
  assert.equal(resolveRepeatableFirstColumnVisibility({
    enabled: true,
    support: supported,
    states: [
      repeatableAvailabilityState({ support: supported, optionCount: 0 }),
      repeatableAvailabilityState({ support: supported, optionCount: 1 }),
    ],
  }).hidden, false);
});

test('does not hide while loading, unavailable, or waiting for a prerequisite', () => {
  for (const state of [
    repeatableAvailabilityState({ support: supported, loading: true }),
    repeatableAvailabilityState({ support: supported, error: true }),
    repeatableAvailabilityState({ support: supported, prerequisiteMissing: true }),
  ]) {
    const result = resolveRepeatableFirstColumnVisibility({
      enabled: true,
      support: supported,
      states: [state],
    });
    assert.equal(result.hidden, false);
    assert.notEqual(result.status, REPEATABLE_EMPTY_AVAILABILITY_RESOLVED);
  }
  assert.equal(REPEATABLE_EMPTY_AVAILABILITY_PENDING, 'pending');
  assert.equal(REPEATABLE_EMPTY_AVAILABILITY_ERROR, 'error');
  assert.equal(REPEATABLE_EMPTY_AVAILABILITY_MISSING_PREREQUISITE, 'missing_prerequisite');
});

test('disabled or unsupported configurations remain visible', () => {
  assert.equal(resolveRepeatableFirstColumnVisibility({
    enabled: false,
    support: supported,
    states: [repeatableAvailabilityState({ support: supported, optionCount: 0 })],
  }).hidden, false);
  assert.equal(resolveRepeatableFirstColumnVisibility({
    enabled: true,
    support: { supported: false, reason: 'not_supported' },
    states: [repeatableAvailabilityState({ support: supported, optionCount: 0 })],
  }).hidden, false);
});

test('availability state counts the underlying domain, not sibling-filtered choices', () => {
  const state = repeatableAvailabilityState({
    support: supported,
    optionCount: 3,
  });
  assert.deepEqual(state, {
    status: REPEATABLE_EMPTY_AVAILABILITY_RESOLVED,
    reason: 'options_available',
    optionCount: 3,
  });
});