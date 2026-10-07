import test from 'node:test';
import assert from 'node:assert/strict';
import { renewalExecutionLog } from './renewalExecutionLog.js';

test('renewal evidence accepts historic JSON strings and current objects', () => {
  const details = { outcome: 'needs_review', workerAvailable: true, reviewCount: 1,
    reviews: [{ recordId: 'r', reasons: ['Needs reconciliation'], ageHours: 48 }], duration_ms: 42 };
  for (const value of [details, JSON.stringify(details), JSON.stringify(JSON.stringify(details))]) {
    const data = renewalExecutionLog({ task_name: 'membership_renewals', details: value });
    assert.equal(data.workerAvailable, true);
    assert.equal(data.reviewCount, 1);
    assert.equal(data.summary, '1 unresolved review');
    assert.equal(data.reviews[0].ageHours, 48);
    assert.equal(data.durationMs, 42);
  }
});
test('malformed and older evidence does not imply a healthy worker', () => {
  assert.equal(renewalExecutionLog({ task_name: 'other' }), null);
  assert.deepEqual(renewalExecutionLog({ task_name: 'membership_renewals', details: 'broken' }), { unavailable: true });
  assert.equal(renewalExecutionLog({ task_name: 'membership_renewals', details: { outcome: 'deferred' } }).workerAvailable, null);
});
