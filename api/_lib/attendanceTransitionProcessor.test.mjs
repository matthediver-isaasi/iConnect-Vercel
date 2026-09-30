import test from 'node:test';
import assert from 'node:assert/strict';
import { processAttendanceTransitionOutbox } from './attendanceTransitionProcessor.js';

function database(rows) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'claim_attendance_transition_outbox') return { data: rows, error: null };
      return { data: true, error: null };
    },
  };
}

test('processor acknowledges a transition only after publication', async () => {
  const row = { id: 'outbox-1', lock_token: 'lock-1', payload: { transitionId: 'transition-1' } };
  const db = database([row]);
  const published = [];
  const result = await processAttendanceTransitionOutbox(db, {
    publish: async (item) => published.push(item.id),
  });
  assert.deepEqual(result, { claimed: 1, published: 1, failed: 0 });
  assert.deepEqual(published, ['outbox-1']);
  assert.equal(db.calls[1].name, 'complete_attendance_transition_outbox');
  assert.deepEqual(db.calls[1].args, { p_id: 'outbox-1', p_lock_token: 'lock-1' });
});

test('processor releases failed publications for durable retry', async () => {
  const db = database([{ id: 'outbox-2', lock_token: 'lock-2', payload: {} }]);
  const result = await processAttendanceTransitionOutbox(db, {
    maxAttempts: 4,
    publish: async () => { throw new Error('downstream unavailable'); },
  });
  assert.deepEqual(result, { claimed: 1, published: 0, failed: 1 });
  assert.equal(db.calls[1].name, 'fail_attendance_transition_outbox');
  assert.deepEqual(db.calls[1].args, {
    p_id: 'outbox-2',
    p_lock_token: 'lock-2',
    p_error: 'downstream unavailable',
    p_max_attempts: 4,
  });
});

test('processor retries while an earlier workflow delivery claim is blocked', async () => {
  const db = database([{ id: 'outbox-3', lock_token: 'lock-3', payload: {} }]);
  const result = await processAttendanceTransitionOutbox(db, {
    publish: async () => ({ delivery: { status: 'blocked' } }),
  });
  assert.deepEqual(result, { claimed: 1, published: 0, failed: 1 });
  assert.equal(db.calls[1].name, 'fail_attendance_transition_outbox');
  assert.match(db.calls[1].args.p_error, /is blocked/);
});