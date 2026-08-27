import test from 'node:test';
import assert from 'node:assert/strict';
import { getMembershipHistoryLifecycle } from './membershipHistoryLifecycle.js';

test('marks the configured membership year as current', () => {
  assert.deepEqual(
    getMembershipHistoryLifecycle(
      { membership_year: '2026/2027', status: 'active' },
      '2026/2027',
    ),
    { key: 'current', label: 'Current', variant: 'secondary' },
  );
});

test('marks an older persisted active row as historical when a newer year is current', () => {
  assert.deepEqual(
    getMembershipHistoryLifecycle(
      { membership_year: '2025/2026', status: 'active' },
      '2026/2027',
    ),
    { key: 'historical', label: 'Historical', variant: 'outline' },
  );
});

test('keeps a future pre-created year visibly scheduled', () => {
  assert.deepEqual(
    getMembershipHistoryLifecycle(
      { membership_year: '2027/2028', status: 'scheduled' },
      '2026/2027',
    ),
    { key: 'scheduled', label: 'Scheduled', variant: 'outline' },
  );
});

test('classifies a future year as scheduled even when its persisted status is stale', () => {
  assert.equal(
    getMembershipHistoryLifecycle(
      { membership_year: '2027/2028', status: 'active' },
      '2026/2027',
    ).label,
    'Scheduled',
  );
});