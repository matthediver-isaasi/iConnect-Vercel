import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reconcileAutomaticMembershipFully,
  uniqueGroupPersonCount,
} from './memberGroupAutomaticSync.js';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('manual automatic-group sync continues until every batch is complete', async () => {
  const replies = [
    response(200, { syncStatus: 'running', inserted: 500, deleted: 0, matchCount: 1205, hasMore: true }),
    response(200, { syncStatus: 'idle', inserted: 705, deleted: 3, matchCount: 1205, hasMore: false }),
  ];
  const requests = [];
  const progress = [];
  const result = await reconcileAutomaticMembershipFully({
    groupId: 'group-a',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return replies.shift();
    },
    onProgress: (value) => progress.push(value),
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[0].options.body), { action: 'reconcile', groupId: 'group-a' });
  assert.equal(requests[0].options.credentials, 'include');
  assert.equal(progress.length, 2);
  assert.equal(result.batches, 2);
  assert.equal(result.inserted, 1205);
  assert.equal(result.deleted, 3);
  assert.equal(result.matchCount, 1205);
});

test('manual sync retries generation conflicts against fresh server state', async () => {
  const replies = [
    response(409, { code: 'STALE_GENERATION', error: 'Changed while syncing' }),
    response(200, { syncStatus: 'idle', inserted: 2, deleted: 0, matchCount: 2, hasMore: false }),
  ];
  let calls = 0;
  const result = await reconcileAutomaticMembershipFully({
    groupId: 'group-a',
    fetchImpl: async () => {
      calls += 1;
      return replies.shift();
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.matchCount, 2);
});

test('manual sync surfaces non-retryable server errors', async () => {
  await assert.rejects(
    () => reconcileAutomaticMembershipFully({
      groupId: 'group-a',
      fetchImpl: async () => response(403, { error: 'Admin access required' }),
    }),
    /Admin access required/,
  );
});

test('group people count deduplicates assignment rows without deleting them', () => {
  const assignments = [
    { id: 'automatic-a', member_id: 'member-a', assignment_source: 'automatic' },
    { id: 'manual-a', member_id: 'member-a', assignment_source: 'manual' },
    { id: 'member-b', member_id: 'member-b' },
    { id: 'guest-a', guest_id: 'guest-a' },
    { id: 'empty' },
  ];

  assert.equal(assignments.length, 5);
  assert.equal(uniqueGroupPersonCount(assignments), 3);
});