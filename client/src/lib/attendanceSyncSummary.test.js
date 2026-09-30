import test from 'node:test';
import assert from 'node:assert/strict';
import { attendanceSyncMessage, responseErrors, responseHasPendingSync } from './attendanceSyncSummary.js';

test('manual sync never calls an all-failure result successful', () => {
  const summary = attendanceSyncMessage({ errors: ['Teams consent required'] });
  assert.equal(summary.level, 'error');
  assert.match(summary.message, /Teams consent required/);
});

test('manual sync identifies aggregate pending and partial responses', () => {
  assert.equal(responseHasPendingSync({ pendingCount: 1 }, 200), true);
  assert.deepEqual(responseErrors({ failures: [{ message: 'Zoom unavailable' }] }), ['Zoom unavailable']);
  assert.equal(attendanceSyncMessage({ participants: 2, matched: 1, pending: 1 }).level, 'info');
});