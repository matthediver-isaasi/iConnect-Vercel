import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSpeakerAwardEventQueue,
  checkCronAuthorization,
  collectSpeakerIds,
  createGrantSpeakerAwardsHandler,
  loadEligibleSpeakerAwardEvents,
} from './grant-speaker-awards.js';

function childDb(rows, error = null) {
  const log = [];
  return {
    log,
    from(table) {
      const filters = {};
      const chain = {
        select() { return chain; },
        eq(col, value) { filters[col] = value; return chain; },
        then(resolve) { log.push({ table, filters }); resolve({ data: rows, error }); },
      };
      return chain;
    },
  };
}

test('simple events merge and deduplicate event-level and training-agenda speakers', async () => {
  const db = childDb([{ speaker_ids: ['s2', 's3'] }, { speaker_ids: ['s3', 's4'] }, { speaker_ids: null }]);
  assert.deepEqual(await collectSpeakerIds(db, 'event', { id: 'e1', tenant_id: 't1', speaker_ids: ['s1', 's2', 's1'] }), ['s1', 's2', 's3', 's4']);
  assert.deepEqual(db.log[0], { table: 'event_agenda_item', filters: { event_id: 'e1', tenant_id: 't1' } });
});

test('complex events collect and deduplicate session-only speakers', async () => {
  const db = childDb([{ speaker_ids: ['s1', 's2'] }, { speaker_ids: ['s2', 's3'] }]);
  assert.deepEqual(await collectSpeakerIds(db, 'complex_event', { id: 'c1', tenant_id: 't1' }), ['s1', 's2', 's3']);
  assert.deepEqual(db.log[0], { table: 'complex_event_session', filters: { complex_event_id: 'c1', tenant_id: 't1' } });
});

test('child speaker query failures remain retryable errors', async () => {
  await assert.rejects(
    collectSpeakerIds(childDb([], { message: 'timeout' }), 'event', { id: 'e1', tenant_id: 't1', speaker_ids: [] }),
    /agenda fetch failed: timeout/,
  );
});

test('cron authentication fails closed and accepts only the exact bearer secret', () => {
  assert.deepEqual(checkCronAuthorization({}, ''), { status: 500, error: 'Cron secret not configured' });
  assert.deepEqual(checkCronAuthorization({}, 'secret'), { status: 401, error: 'Unauthorized' });
  assert.deepEqual(checkCronAuthorization({ authorization: 'Bearer wrong' }, 'secret'), { status: 401, error: 'Unauthorized' });
  assert.equal(checkCronAuthorization({ authorization: 'Bearer secret' }, 'secret'), null);
});

test('scheduled queue excludes complex drafts, orders deterministically and applies one global cap', () => {
  const simple = Array.from({ length: 15 }, (_, i) => ({
    id: `s${String(i).padStart(2, '0')}`,
    start_date: `2026-09-${String(i + 10).padStart(2, '0')}T09:00:00Z`,
    event_state: i === 0 ? 'draft' : 'active',
  }));
  const complex = Array.from({ length: 15 }, (_, i) => ({
    id: `c${String(i).padStart(2, '0')}`,
    start_date: `2026-09-${String(i + 1).padStart(2, '0')}T09:00:00Z`,
    event_state: i === 0 ? 'draft' : 'active',
  }));
  const queue = buildSpeakerAwardEventQueue(simple, complex);
  assert.equal(queue.length, 20);
  assert.equal(queue.some(item => item.event.id === 'c00'), false);
  assert.equal(queue.some(item => item.event.id === 's00'), false);
  assert.deepEqual(queue.slice(0, 2).map(item => item.event.id), ['c01', 'c02']);
  assert.equal(queue.at(-1).event.id, 's06');
});

test('selection filters draft states before per-table limits to prevent queue starvation', async () => {
  const log = [];
  const db = {
    from(table) {
      const chain = {};
      for (const method of ['select', 'not', 'is', 'eq', 'or', 'lte', 'order', 'limit']) {
        chain[method] = (...args) => { log.push({ table, method, args }); return chain; };
      }
      chain.then = resolve => resolve({ data: [], error: null });
      return chain;
    },
  };
  assert.deepEqual(await loadEligibleSpeakerAwardEvents(db, '2026-09-08T10:00:00Z'), []);
  for (const table of ['event', 'complex_event']) {
    const calls = log.filter(entry => entry.table === table);
    const draftFilter = calls.findIndex(entry =>
      entry.method === 'or' && entry.args[0] === 'event_state.is.null,event_state.neq.draft'
    );
    const limit = calls.findIndex(entry => entry.method === 'limit');
    assert.ok(draftFilter >= 0 && draftFilter < limit, `${table} filters drafts before limiting`);
  }
});

test('cron grants an eligible event, stamps completion, and always hands off to notification sweep', async () => {
  const event = {
    id: 'e1', tenant_id: 't1', title: 'Summit', start_date: '2026-09-08T09:00:00Z',
    event_state: 'active', status: 'published', speaker_ids: ['s1'],
    speaker_award_config: { enabled: true, default: { badge_id: 'b1' } },
  };
  const updates = [];
  const db = {
    from(table) {
      const filters = {};
      let mode = 'select';
      let values = null;
      const chain = {
        select() { return chain; },
        not() { return chain; },
        is(col, value) { filters[`${col} is`] = value; return chain; },
        eq(col, value) { filters[col] = value; return chain; },
        in(col, value) { filters[`${col} in`] = value; return chain; },
        or() { return chain; },
        lte() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        update(input) { mode = 'update'; values = input; return chain; },
        then(resolve) {
          if (mode === 'update') {
            updates.push({ table, filters, values });
            return resolve({ data: [], error: null });
          }
          if (table === 'event') return resolve({ data: [event], error: null });
          if (table === 'complex_event') return resolve({ data: [], error: null });
          if (table === 'event_agenda_item') return resolve({ data: [], error: null });
          if (table === 'speaker') return resolve({ data: [{ id: 's1', member_id: 'm1' }], error: null });
          if (table === 'speaker_award_grant') return resolve({ data: [], count: 0, error: null });
          return resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };
  const grantCalls = [];
  const notificationCalls = [];
  const handler = createGrantSpeakerAwardsHandler({
    db,
    getCronSecret: () => 'secret',
    now: () => new Date('2026-09-08T10:00:00Z'),
    grantAwards: async (_db, input) => {
      grantCalls.push(input);
      return [{ speaker_id: 's1', status: 'granted' }];
    },
    sendNotifications: async input => {
      notificationCalls.push(input);
      return { notified: 1, failed: 0 };
    },
  });
  const res = {
    code: 0, body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ headers: { authorization: 'Bearer secret' } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.processed, 1);
  assert.equal(res.body.granted, 1);
  assert.equal(res.body.notified, 1);
  assert.equal(grantCalls.length, 1);
  assert.equal(notificationCalls.length, 1);
  assert.ok(updates.some(update =>
    update.table === 'event'
    && update.filters.id === 'e1'
    && update.filters.tenant_id === 't1'
    && update.values.speaker_awards_granted_at
  ));
});