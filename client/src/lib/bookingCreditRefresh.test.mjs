import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCreditRefreshSnapshot,
  createCreditRefreshSession,
  runCreditRefreshSession,
} from './bookingCreditRefresh.js';

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

test('snapshot deduplicates all filtered groups, splits mixed sources, batches at 25, and excludes unsupported bookings', () => {
  const standard = Array.from({ length: 27 }, (_, index) => ({ id: id(index + 1) }));
  const snapshot = buildCreditRefreshSnapshot([
    { bookingSource: 'booking', attendees: standard },
    { bookingSource: 'booking', attendees: [standard[0], standard[26]] },
    { bookingSource: 'complex_event_booking', attendees: [{ id: id(100) }] },
    {
      bookingSource: 'booking',
      isPublicInvoicePo: true,
      attendees: [{ id: id(200) }],
    },
    {
      bookingSource: 'booking',
      groupPayment: { paymentMethod: 'public_invoice_po' },
      attendees: [{ id: id(201) }],
    },
    { bookingSource: 'legacy', attendees: [{ id: id(300) }] },
  ], { tenantId: 'tenant-a', scopeKey: 'scope-a', filters: ['Status: Active only'] });

  assert.deepEqual(snapshot.tasks.map(task => [task.source, task.bookingIds.length]), [
    ['booking', 25],
    ['booking', 2],
    ['complex_event_booking', 1],
  ]);
  assert.deepEqual(snapshot.counts, {
    booking: 27,
    complex_event_booking: 1,
    total: 28,
    excludedPublicInvoicePo: 2,
    excludedUnsupported: 1,
  });
  assert.deepEqual(snapshot.filters, ['Status: Active only']);
});

test('orchestrator sends tenant, source, fixed batch and cursor while progress counts completed bookings', async () => {
  const snapshot = buildCreditRefreshSnapshot([
    { bookingSource: 'booking', attendees: [{ id: id(1) }, { id: id(2) }] },
    { bookingSource: 'complex_event_booking', attendees: [{ id: id(3) }] },
  ], { tenantId: 'tenant-a', scopeKey: 'scope-a' });
  const session = createCreditRefreshSession(snapshot);
  const calls = [];
  const progress = [];
  const responses = [
    { tenantId: 'tenant-a', written: 99, nextCursor: { index: 0, after: 're_page' } },
    { tenantId: 'tenant-a', written: 0, nextCursor: { index: 1 } },
    { tenantId: 'tenant-a', written: 50, nextCursor: null },
    { tenantId: 'tenant-a', written: 0, nextCursor: null },
  ];

  await runCreditRefreshSession(session, {
    request: async body => {
      calls.push(body);
      return responses.shift();
    },
    onProgress: state => progress.push(state.completed),
  });

  assert.equal(session.status, 'complete');
  assert.equal(session.completed, 3);
  assert.deepEqual(progress, [0, 1, 2, 3]);
  assert.deepEqual(calls.map(call => call.cursor), [
    {},
    { index: 0, after: 're_page' },
    { index: 1 },
    {},
  ]);
  assert.ok(calls.every(call => call.expectedTenantId === 'tenant-a'));
  assert.deepEqual(calls.map(call => call.source), [
    'booking', 'booking', 'booking', 'complex_event_booking',
  ]);
  assert.strictEqual(calls[0].bookingIds, calls[1].bookingIds, 'provider pages use the same immutable batch');
});

test('stop is honored between requests and the same session can resume', async () => {
  const snapshot = buildCreditRefreshSnapshot([
    { bookingSource: 'booking', attendees: [{ id: id(1) }, { id: id(2) }] },
  ], { tenantId: 'tenant-a' });
  const session = createCreditRefreshSession(snapshot);
  let stop = false;
  const cursors = [];
  await runCreditRefreshSession(session, {
    request: async body => {
      cursors.push(body.cursor);
      stop = true;
      return { tenantId: 'tenant-a', nextCursor: { index: 1 } };
    },
    shouldStop: () => stop,
  });
  assert.equal(session.status, 'stopped');
  assert.equal(session.completed, 1);

  stop = false;
  await runCreditRefreshSession(session, {
    request: async body => {
      cursors.push(body.cursor);
      return { tenantId: 'tenant-a', nextCursor: null };
    },
    shouldStop: () => stop,
  });
  assert.equal(session.status, 'complete');
  assert.deepEqual(cursors, [{}, { index: 1 }]);
});

test('a failed request preserves its cursor for a safe retry of the same snapshot', async () => {
  const snapshot = buildCreditRefreshSnapshot([
    { bookingSource: 'booking', attendees: [{ id: id(1) }, { id: id(2) }] },
  ], { tenantId: 'tenant-a', scopeKey: 'pinned' });
  const session = createCreditRefreshSession(snapshot);
  const calls = [];
  await assert.rejects(
    runCreditRefreshSession(session, {
      request: async body => {
        calls.push(body);
        throw new Error('provider unavailable');
      },
    }),
    /provider unavailable/,
  );
  assert.equal(session.status, 'error');
  assert.equal(session.cursor, null);
  assert.equal(session.completed, 0);

  await runCreditRefreshSession(session, {
    request: async body => {
      calls.push(body);
      return { tenantId: 'tenant-a', nextCursor: null };
    },
  });
  assert.equal(session.status, 'complete');
  assert.deepEqual(calls.map(call => call.cursor), [{}, {}]);
  assert.ok(calls.every(call => call.expectedTenantId === 'tenant-a'));
  assert.ok(calls.every(call => call.bookingIds.join() === calls[0].bookingIds.join()));
});

test('cyclic cursors persist across resumes and request loops pause at a per-run budget', async () => {
  const makeSession = () => createCreditRefreshSession(buildCreditRefreshSnapshot([
    { bookingSource: 'booking', attendees: [{ id: id(1) }] },
  ], { tenantId: 'tenant-a' }));

  const cyclic = makeSession();
  await assert.rejects(
    runCreditRefreshSession(cyclic, {
      request: async () => ({ tenantId: 'tenant-a', nextCursor: { index: 0, after: 're_same' } }),
    }),
    /cyclic cursor/,
  );
  assert.equal(cyclic.requests, 2);
  await assert.rejects(
    runCreditRefreshSession(cyclic, {
      request: async () => assert.fail('a consumed cyclic cursor must not be requested again'),
    }),
    /cyclic cursor/,
  );
  assert.equal(cyclic.requests, 2);

  const bounded = makeSession();
  let page = 0;
  await runCreditRefreshSession(bounded, {
    request: async () => ({ tenantId: 'tenant-a', nextCursor: { index: 0, after: `re_${++page}` } }),
    maxRequests: 3,
  });
  assert.equal(bounded.status, 'stopped');
  assert.equal(bounded.stopReason, 'request_budget');
  assert.equal(bounded.requests, 3);
});

test('each Resume gets a fresh request window and reaches completion without replay', async () => {
  const session = createCreditRefreshSession(buildCreditRefreshSnapshot([
    { bookingSource: 'booking', attendees: [{ id: id(1) }] },
  ], { tenantId: 'tenant-a' }));
  const requested = [];
  const nextByCursor = new Map([
    ['{}', { index: 0, after: 're_a' }],
    [JSON.stringify({ index: 0, after: 're_a' }), { index: 0, after: 're_b' }],
    [JSON.stringify({ index: 0, after: 're_b' }), { index: 0, after: 're_c' }],
    [JSON.stringify({ index: 0, after: 're_c' }), { index: 0, after: 're_d' }],
    [JSON.stringify({ index: 0, after: 're_d' }), null],
  ]);
  const request = async body => {
    const key = JSON.stringify(body.cursor);
    requested.push(key);
    assert.ok(nextByCursor.has(key), `unexpected or replayed cursor ${key}`);
    const nextCursor = nextByCursor.get(key);
    nextByCursor.delete(key);
    return { tenantId: 'tenant-a', nextCursor };
  };

  await runCreditRefreshSession(session, { request, maxRequests: 2 });
  assert.equal(session.status, 'stopped');
  assert.equal(session.stopReason, 'request_budget');
  assert.equal(session.requests, 2);
  await runCreditRefreshSession(session, { request, maxRequests: 2 });
  assert.equal(session.status, 'stopped');
  assert.equal(session.stopReason, 'request_budget');
  assert.equal(session.requests, 4);
  await runCreditRefreshSession(session, { request, maxRequests: 2 });

  assert.equal(session.status, 'complete');
  assert.equal(session.stopReason, null);
  assert.equal(session.requests, 5, 'cumulative requests remain diagnostic');
  assert.equal(session.completed, 1);
  assert.equal(new Set(requested).size, requested.length);
  assert.equal(nextByCursor.size, 0);
});

test('responses require the pinned tenant and an explicit valid monotonic cursor', async () => {
  const makeSession = () => createCreditRefreshSession(buildCreditRefreshSnapshot([
    { bookingSource: 'booking', attendees: [{ id: id(1) }, { id: id(2) }] },
  ], { tenantId: 'tenant-a' }));

  await assert.rejects(
    runCreditRefreshSession(makeSession(), {
      request: async () => ({ tenantId: 'tenant-b', nextCursor: null }),
    }),
    /tenant context changed/,
  );
  await assert.rejects(
    runCreditRefreshSession(makeSession(), {
      request: async () => ({ tenantId: 'tenant-a' }),
    }),
    /did not include a continuation cursor/,
  );
  await assert.rejects(
    runCreditRefreshSession(makeSession(), {
      request: async () => ({ tenantId: 'tenant-a', nextCursor: { index: 2 } }),
    }),
    /invalid continuation cursor/,
  );

  const regressing = makeSession();
  regressing.cursor = { index: 1 };
  regressing.completed = 1;
  await assert.rejects(
    runCreditRefreshSession(regressing, {
      request: async () => ({ tenantId: 'tenant-a', nextCursor: { index: 0, after: 're_back' } }),
    }),
    /non-monotonic continuation cursor/,
  );
  assert.deepEqual(regressing.cursor, { index: 1 }, 'invalid responses must not advance retry state');
});