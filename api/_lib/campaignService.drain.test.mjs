import test from 'node:test';
import assert from 'node:assert/strict';
import { drainCampaignRecipients, determineCampaignSendOutcome } from './campaignService.js';

function fixture(size) {
  const rows = Array.from({ length: size }, (_, i) => ({ id: i, status: 'pending' }));
  const claim = async () => {
    const row = rows.find(r => r.status === 'pending');
    if (!row) return [];
    // Models the conditional pending -> processing update. Two workers cannot
    // both own the same row even if they selected it concurrently.
    row.status = 'processing';
    return [row];
  };
  return { rows, claim };
}

test('slow survey personalization leaves unvisited recipients pending within request budget', async () => {
  const { rows, claim } = fixture(100);
  let clock = 0;
  const result = await drainCampaignRecipients({
    batchSize: 100, deadline: 38_000, now: () => clock, claim,
    gate: async () => ({ allowed: true }),
    release: async () => assert.fail('no release expected'),
    send: async row => { clock += 19_000; row.status = 'sent'; return 'sent'; },
  });
  assert.equal(result.sent, 2);
  assert.equal(rows.filter(r => r.status === 'pending').length, 98);
  assert.equal(rows.filter(r => r.status === 'processing').length, 0);
});

test('ordinary fast campaign drains and completes with accurate counts', async () => {
  const { rows, claim } = fixture(3);
  let clock = 0;
  await drainCampaignRecipients({
    batchSize: 100, deadline: 38_000, now: () => clock, claim,
    gate: async () => ({ allowed: true }),
    release: async () => assert.fail('no release expected'),
    send: async row => { clock += 100; row.status = 'sent'; return 'sent'; },
  });
  assert.deepEqual(rows.map(r => r.status), ['sent', 'sent', 'sent']);
  assert.equal(determineCampaignSendOutcome({ sent: 3 }).complete, true);
});

test('concurrent workers atomically claim disjoint rows', async () => {
  const { rows, claim } = fixture(4);
  const sent = [];
  const operations = () => ({
    batchSize: 2, claim,
    gate: async () => ({ allowed: true }),
    release: async () => assert.fail('no release expected'),
    send: async row => { sent.push(row.id); row.status = 'sent'; return 'sent'; },
  });
  await Promise.all([drainCampaignRecipients(operations()), drainCampaignRecipients(operations())]);
  assert.deepEqual(sent.sort(), [0, 1, 2, 3]);
  assert.ok(rows.every(r => r.status === 'sent'));
});

test('cancellation between recipients releases only the current claim', async () => {
  const { rows, claim } = fixture(4);
  let cancelled = false;
  const result = await drainCampaignRecipients({
    batchSize: 4, claim,
    gate: async () => cancelled ? { allowed: false, cancelled: true, campaign: { status: 'cancelled' } } : { allowed: true },
    release: async (row, status) => { row.status = status; },
    send: async row => { row.status = 'sent'; cancelled = true; return 'sent'; },
  });
  assert.equal(result.sent, 1);
  assert.equal(result.stoppedGate.cancelled, true);
  assert.equal(rows.filter(r => r.status === 'pending').length, 2);
  assert.equal(rows.filter(r => r.status === 'cancelled').length, 1);
});

test('abandoned processing is distinct from untouched pending and never counts as completion', () => {
  const result = determineCampaignSendOutcome({ sent: 1, queued: 2, processing: 1 });
  assert.equal(result.queued, 2);
  assert.equal(result.processing, 1);
  assert.equal(result.complete, false);
  assert.equal(result.status, 'sending');
});