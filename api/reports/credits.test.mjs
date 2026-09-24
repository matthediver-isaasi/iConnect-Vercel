import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectCredits, attachReportCredits } from './_credits.js';
import { captureCancellationCredits, persistBookingCreditEvidence, prepareCancellationCredits, currencyFactor } from '../_lib/bookingCreditEvidence.js';
import { reconcileBookingCredits } from '../_lib/bookingCreditReconciliation.js';
import { handleReconcileBookingCredits } from './reconcile-booking-credits.js';

const a = '00000000-0000-0000-0000-000000000001';
const b = '00000000-0000-0000-0000-000000000002';
function database(tables = {}) {
  const calls = [];
  const db = {
    tables, calls,
    from(table) {
      const filters = [];
      const orders = [];
      let start = 0, end = Infinity;
      let update = null;
      const q = {
        select() { return q; },
        update(value) { update = value; return q; },
        eq(key, value) { calls.push([table, key, value]); filters.push(r => r[key] === value); return q; },
        in(key, values) { filters.push(r => values.includes(r[key])); return q; },
        contains(key, ids) { filters.push(r => ids.every(id => r[key]?.includes(id))); return q; },
        overlaps(key, ids) { filters.push(r => ids.some(id => r[key]?.includes(id))); return q; },
        order(key) { orders.push(key); return q; },
        limit(n) { end = n; return q; },
        range(from, to) { start = from; end = to + 1; return q; },
        async upsert(row, options) {
          if (db.failNextUpsert) {
            db.failNextUpsert = false;
            return { error: { message: 'simulated evidence write failure' } };
          }
          tables[table] ||= [];
          const prior = tables[table].find(r => r.tenant_id === row.tenant_id && r.booking_source === row.booking_source && r.evidence_key === row.evidence_key);
          if (prior) { if (!options.ignoreDuplicates) Object.assign(prior, row); }
          else tables[table].push({ id: `row-${tables[table].length}`, ...row });
          return { error: null };
        },
        then(resolve, reject) {
          if (update && db.failUpdate) return Promise.resolve({ error: { message: 'simulated error write failure' } }).then(resolve, reject);
          const data = (tables[table] || []).filter(r => filters.every(f => f(r))).sort((a, b) => {
            for (const key of orders) {
              const difference = String(a[key] ?? '').localeCompare(String(b[key] ?? ''));
              if (difference) return difference;
            }
            return 0;
          }).slice(start, end);
          if (update) data.forEach(row => Object.assign(row, update));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return db;
}
const row = (overrides = {}) => ({
  id: 'r1', tenant_id: 'tenant', booking_source: 'booking', evidence_key: 'op:refund',
  operation_key: 'op', leg: 'refund', provider: 'stripe', provider_id: 're_1',
  amount_minor: 1250, currency: 'GBP', status: 'confirmed', booking_ids: [a], detail: {}, ...overrides,
});
const note = overrides => row({ id: 'r2', leg: 'credit_note', provider: 'xero', provider_id: 'cn_1', ...overrides });
function pendingProcessor() {
  const source = readFileSync(new URL('../cron/reconcile-booking-credits.js', import.meta.url), 'utf8');
  const functionSource = source.slice(source.indexOf('export async function refreshPendingCredits'), source.indexOf('export default async function'));
  return new Function('persistBookingCreditEvidence', 'currencyFactor', `${functionSource.replace('export ', '')}; return refreshPendingCredits;`)(persistBookingCreditEvidence, currencyFactor);
}

test('partial and multiple genuine refund operations sum; matching note legs count once', () => {
  assert.equal(projectCredits([row(), note()]).amount, 12.5);
  assert.equal(projectCredits([row(), row({ operation_key: 'op2', amount_minor: 500 })]).amount, 17.5);
  assert.equal(projectCredits([row(), note({ amount_minor: 1300 })]).status, 'unavailable');
  assert.equal(projectCredits([row(), note({ operation_key: 'unlinked' })]).status, 'unavailable');
});
test('statuses and currencies never masquerade as confirmed zero', () => {
  for (const status of ['pending', 'failed', 'unavailable']) {
    const result = projectCredits([row({ status })]);
    assert.equal(result.status, status);
    assert.equal(result.amount, null);
  }
  assert.equal(projectCredits([row(), row({ operation_key: 'other', status: 'pending' })]).status, 'mixed');
  assert.equal(projectCredits([row(), row({ operation_key: 'other', currency: 'USD' })]).status, 'unavailable');
  assert.equal(projectCredits([], { historicalUnknown: true }).amount, null);
  assert.equal(projectCredits([]).amount, null);
  assert.equal(projectCredits([row({ amount_minor: 0 })]).amount, 0);
  assert.equal(projectCredits([row({ amount_minor: 500, currency: 'JPY' })]).amount, 500);
  assert.equal(projectCredits([row({ amount_minor: 1234, currency: 'KWD' })]).amount, 1.234);
  assert.equal(projectCredits([]).reasonCode, 'no_evidence');
  assert.equal(projectCredits([], { historicalUnknown: true }).reasonCode, 'ambiguous');
  assert.equal(projectCredits([row({ status: 'pending' })]).reasonCode, 'pending');
  assert.equal(projectCredits([row({ status: 'unavailable', detail: { reconciliationError: 'secret provider detail' } })]).reasonCode, 'lookup_failure');
  assert.doesNotMatch(projectCredits([row({ status: 'unavailable', detail: { reconciliationError: 'secret provider detail' } })]).error, /secret provider detail/);
});
test('projection preserves group consolidation and tenant/source isolation', async () => {
  const db = database({ booking_reversal_evidence: [
    row({ booking_ids: [a, b] }),
    row({ id: 'other', tenant_id: 'other-tenant', amount_minor: 999999 }),
    row({ id: 'complex', booking_source: 'complex_event_booking', amount_minor: 700 }),
  ] });
  const groups = [
    { bookingSource: 'booking', attendees: [{ id: a }, { id: b }] },
    { bookingSource: 'complex_event_booking', isComplexEvent: true, attendees: [{ id: a }] },
  ];
  await attachReportCredits({ db, tenantId: 'tenant', bookings: [
    { id: a, _report_booking_source: 'standard' }, { id: b, _report_booking_source: 'standard' },
    { id: a, _report_booking_source: 'complex' },
  ], groups });
  assert.equal(groups[0].credits.amount, 12.5);
  assert.equal(groups[1].credits.amount, 7);
  assert.equal(groups[0].credits.breakdown.length, 1);
  const partial = [{ bookingSource: 'booking', attendees: [{ id: a }] }];
  await attachReportCredits({ db, tenantId: 'tenant', bookings: [{ id: a }], groups: partial });
  assert.equal(partial[0].credits.status, 'unavailable');
});
test('cancelled legacy evidence is unavailable and storage failure does not block report', async () => {
  const groups = [{ attendees: [{ id: a }] }];
  await attachReportCredits({ db: database(), tenantId: 'tenant', bookings: [{ id: a, status: 'cancelled' }], groups });
  assert.equal(groups[0].credits.status, 'unavailable');
  await attachReportCredits({ db: { from() { throw new Error('migration absent'); } }, tenantId: 'tenant', bookings: [{ id: a }], groups });
  assert.equal(groups[0].credits.reasonCode, 'storage_failure');
  assert.match(groups[0].credits.error, /temporarily unavailable/);
  assert.doesNotMatch(groups[0].credits.error, /migration absent/);
});

function responseCapture() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const authorizedHandlerDeps = overrides => ({
  db: {},
  loadTenantContext: async () => ({ tenantId: 'tenant-a', isAuthenticated: true, roleId: 'role' }),
  checkAdminAccess: async () => true,
  checkFeatureAccess: async () => true,
  reconcile: async () => ({ written: 0, nextCursor: null, unresolved: false }),
  ...overrides,
});

test('refresh requires the report-pinned tenant before reconciliation or provider reads', async () => {
  let reconciliations = 0;
  const reconcile = async () => { reconciliations++; return {}; };
  for (const [body, status, code] of [
    [{ source: 'booking', bookingIds: [a] }, 400, 'EXPECTED_TENANT_REQUIRED'],
    [{ expectedTenantId: 'tenant-b', source: 'booking', bookingIds: [a] }, 409, 'EXPECTED_TENANT_MISMATCH'],
  ]) {
    const res = responseCapture();
    await handleReconcileBookingCredits({ method: 'POST', body }, res, authorizedHandlerDeps({ reconcile }));
    assert.equal(res.statusCode, status);
    assert.equal(res.body.code, code);
  }
  assert.equal(reconciliations, 0);
});

test('authorized registration report pins the refresh tenant contract', () => {
  const source = readFileSync(new URL('./event-registration-report.js', import.meta.url), 'utf8');
  assert.match(source, /return res\.status\(200\)\.json\(\{\s*tenantId,\s*canRefreshCredits: true,/);
});

test('refresh preserves report authorization and returns the pinned tenant', async () => {
  for (const [context, admin, feature, expected] of [
    [{ tenantId: null, isAuthenticated: false }, true, true, 401],
    [{ tenantId: 'tenant-a', isAuthenticated: true, tenantMismatch: true }, true, true, 409],
    [{ tenantId: 'tenant-a', isAuthenticated: true, roleId: 'role' }, false, true, 403],
    [{ tenantId: 'tenant-a', isAuthenticated: true, roleId: 'role' }, true, false, 403],
  ]) {
    const res = responseCapture();
    await handleReconcileBookingCredits(
      { method: 'POST', body: { expectedTenantId: 'tenant-a' } },
      res,
      authorizedHandlerDeps({
        loadTenantContext: async () => context,
        checkAdminAccess: async () => admin,
        checkFeatureAccess: async () => feature,
      }),
    );
    assert.equal(res.statusCode, expected);
  }
  const res = responseCapture();
  await handleReconcileBookingCredits(
    { method: 'POST', body: { expectedTenantId: 'tenant-a', source: 'booking', bookingIds: [a] } },
    res,
    authorizedHandlerDeps(),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.tenantId, 'tenant-a');
});

test('refresh routes read-only provider lookups and never exposes raw provider errors', async () => {
  const calls = [];
  const routeRes = responseCapture();
  await handleReconcileBookingCredits(
    { method: 'POST', body: { expectedTenantId: 'tenant-a', source: 'booking', bookingIds: [a] } },
    routeRes,
    authorizedHandlerDeps({
      loadStripeCredentials: async (tenantId, use) => {
        calls.push(['credentials', tenantId, use]);
        return { secret_key: 'not-returned', is_enabled: true };
      },
      createStripe: () => ({ refunds: { list: async args => { calls.push(['refund-list', args]); return { data: [] }; } } }),
      loadXeroCreditNote: async (tenantId, id) => { calls.push(['xero', tenantId, id]); return { providerId: id }; },
      loadQuickBooksCreditNote: async (tenantId, id) => { calls.push(['quickbooks', tenantId, id]); return { providerId: id }; },
      reconcile: async ({ readRefunds, readCreditNote }) => {
        await readRefunds('pi_1', 're_1');
        await readCreditNote('xero', 'cn_x');
        await readCreditNote('quickbooks', 'cn_q');
        return { written: 0 };
      },
    }),
  );
  assert.equal(routeRes.statusCode, 200);
  assert.deepEqual(calls.map(call => call[0]), ['credentials', 'refund-list', 'xero', 'quickbooks']);

  const failedRes = responseCapture();
  await handleReconcileBookingCredits(
    { method: 'POST', body: { expectedTenantId: 'tenant-a', source: 'booking', bookingIds: [a] } },
    failedRes,
    authorizedHandlerDeps({ reconcile: async () => { throw new Error('provider secret account abc-123 timed out'); } }),
  );
  assert.equal(failedRes.statusCode, 422);
  assert.equal(failedRes.body.code, 'CREDIT_LOOKUP_FAILURE');
  assert.doesNotMatch(failedRes.body.error, /abc-123|secret|timed out/);
});
test('capture is idempotent, uses actual minor amount, and preserves pending lifecycle', async () => {
  const db = database();
  const args = { db, tenantId: 'tenant', source: 'booking', operationKey: 'op', bookings: [{ id: a }] };
  await captureCancellationCredits({ ...args, results: { stripeRefund: { success: true, refundId: 're_1', amount: 100, amountMinor: 1250, currency: 'gbp', status: 'pending' } } });
  await captureCancellationCredits({ ...args, results: { stripeRefund: { success: true, refundId: 're_1', amount: 100, amountMinor: 1250, currency: 'gbp', status: 'succeeded' } } });
  assert.equal(db.tables.booking_reversal_evidence.length, 1);
  assert.equal(db.tables.booking_reversal_evidence[0].amount_minor, 1250);
  assert.equal(db.tables.booking_reversal_evidence[0].status, 'confirmed');
  await captureCancellationCredits({ ...args, results: { stripeRefund: { success: true, amount: 100, alreadyRefunded: true } } });
  assert.equal(db.tables.booking_reversal_evidence[0].status, 'confirmed', 'retry summaries must not erase actual evidence');
});
test('requested failure amounts, missing currency, and already-refunded summaries are not actual credits', async () => {
  for (const result of [
    { success: false, amount: 80, requiresManualRefund: true },
    { success: true, amount: 80, alreadyRefunded: true },
    { success: true, amount: 80, refundId: 're_1', status: 'succeeded' },
    { success: true, amount: null, currency: 'GBP', refundId: 're_1', status: 'succeeded' },
  ]) {
    const db = database();
    await captureCancellationCredits({ db, tenantId: 'tenant', source: 'booking', operationKey: 'op', bookings: [{ id: a }], results: { stripeRefund: result } });
    assert.equal(db.tables.booking_reversal_evidence[0].status, 'unavailable');
  }
});
test('every evidence persistence error surfaces; operation preflight is insert-only', async () => {
  await assert.rejects(persistBookingCreditEvidence({
    db: { from: () => ({ upsert: async () => ({ error: { message: 'write denied' } }) }) },
    tenantId: 'tenant', source: 'booking', bookings: [{ id: a }],
  }), /write denied/);
  const db = database({ booking_reversal_evidence: [row()] });
  await prepareCancellationCredits({
    db, tenantId: 'tenant', source: 'booking', operationKey: 'op',
    bookings: [{ id: a, payment_method: 'card', stripe_payment_intent_id: 'pi_1' }],
  });
  assert.equal(db.tables.booking_reversal_evidence[0].status, 'confirmed');
});
test('read-only reconciliation paginates refunds, refreshes known operation, and isolates tenant', async () => {
  const db = database({
    booking: [{ id: a, tenant_id: 'tenant', stripe_payment_intent_id: 'pi_1' }, { id: b, tenant_id: 'other', stripe_payment_intent_id: 'pi_1' }],
    booking_reversal_evidence: [row({ status: 'pending' })],
  });
  const calls = [];
  const args = {
    db, tenantId: 'tenant', source: 'booking', bookingIds: [a],
    readRefunds: async (pi, after) => {
      calls.push([pi, after]);
      return { data: [{ id: 're_1', amount: 1250, currency: 'gbp', status: 'succeeded', payment_intent: 'pi_1', metadata: { booking_id: a } }], has_more: true };
    },
    readCreditNote: async () => { throw new Error('unexpected accounting read'); },
  };
  const result = await reconcileBookingCredits(args);
  assert.deepEqual(result.nextCursor, { index: 0, after: 're_1' });
  assert.equal(db.tables.booking_reversal_evidence.length, 1);
  assert.equal(db.tables.booking_reversal_evidence[0].status, 'confirmed');
  assert.equal(db.tables.booking_reversal_evidence[0].operation_key, 'op');
  assert.deepEqual(db.tables.booking_reversal_evidence[0].booking_ids, [a]);
  await reconcileBookingCredits({ ...args, cursor: result.nextCursor });
  assert.deepEqual(calls[1], ['pi_1', 're_1']);
});
test('historical ambiguous group allocation stays unavailable, and repeated evidence deduplicates', async () => {
  const db = database({ complex_event_booking: [
    { id: a, tenant_id: 'tenant', stripe_payment_intent_id: 'pi_1' },
    { id: b, tenant_id: 'tenant', stripe_payment_intent_id: 'pi_1' },
  ] });
  const args = { db, tenantId: 'tenant', source: 'complex_event_booking', bookingIds: [a],
    readRefunds: async () => ({ data: [{ id: 're_1', amount: 1000, currency: 'gbp', status: 'succeeded', payment_intent: 'pi_1' }] }),
  };
  await reconcileBookingCredits(args);
  await reconcileBookingCredits(args);
  assert.equal(db.tables.booking_reversal_evidence.length, 1);
  assert.equal(db.tables.booking_reversal_evidence[0].status, 'unavailable');
});
test('credit note recovery reads tenant-authorized identity and retains consolidated allocation', async () => {
  const db = database({ booking: [a, b].map(id => ({ id, tenant_id: 'tenant', xero_credit_note_id: 'cn_1' })) });
  const result = await reconcileBookingCredits({
    db, tenantId: 'tenant', source: 'booking', bookingIds: [a, b],
    readCreditNote: async (provider, id) => {
      assert.equal(provider, 'xero'); assert.equal(id, 'cn_1');
      return { providerId: id, amount: 50, currency: 'GBP', status: 'AUTHORISED' };
    },
  });
  assert.deepEqual(result.nextCursor, { index: 1 });
  assert.deepEqual(db.tables.booking_reversal_evidence[0].booking_ids, [a, b]);
});
test('reconciliation rejects unbounded work and foreign bookings before provider access', async () => {
  await assert.rejects(reconcileBookingCredits({ db: database(), tenantId: 'tenant', source: 'booking', bookingIds: Array(26).fill(a) }), /1–25/);
  await assert.rejects(reconcileBookingCredits({ db: database(), tenantId: 'tenant', source: 'booking', bookingIds: [a] }), /not found/);
});
test('reconciliation implementation has no financial create/update calls and migration protects access', () => {
  const source = readFileSync(new URL('../_lib/bookingCreditReconciliation.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /refunds\.create|createCreditNote|cancelBooking/);
  const migration = readFileSync(new URL('../../migrations/20260720_booking_reversal_evidence.sql', import.meta.url), 'utf8');
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL[\s\S]*FROM anon, authenticated/);
  assert.match(migration, /tenant_id, provider, leg, provider_id/);
});

test('bounded pending processor refreshes actual provider results without financial writes', async () => {
  const source = readFileSync(new URL('../cron/reconcile-booking-credits.js', import.meta.url), 'utf8');
  const functionSource = source.slice(source.indexOf('export async function refreshPendingCredits'), source.indexOf('export default async function'));
  const refresh = new Function('persistBookingCreditEvidence', 'currencyFactor', `${functionSource.replace('export ', '')}; return refreshPendingCredits;`)(persistBookingCreditEvidence, currencyFactor);
  const db = database({ booking_reversal_evidence: [row({ status: 'pending' })] });
  const result = await refresh({ db, readEvidence: async evidence => {
    assert.equal(evidence.tenant_id, 'tenant');
    return { providerId: 're_1', amountMinor: 400, currency: 'GBP', status: 'succeeded' };
  } });
  assert.equal(result[0].status, 'confirmed');
  assert.equal(db.tables.booking_reversal_evidence[0].amount_minor, 400);
  db.tables.booking_reversal_evidence[0].status = 'pending';
  await refresh({ db, readEvidence: async () => { throw new Error('provider temporarily unavailable'); } });
  assert.equal(db.tables.booking_reversal_evidence[0].status, 'pending');
  assert.match(db.tables.booking_reversal_evidence[0].detail.reconciliationError, /temporarily unavailable/);
  assert.match(source, /CRON_SECRET/);
  assert.doesNotMatch(source, /refunds\.create|createCreditNote|cancelBooking/);
});

test('pending queue rotates unresolved records and errors rather than starving later bookings', async () => {
  const refresh = pendingProcessor();
  const db = database({ booking_reversal_evidence: Array.from({ length: 12 }, (_, i) => row({
    id: `pending-${String(i).padStart(2, '0')}`, provider_id: `re_${i}`,
    evidence_key: `pending-${i}`, status: 'pending', updated_at: '2020-01-01T00:00:00.000Z',
  })) });
  const reads = [];
  const readEvidence = async evidence => {
    reads.push(evidence.provider_id);
    if (evidence.provider_id === 're_0') throw new Error('temporary provider failure');
    return { providerId: evidence.provider_id, amountMinor: 100, currency: 'GBP', status: 'pending' };
  };
  await refresh({ db, readEvidence });
  assert.equal(reads.length, 10);
  await refresh({ db, readEvidence, limit: 2 });
  assert.deepEqual(reads.slice(10), ['re_10', 're_11']);
});

test('pending write failure remains retryable without financial actions; error persistence failures surface', async () => {
  const refresh = pendingProcessor();
  const db = database({ booking_reversal_evidence: [row({ status: 'pending' })] });
  let reads = 0;
  const readEvidence = async () => {
    reads++;
    return { providerId: 're_1', amountMinor: 500, currency: 'GBP', status: 'succeeded' };
  };
  db.failNextUpsert = true;
  const failed = await refresh({ db, readEvidence });
  assert.match(failed[0].error, /write failure/);
  assert.equal(db.tables.booking_reversal_evidence[0].status, 'pending');
  await refresh({ db, readEvidence });
  assert.equal(reads, 2);
  assert.equal(db.tables.booking_reversal_evidence.length, 1);
  assert.equal(db.tables.booking_reversal_evidence[0].amount_minor, 500);
  db.tables.booking_reversal_evidence[0].status = 'pending';
  db.failUpdate = true;
  await assert.rejects(refresh({ db, readEvidence: async () => { throw new Error('provider down'); } }), /Failed to retain reconciliation error/);
});

test('capture and historical evidence write failures can be retried idempotently', async () => {
  const db = database({ booking: [{ id: a, tenant_id: 'tenant', stripe_payment_intent_id: 'pi_1' }] });
  const capture = {
    db, tenantId: 'tenant', source: 'booking', operationKey: 'op', bookings: [{ id: a }],
    results: { stripeRefund: { success: true, refundId: 're_1', amount: 5, amountMinor: 500, currency: 'GBP', status: 'succeeded' } },
  };
  db.failNextUpsert = true;
  await assert.rejects(captureCancellationCredits(capture), /write failure/);
  await captureCancellationCredits(capture);
  let reads = 0;
  const reconciliation = {
    db, tenantId: 'tenant', source: 'booking', bookingIds: [a],
    readRefunds: async () => {
      reads++;
      return { data: [{ id: 're_1', amount: 500, currency: 'GBP', status: 'succeeded', payment_intent: 'pi_1', metadata: { booking_id: a } }], has_more: false };
    },
  };
  db.failNextUpsert = true;
  await assert.rejects(reconcileBookingCredits(reconciliation), /write failure/);
  await reconcileBookingCredits(reconciliation);
  assert.equal(reads, 2);
  assert.equal(db.tables.booking_reversal_evidence.length, 1);
  assert.equal(db.tables.booking_reversal_evidence[0].operation_key, 'op');
});

test('refund cursor resumes remaining page and then advances to the next selected booking', async () => {
  const db = database({ booking: [
    { id: a, tenant_id: 'tenant', stripe_payment_intent_id: 'pi_1' },
    { id: b, tenant_id: 'tenant', stripe_payment_intent_id: 'pi_2' },
  ] });
  const calls = [];
  const args = { db, tenantId: 'tenant', source: 'booking', bookingIds: [a, b],
    readRefunds: async (pi, after) => {
      calls.push([pi, after]);
      return { data: [{ id: after ? 're_2' : pi === 'pi_2' ? 're_3' : 're_1', amount: 100, currency: 'GBP', status: 'succeeded', payment_intent: pi }], has_more: pi === 'pi_1' && !after };
    },
  };
  const first = await reconcileBookingCredits(args);
  const second = await reconcileBookingCredits({ ...args, cursor: first.nextCursor });
  assert.deepEqual(second.nextCursor, { index: 1 });
  const third = await reconcileBookingCredits({ ...args, cursor: second.nextCursor });
  assert.equal(third.nextCursor, null);
  assert.deepEqual(calls, [['pi_1', undefined], ['pi_1', 're_1'], ['pi_2', undefined]]);
});

test('pending reconciliation schedule is registered once', () => {
  const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.crons.filter(cron => cron.path === '/api/cron/reconcile-booking-credits'), [
    { path: '/api/cron/reconcile-booking-credits', schedule: '*/5 * * * *' },
  ]);
});

test('credit note recovery cursor advances through bounded note batches without rereading refunds', async () => {
  const evidence = Array.from({ length: 7 }, (_, i) => note({
    id: `note-${i}`, evidence_key: `note-${i}`, provider_id: `cn_${i}`,
  }));
  const db = database({
    booking: [{ id: a, tenant_id: 'tenant', stripe_payment_intent_id: 'pi_1' }],
    booking_reversal_evidence: evidence,
  });
  let refundReads = 0;
  const noteReads = [];
  const args = {
    db, tenantId: 'tenant', source: 'booking', bookingIds: [a],
    readRefunds: async () => { refundReads++; return { data: [], has_more: false }; },
    readCreditNote: async (_, id) => { noteReads.push(id); return { providerId: id, amount: 10, currency: 'GBP', status: 'AUTHORISED' }; },
  };
  const first = await reconcileBookingCredits(args);
  assert.deepEqual(first.nextCursor, { index: 0, noteIndex: 5 });
  const second = await reconcileBookingCredits({ ...args, cursor: first.nextCursor });
  assert.equal(second.nextCursor, null);
  assert.equal(refundReads, 1);
  assert.equal(noteReads.length, 7);
  assert.equal(new Set(noteReads).size, 7);
});

test('linked accounting note repairs unique preflight placeholder and retains refund overlap on retries', async () => {
  const bookings = [a, b].map(id => ({
    id, tenant_id: 'tenant', booking_group_reference: 'GROUP',
    xero_invoice_id: 'invoice-1', xero_credit_note_id: 'cn_1',
  }));
  const placeholder = note({
    evidence_key: 'op:credit_note', provider_id: null, amount_minor: null, currency: null,
    status: 'unavailable', payment_reference: 'invoice-1', booking_ids: [a, b],
    group_reference: 'GROUP', detail: { historical: false, awaitingProviderEvidence: true },
  });
  const db = database({
    booking: bookings,
    booking_reversal_evidence: [row({ booking_ids: [a, b] }), placeholder],
  });
  const args = { db, tenantId: 'tenant', source: 'booking', bookingIds: [a],
    readCreditNote: async () => ({ providerId: 'cn_1', amount: 12.5, currency: 'GBP', status: 'AUTHORISED' }),
  };
  db.failNextUpsert = true;
  await assert.rejects(reconcileBookingCredits(args), /write failure/);
  const result = await reconcileBookingCredits(args);
  assert.equal(result.unresolved, false);
  await reconcileBookingCredits(args);
  assert.equal(db.tables.booking_reversal_evidence.length, 2);
  const noteEvidence = db.tables.booking_reversal_evidence.find(r => r.leg === 'credit_note');
  assert.equal(noteEvidence.evidence_key, 'op:credit_note');
  assert.equal(noteEvidence.operation_key, 'op');
  assert.deepEqual(noteEvidence.booking_ids, [a, b]);
  assert.equal(noteEvidence.group_reference, 'GROUP');
  assert.equal(noteEvidence.detail.historical, false);
  assert.equal(projectCredits(db.tables.booking_reversal_evidence).amount, 12.5);
});

test('ambiguous linked-note preflight candidates are not guessed or cleared on retries', async () => {
  const db = database({
    booking: [{ id: a, tenant_id: 'tenant', xero_invoice_id: 'invoice-1', xero_credit_note_id: 'cn_1' }],
    booking_reversal_evidence: ['one', 'two'].map(op => note({
      id: op, operation_key: op, evidence_key: `${op}:credit_note`, provider_id: null,
      amount_minor: null, currency: null, status: 'unavailable', payment_reference: 'invoice-1',
    })),
  });
  const args = { db, tenantId: 'tenant', source: 'booking', bookingIds: [a],
    readCreditNote: async () => ({ providerId: 'cn_1', amount: 12.5, currency: 'GBP', status: 'AUTHORISED' }),
  };
  assert.equal((await reconcileBookingCredits(args)).unresolved, true);
  assert.equal((await reconcileBookingCredits(args)).unresolved, true);
  assert.equal(db.tables.booking_reversal_evidence.filter(r => !r.provider_id).length, 2);
  assert.equal(db.tables.booking_reversal_evidence.find(r => r.provider_id)?.status, 'unavailable');
});

test('terminal unresolved reflects persisted pending and ambiguous evidence from earlier provider pages', async () => {
  const db = database({ booking: [{ id: a, tenant_id: 'tenant', stripe_payment_intent_id: 'pi_1' }] });
  const args = { db, tenantId: 'tenant', source: 'booking', bookingIds: [a],
    readRefunds: async (_, after) => ({ data: [{
      id: after ? 're_second' : 're_first', amount: 100, currency: 'GBP',
      payment_intent: 'pi_1', status: after ? 'succeeded' : 'pending',
    }], has_more: !after }),
  };
  const first = await reconcileBookingCredits(args);
  assert.equal(first.unresolved, true);
  const last = await reconcileBookingCredits({ ...args, cursor: first.nextCursor });
  assert.equal(last.nextCursor, null);
  assert.equal(last.written, 1);
  assert.equal(last.unresolved, true);
  db.tables.booking_reversal_evidence[0].status = 'unavailable';
  assert.equal((await reconcileBookingCredits({ ...args, cursor: first.nextCursor })).unresolved, true);
});

test('terminal batch completion includes earlier selected bookings, not just the final booking', async () => {
  const db = database({
    booking: [a, b].map((id, i) => ({ id, tenant_id: 'tenant', stripe_payment_intent_id: `pi_${i}` })),
  });
  const args = { db, tenantId: 'tenant', source: 'booking', bookingIds: [a, b],
    readRefunds: async pi => ({ data: [{ id: pi === 'pi_0' ? 're_one' : 're_two', payment_intent: pi,
      amount: 100, currency: 'GBP', status: pi === 'pi_0' ? 'pending' : 'succeeded' }], has_more: false }),
  };
  const first = await reconcileBookingCredits(args);
  const last = await reconcileBookingCredits({ ...args, cursor: first.nextCursor });
  assert.equal(last.nextCursor, null);
  assert.equal(last.unresolved, true);
});