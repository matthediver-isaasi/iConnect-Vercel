import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignSendConcurrency, drainCampaignRecipients } from './campaignDrain.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(size = 12) {
  const rows = Array.from({ length: size }, (_, id) => ({ id, status: 'pending' }));
  const options = {
    batchSize: size, concurrency: 2,
    claim: async () => {
      const row = rows.find(row => row.status === 'pending');
      if (!row) return [];
      row.status = 'processing';
      return [row];
    },
    gate: async () => ({ allowed: true }),
    release: async (row, status) => { row.status = status; },
    send: async row => { row.status = 'sent'; return 'sent'; },
  };
  return { rows, options };
}

test('configuration defaults to two and clamps integer slots to one through four', () => {
  for (const [input, expected] of [[undefined, 2], ['bad', 2], [Infinity, 2], [0, 1], [-1, 1], [99, 4], ['3.9', 3]]) {
    assert.equal(campaignSendConcurrency(input), expected);
  }
});

test('bounded sends overlap, batch cap is global across slots and claims are disjoint', async () => {
  const { rows, options } = fixture();
  const blockers = [deferred(), deferred()];
  const started = [];
  let active = 0, maxActive = 0;
  const running = drainCampaignRecipients({ ...options, batchSize: 5, send: async row => {
    started.push(row.id);
    maxActive = Math.max(maxActive, ++active);
    if (row.id < 2) await blockers[row.id].promise;
    row.status = 'sent';
    active--;
    return 'sent';
  } });
  await tick();
  assert.deepEqual(started, [0, 1]);
  blockers.forEach(blocker => blocker.resolve());
  const result = await running;
  assert.equal(maxActive, 2);
  assert.equal(result.sent, 5);
  assert.equal(new Set(started).size, 5);
  assert.equal(rows.filter(row => row.status === 'pending').length, 7);
  assert.equal(result.metrics.stopReason, 'batch_cap');
});

test('two overlapping workers conditionally claim disjoint rows', async () => {
  const { rows, options } = fixture(8);
  const blocker = deferred();
  const ids = [];
  const send = async row => { ids.push(row.id); await blocker.promise; row.status = 'sent'; return 'sent'; };
  const runs = [1, 2].map(() => drainCampaignRecipients({ ...options, batchSize: 4, send }));
  await tick();
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4);
  blocker.resolve();
  await Promise.all(runs);
  assert.equal(new Set(ids).size, 8);
  assert.ok(rows.every(row => row.status === 'sent'));
});

for (const reason of ['cancelled', 'paused', 'authority', 'deadline']) {
  test(`${reason} stops admission and releases only definitively unsent current claim`, async () => {
    const { rows, options } = fixture();
    const blocker = deferred();
    let calls = 0, clock = 0;
    const run = drainCampaignRecipients({ ...options, deadline: 100, now: () => clock,
      gate: async () => {
        if (++calls === 2) {
          if (reason === 'deadline') clock = 100;
          else return { allowed: false, cancelled: reason === 'cancelled', paused: reason === 'paused' };
        }
        return { allowed: true };
      },
      send: async row => { await blocker.promise; row.status = 'sent'; return 'sent'; },
    });
    await tick();
    assert.equal(rows[1].status, reason === 'cancelled' ? 'cancelled' : 'pending');
    assert.equal(rows[0].status, 'processing');
    blocker.resolve();
    const result = await run;
    assert.equal(result.sent, 1);
    assert.equal(rows.slice(2).every(row => row.status === 'pending'), true);
  });
}

for (const failure of ['claim', 'gate', 'send', 'release']) {
  test(`${failure} exception awaits every started send before rejecting`, async () => {
    const { rows, options } = fixture();
    const blocker = deferred();
    let claimCalls = 0, gateCalls = 0, settled = false;
    const error = new Error(failure);
    const run = drainCampaignRecipients({ ...options,
      claim: async () => { if (++claimCalls === 2 && failure === 'claim') throw error; return options.claim(); },
      gate: async () => {
        if (++gateCalls === 2) {
          if (failure === 'gate') throw error;
          if (failure === 'release') return { allowed: false };
        }
        return { allowed: true };
      },
      release: async (...args) => { if (failure === 'release') throw error; return options.release(...args); },
      send: async row => {
        if (row.id === 1 && failure === 'send') throw error;
        await blocker.promise; row.status = 'sent'; return 'sent';
      },
    }).then(() => assert.fail('must reject'), caught => {
      assert.equal(caught, error); settled = true;
    });
    await tick();
    assert.equal(settled, false);
    blocker.resolve();
    await run;
    assert.equal(rows[0].status, 'sent');
    if (failure === 'send') assert.equal(rows[1].status, 'processing');
  });
}

test('429 stops admissions while already started sends are awaited, not reclaimed', async () => {
  const { rows, options } = fixture();
  const blocker = deferred();
  let settled = false;
  const run = drainCampaignRecipients({ ...options, send: async (row, control) => {
    if (row.id === 1) {
      control.stop('rate_limit');
      row.status = 'failed'; // definitive rejection, no automatic cron replay
      return 'rate_limited';
    }
    await blocker.promise;
    row.status = 'sent'; return 'sent';
  } }).then(result => { settled = true; return result; });
  await tick();
  assert.equal(settled, false);
  assert.ok(rows.slice(2).every(row => row.status === 'pending'));
  blocker.resolve();
  const result = await run;
  assert.equal(result.metrics.stopReason, 'rate_limit');
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
  const nextInvocationIds = [];
  await drainCampaignRecipients({ ...options, send: async row => {
    nextInvocationIds.push(row.id);
    row.status = 'sent';
    return 'sent';
  } });
  assert.equal(nextInvocationIds.includes(1), false);
  assert.equal(rows[1].status, 'failed');
});

test('ambiguous provider/persistence result stays owned and aggregate has no recipient data', async () => {
  const { rows, options } = fixture(2);
  const result = await drainCampaignRecipients({ ...options, send: async () => 'processing' });
  assert.ok(rows.every(row => row.status === 'processing'));
  assert.equal(result.metrics.processing, 2);
  assert.deepEqual(Object.keys(result.metrics).sort(), [
    'attempted', 'claimMs', 'claimed', 'concurrency', 'elapsedMs', 'failed',
    'gateMs', 'processing', 'sendMs', 'sent', 'stopReason',
  ].sort());
});

for (const firstReason of ['recipient_stop', 'cancelled', 'deadline']) {
  test(`late rate limit overrides earlier ${firstReason} and remains invocation-wide`, async () => {
    const { options } = fixture(4);
    const lateProvider = deferred();
    let gateCalls = 0, clock = 0;
    const running = drainCampaignRecipients({ ...options, deadline: 100, now: () => clock,
      gate: async () => {
        if (++gateCalls === 2) {
          if (firstReason === 'cancelled') return { allowed: false, cancelled: true };
          if (firstReason === 'deadline') clock = 100;
        }
        return { allowed: true };
      },
      send: async (row, control) => {
        if (firstReason === 'recipient_stop' && row.id === 0) {
          // Wait until the second slot has already begun, then stop this one.
          await tick();
          row.status = 'pending';
          return 'stopped';
        }
        await lateProvider.promise;
        control.stop('rate_limit');
        row.status = 'failed';
        return 'rate_limited';
      },
    });
    await tick();
    await tick();
    lateProvider.resolve();
    const result = await running;
    assert.equal(result.metrics.stopReason, 'rate_limit');
    assert.equal(result.failed, 1);
  });
}