import test from 'node:test';
import assert from 'node:assert/strict';
import { runMembershipRenewals, renewalOutcome, withRenewalReadDeadline } from './membershipRenewalRunner.js';
import { renewalRows, assertRenewalBudget, RenewalBudgetExceeded } from './membershipRenewalBudget.js';

const clone = value => structuredClone(value);
const tenant = (id = 'a', hour = 6) => ({ tenant_id: id, scheduled_hour: hour });
const complete = () => ({ complete: true, examined: 0, enforced: 0, cursor: null });

// In-memory RPC boundaries clone payloads, just as JSON transport does. No
// application/database/provider module is imported by this suite.
function database({ tenants = [tenant()], initialState = {}, cap = 200, busy = false,
  claimError = null, discoveryError = null, logError = null, releaseError = null,
  saveError = null, onWrite = async () => {}, onRead = async () => {},
} = {}) {
  let state = clone(initialState);
  const writes = [];
  const pages = [];
  const db = {
    get state() { return clone(state); },
    writes, pages,
    rpc(name, args) {
      if (name === 'claim_membership_renewal_cron') {
        return Promise.resolve({ data: { claimed: !busy, state: clone(state) }, error: claimError });
      }
      if (name === 'membership_renewal_cron_tenants') {
        return {
          order(column) { assert.equal(column, 'tenant_id'); return this; },
          async range(start, end) {
            await onRead();
            pages.push([start, end]);
            return { data: tenants.slice(start, Math.min(end + 1, start + cap)), error: discoveryError };
          },
        };
      }
      assert.equal(name, 'save_membership_renewal_cron');
      const saved = clone(args);
      return (async () => {
        await onWrite();
        writes.push({ type: 'save', ...saved });
        const error = args.p_release ? releaseError : saveError;
        if (!error) state = clone(saved.p_state);
        return { data: error ? null : { saved: true }, error };
      })();
    },
    from(table) {
      assert.equal(table, 'scheduled_task_log');
      return {
        async insert(row) {
          await onWrite();
          writes.push({ type: 'log', row: clone(row) });
          return { data: null, error: logError };
        },
      };
    },
  };
  return db;
}

function harness(options = {}) {
  let time = Date.parse(options.at || '2026-09-18T06:00:00Z');
  const events = [];
  const db = options.db || database();
  const run = overrides => runMembershipRenewals({
    db, clock: () => time, owner: 'test-owner',
    logger: { log: text => events.push(JSON.parse(text)) },
    pause: async () => {},
    expiry: async () => complete(),
    stages: [],
    ...options,
    ...overrides,
  });
  return { db, events, run, advance(ms) { time += ms; }, setTime(value) { time = Date.parse(value); } };
}

function rowsQuery(rows, cap = 100) {
  const calls = [];
  const factory = () => {
    let after = null;
    let key = null;
    let limit = 100;
    const query = {
      order(column) { key = column; return this; },
      limit(value) { limit = value; return this; },
      gt(column, value) { assert.equal(column, key); after = value; return this; },
      then(resolve, reject) {
        calls.push(after);
        return Promise.resolve({
          data: rows.filter(row => !after || row[key] > after).slice(0, Math.min(cap, limit)),
          error: null,
        }).then(resolve, reject);
      },
    };
    return query;
  };
  return { factory, calls };
}

test('hourly expiry is independent of billing hours; due billing precedes expiry', async () => {
  const db = database({ tenants: [tenant('a', 6), tenant('b', 9)] });
  const h = harness({ db });
  const calls = [];
  const result = await h.run({
    pause: async () => { calls.push('pause'); },
    stages: [['activation', async id => { calls.push(`activation:${id}`); }],
      ['invoices', async id => { calls.push(`invoices:${id}`); }]],
    expiry: async (_, id) => { calls.push(`expiry:${id}`); return complete(); },
  });
  assert.deepEqual(calls, ['pause', 'activation:a', 'invoices:a', 'expiry:a', 'expiry:b']);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.healthy, true);
  assert.equal(db.state.billing.a.done, true);
  assert.equal(db.state.billing.b, undefined);
  const starts = h.events.filter(e => e.event === 'start').map(e => e.stage);
  assert.ok(starts.includes('configuration-discovery'));
  assert.ok(starts.includes('finalization'));
});

test('after-hour catchup registers today once and resets only on next due day', async () => {
  const h = harness({ at: '2026-09-18T10:00:00Z' });
  let billings = 0;
  const stages = [['invoices', async () => { billings++; }]];
  await h.run({ stages });
  await h.run({ stages });
  assert.equal(billings, 1);
  assert.equal(h.db.state.billing.a.date, '2026-09-18');
  h.setTime('2026-09-19T05:00:00Z');
  await h.run({ stages });
  assert.equal(billings, 1);
  h.setTime('2026-09-19T07:00:00Z');
  await h.run({ stages });
  assert.equal(billings, 2);
  assert.equal(h.db.state.billing.a.date, '2026-09-19');
});

test('unfinished prior-day stage resumes before a new daily opportunity', async () => {
  const db = database({ initialState: {
    billing: { a: { date: '2026-09-17', stage: 1, cursor: 'old-row' } },
  } });
  const h = harness({ db });
  const seen = [];
  const stages = [['completed', async () => { assert.fail('Completed stage replayed'); }],
    ['resume', async (_, results) => { seen.push(results.__renewalControl.cursor); }]];
  await h.run({ stages });
  assert.deepEqual(seen, ['old-row']);
  assert.equal(db.state.billing.a.date, '2026-09-17');
  assert.equal(db.state.billing.a.done, true);
});

test('a failed row is retained while earlier stage and row checkpoints survive retry', async () => {
  const h = harness();
  const source = rowsQuery([{ id: '01' }, { id: '02' }, { id: '03' }], 1);
  const seen = [];
  let fail = true;
  let activations = 0;
  const stages = [
    ['activation', async () => { activations++; }],
    ['invoices', async (_, results) => {
      for await (const row of renewalRows(source.factory, {
        control: results.__renewalControl, results,
      })) {
        seen.push(row.id);
        if (fail && row.id === '02') {
          results.errors++;
          results.details.push({ tenantId: 'a', status: 'error', reason: 'provider rejected' });
        }
      }
    }],
  ];
  const first = await h.run({ stages });
  assert.equal(first.healthy, false);
  assert.equal(first.outcome, 'failed');
  assert.equal(h.db.state.billing.a.stage, 1);
  assert.equal(h.db.state.billing.a.cursor, '01');
  assert.equal(h.db.state.billing.a.done, undefined);
  fail = false;
  const second = await h.run({ stages });
  assert.equal(second.healthy, true);
  assert.equal(activations, 1);
  assert.deepEqual(seen, ['01', '02', '02', '03']);
  assert.equal(h.db.state.billing.a.done, true);
  assert.equal(Object.keys(second).includes('__renewalControl'), false);
});

test('cooperative billing yield resumes its next row and leaves expiry its own time', async () => {
  const h = harness();
  const source = rowsQuery([{ id: '01' }, { id: '02' }]);
  const seen = [];
  let expiryCalls = 0;
  const stages = [['invoices', async (_, results) => {
    for await (const row of renewalRows(source.factory, {
      control: results.__renewalControl, results,
    })) {
      seen.push(row.id);
      h.advance(30_000);
    }
  }]];
  const expiry = async () => { expiryCalls++; return complete(); };
  const first = await h.run({ stages, expiry });
  assert.equal(first.outcome, 'deferred');
  assert.equal(first.healthy, true);
  assert.equal(first.errors, 0);
  assert.equal(h.db.state.billing.a.cursor, '01');
  assert.equal(expiryCalls, 1);
  await h.run({ stages, expiry });
  assert.deepEqual(seen, ['01', '02']);
  assert.equal(expiryCalls, 2);
});

test('billing and expiry rotate after exhausted tenants rather than starving later tenants', async () => {
  const h = harness({ db: database({ tenants: [tenant('a'), tenant('b'), tenant('c')] }) });
  const billed = [];
  const expired = [];
  const options = {
    stages: [['invoices', async (id, results) => {
      billed.push(id);
      await results.__renewalControl.checkpoint('row');
      h.advance(30_000);
      throw new RenewalBudgetExceeded();
    }]],
    expiry: async (_, id) => {
      expired.push(id);
      h.advance(18_000);
      return { complete: false, examined: 1, enforced: 0, cursor: { afterId: id } };
    },
  };
  await h.run(options);
  await h.run(options);
  await h.run(options);
  assert.deepEqual(billed, ['a', 'b', 'c']);
  assert.deepEqual(expired, ['a', 'b', 'c']);
});

test('expiry cursor is checkpointed and passed into the next invocation', async () => {
  const h = harness({ at: '2026-09-18T03:00:00Z' });
  const cursor = { historyType: 'organisation', historyId: 'org-history', memberAfterId: 'member-100' };
  await h.run({ expiry: async (_, id, results, now, control) => {
    assert.equal(control.cursor, null);
    await control.checkpoint(cursor);
    return { complete: false, examined: 1, enforced: 1, cursor };
  } });
  await h.run({ expiry: async (_, id, results, now, control) => {
    assert.deepEqual(control.cursor, cursor);
    return complete();
  } });
  assert.equal(h.db.state.expiry.a.cursor, null);
  assert.ok(h.db.state.expiry.a.completedAt);
});

test('repeated no-progress expiry deferrals become unhealthy stalled outcomes', async () => {
  const h = harness();
  const expiry = async () => ({ complete: false, examined: 0, enforced: 0, cursor: null });
  assert.equal((await h.run({ expiry })).outcome, 'deferred');
  assert.equal((await h.run({ expiry })).outcome, 'deferred');
  const third = await h.run({ expiry });
  assert.equal(third.outcome, 'stalled');
  assert.equal(third.healthy, false);
  assert.equal(third.errors, 0);
  assert.equal((await h.run()).outcome, 'completed');
  assert.equal(h.db.state.expiry.a.noProgress, 0);
});

test('repeated no-progress billing or pause deferrals become stalled, and progress clears them', async t => {
  for (const stage of ['pause', 'billing']) {
    await t.test(stage, async () => {
      const h = harness();
      const defer = async () => { throw new RenewalBudgetExceeded(); };
      const options = stage === 'pause' ? { pause: defer } : { stages: [['invoices', defer]] };
      assert.equal((await h.run(options)).outcome, 'deferred');
      assert.equal((await h.run(options)).outcome, 'deferred');
      const stalled = await h.run(options);
      assert.equal(stalled.outcome, 'stalled');
      assert.equal(stalled.healthy, false);
      assert.equal(stalled.errors, 0);
      assert.equal((await h.run()).outcome, 'completed');
    });
  }
});

test('busy worker returns no heartbeat and performs no writes or effects', async () => {
  const h = harness({ db: database({ busy: true }) });
  const result = await h.run({
    pause: async () => assert.fail('Pause ran without lease'),
    expiry: async () => assert.fail('Expiry ran without lease'),
    stages: [['billing', async () => assert.fail('Billing ran without lease')]],
  });
  assert.equal(result.outcome, 'busy');
  assert.equal(result.heartbeat, false);
  assert.equal(result.healthy, false);
  assert.deepEqual(h.db.writes, []);
});

test('stage and database errors are unhealthy, including fulfilled Supabase error results', async t => {
  const failure = { message: 'isolated deliberate failure' };
  for (const kind of ['claim', 'discovery', 'save', 'log', 'release', 'pause', 'billing', 'expiry']) {
    await t.test(kind, async () => {
      const dbOptions = {};
      if (['claim', 'discovery', 'save', 'log', 'release'].includes(kind)) dbOptions[`${kind}Error`] = failure;
      const h = harness({ db: database(dbOptions) });
      const explode = async () => { throw new Error(failure.message); };
      const options = kind === 'pause' ? { pause: explode }
        : kind === 'billing' ? { stages: [['invoices', explode]] }
          : kind === 'expiry' ? { expiry: explode } : {};
      const result = await h.run(options);
      assert.equal(result.outcome, 'failed');
      assert.equal(result.healthy, false);
      assert.equal(result.heartbeat, true);
      assert.ok(result.errors > 0);
      assert.ok(result.details.some(detail => detail.status === 'error' && /failure/.test(detail.error)));
    });
  }
});

test('one tenant expiry failure does not prevent later tenants being examined', async () => {
  const h = harness({ db: database({ tenants: [tenant('a'), tenant('b')] }) });
  const seen = [];
  const result = await h.run({ expiry: async (_, id) => {
    seen.push(id);
    if (id === 'a') throw new Error('first tenant failed');
    return complete();
  } });
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(result.healthy, false);
  assert.ok(h.db.state.expiry.b.completedAt);
});

test('discovery continues until empty even below requested page size and above 1000 tenants', async () => {
  const tenants = Array.from({ length: 1_203 }, (_, i) => tenant(String(i).padStart(4, '0'), 23));
  const h = harness({ db: database({ tenants, cap: 73 }) });
  const seen = [];
  await h.run({ expiry: async (_, id) => { seen.push(id); return complete(); } });
  assert.equal(seen.length, tenants.length);
  assert.equal(h.db.pages.length, 18);
  assert.deepEqual(h.db.pages.at(-1), [1_203, 1_402]);
  const logs = h.db.writes.filter(write => write.type === 'log');
  assert.equal(logs.length, 7, 'Finalization uses batches, not a query per tenant');
  assert.equal(logs.flatMap(write => write.row).length, tenants.length);
});

test('slow discovery checkpoints pagination and resumes while already-known tenants still run', async () => {
  let h;
  const db = database({
    tenants: [tenant('a'), tenant('b'), tenant('c')], cap: 1,
    onRead: async () => { h.advance(3_000); },
  });
  h = harness({ db });
  const seen = [];
  const options = { expiry: async (_, id) => { seen.push(id); return complete(); } };
  const first = await h.run(options);
  assert.equal(first.outcome, 'deferred');
  assert.equal(db.state.discoveryOffset, 1);
  assert.deepEqual(seen, ['a']);
  await h.run(options);
  assert.equal(db.state.discoveryOffset, 2);
  assert.deepEqual(seen, ['a', 'b', 'a']);
  await h.run(options);
  assert.equal(db.state.discoveryOffset, 3);
  await h.run(options);
  assert.equal(db.state.discoveryOffset, 0);
  assert.deepEqual(Object.keys(db.state.tenants), ['a', 'b', 'c']);
});

test('finalization stops starting logging batches when its reserve is exhausted and reports failure', async () => {
  let h;
  let logWrites = 0;
  const db = database({ tenants: Array.from({ length: 401 }, (_, i) => tenant(String(i), 23)) });
  const originalFrom = db.from;
  db.from = table => {
    const query = originalFrom(table);
    return { async insert(rows) {
      logWrites++;
      h.advance(54_000);
      return query.insert(rows);
    } };
  };
  h = harness({ db });
  const result = await h.run();
  assert.equal(logWrites, 1);
  assert.equal(result.healthy, false);
  assert.match(result.details.find(detail => detail.stage === 'completion-log').error, /201 tenant logs/);
  assert.equal(db.writes.at(-1).p_release, true);
});

test('read deadline aborts and awaits the actual read; mutation transports are never abandoned', async () => {
  let settled = false;
  let aborts = 0;
  let writes = 0;
  let signal;
  const db = { from() {
    let writing = false;
    return {
      select() { return this; }, eq() { return this; },
      update() { writing = true; return this; },
      abortSignal(value) { signal = value; return this; },
      then(resolve, reject) {
        if (writing) {
          writes++;
          return Promise.resolve({ data: [{ id: 'row' }], error: null }).then(resolve, reject);
        }
        return new Promise(done => {
          signal.addEventListener('abort', () => {
            aborts++;
            // Transport settlement occurs asynchronously after cancellation.
            setImmediate(() => {
              settled = true;
              done({ data: null, error: { message: 'AbortError: read deadline' } });
            });
          }, { once: true });
        }).then(resolve, reject);
      },
    };
  } };
  const bounded = withRenewalReadDeadline(db, { deadline: Date.now() + 1_000, timeoutMs: 5 });
  const read = await bounded.from('history').select('*').eq('tenant_id', 'tenant');
  assert.equal(settled, true);
  assert.equal(aborts, 1);
  assert.match(read.error.message, /deadline/);
  signal = undefined;
  await bounded.from('history').update({ status: 'expired' }).eq('id', 'row').select('id');
  assert.equal(writes, 1);
  assert.equal(signal, undefined, 'Write transport must not receive a read abort signal');
});

test('runner awaits every effect and finalization write before resolving', async () => {
  let pending = 0;
  const delayed = async () => {
    pending++;
    await new Promise(resolve => setImmediate(resolve));
    pending--;
  };
  const h = harness({ db: database({ onWrite: delayed }) });
  await h.run({
    pause: delayed,
    stages: [['billing', delayed]],
    expiry: async () => { await delayed(); return complete(); },
  });
  assert.equal(pending, 0);
  const writes = h.db.writes.length;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.db.writes.length, writes);
  assert.equal(h.db.writes.at(-1).p_release, true);
});

test('outcome classifier does not hide errors behind successful budget deferral', () => {
  assert.equal(renewalOutcome({ errors: 0, deferred: 1, details: [] }), 'deferred');
  assert.equal(renewalOutcome({ errors: 0, deferred: 1, details: [{ error: 'stage failed' }] }), 'failed');
  assert.equal(renewalOutcome({ errors: 0, details: [{ status: 'error' }] }), 'failed');
});

test('row iterator pages over server caps, checkpoints only consumed rows, and handles custom keys', async () => {
  const rows = Array.from({ length: 1_107 }, (_, i) => ({ member_id: String(i).padStart(4, '0') }));
  const source = rowsQuery(rows, 37);
  const checkpoints = [];
  const seen = [];
  for await (const row of renewalRows(source.factory, {
    key: 'member_id', control: { cursor: '0001', shouldContinue: () => true,
      checkpoint: async cursor => { checkpoints.push(cursor); } },
  })) seen.push(row.member_id);
  assert.equal(seen.length, 1_105);
  assert.deepEqual(seen, checkpoints);
  assert.equal(seen[0], '0002');
  assert.equal(seen.at(-1), '1106');
  assert.equal(source.calls.at(-1), '1106');
});

test('row iterator stops before queries and effects when its budget has expired', async () => {
  let queries = 0;
  const control = { shouldContinue: () => false, checkpoint: async () => assert.fail('Unexpected checkpoint') };
  assert.throws(() => assertRenewalBudget(control), { code: 'RENEWAL_BUDGET_EXHAUSTED' });
  await assert.rejects(async () => {
    for await (const row of renewalRows(() => { queries++; }, { control })) assert.fail(row);
  }, { code: 'RENEWAL_BUDGET_EXHAUSTED' });
  assert.equal(queries, 0);
});

test('row iterator surfaces checkpoint and query failures; legacy schema tolerance is explicit', async () => {
  const source = rowsQuery([{ id: 'one' }]);
  await assert.rejects(async () => {
    for await (const row of renewalRows(source.factory, {
      control: { shouldContinue: () => true, checkpoint: async () => { throw new Error('checkpoint failed'); } },
    })) assert.equal(row.id, 'one');
  }, /checkpoint failed/);
  const factory = () => ({
    order() { return this; }, limit() { return this; },
    then(resolve) { return Promise.resolve({ error: { code: '42P01', message: 'missing table' } }).then(resolve); },
  });
  await assert.rejects(async () => {
    for await (const row of renewalRows(factory)) assert.fail(row);
  }, /missing table/);
  for await (const row of renewalRows(factory, { missingSchema: true })) assert.fail(row);
});