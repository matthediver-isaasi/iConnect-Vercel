import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getTierEffectivePeriod,
  getTierLifecycle,
  getTierScopeLabel,
  groupTierStructures,
  isHistoricalTierSelection,
  isTierSelectionReadOnly,
} from './membershipTierNavigation.js';

const date = value => value ? value.replaceAll('-', '/') : '';

test('groups structures by their API lifecycle without changing semantics', () => {
  const grouped = groupTierStructures([
    { id: 'a', status: 'active' },
    { id: 's', status: 'scheduled' },
    { id: 'h', status: 'historical' },
  ]);
  assert.deepEqual(grouped.active.map(x => x.id), ['a']);
  assert.deepEqual(grouped.scheduled.map(x => x.id), ['s']);
  assert.deepEqual(grouped.historical.map(x => x.id), ['h']);
});

test('describes scoped and unscoped structures clearly', () => {
  assert.equal(getTierScopeLabel({ structure_scope_type: 'member' }), 'All members');
  assert.equal(getTierScopeLabel({
    structure_scope_type: 'organization',
    structure_field_id: 'region',
    structure_match_value: 'North',
  }, 'Region'), 'Organisation · Region = North');
});

test('formats scheduled, current and historical effective periods', () => {
  assert.equal(getTierEffectivePeriod({ status: 'scheduled', effective_from: '2027-01-01' }, date), 'Starts 2027/01/01');
  assert.equal(getTierEffectivePeriod({ status: 'active', effective_from: '2026-01-01' }, date), '2026/01/01 – Present');
  assert.equal(getTierEffectivePeriod({
    status: 'historical',
    effective_from: '2025-01-01',
    effective_to: '2025-12-31',
  }, date), '2025/01/01 – 2025/12/31');
  assert.equal(getTierLifecycle({ effective_to: '2025-12-31' }), 'historical');
});

test('historical selection becomes read-only from navigation data before detail loading', () => {
  const items = [
    { id: 'scheduled', status: 'scheduled' },
    { id: 'past', status: 'historical' },
  ];
  assert.equal(isHistoricalTierSelection('past', items), true);
  assert.equal(isHistoricalTierSelection('scheduled', items), false);
  assert.equal(isHistoricalTierSelection(null, items), false);
});

test('server-immutable structures are read-only even while still date-active', () => {
  const items = [
    { id: 'ending-current', status: 'active', effective_to: '2026-12-31' },
    { id: 'open-current', status: 'active', effective_to: null },
  ];
  assert.equal(isTierSelectionReadOnly('ending-current', items), true);
  assert.equal(isTierSelectionReadOnly('open-current', items), false);
});