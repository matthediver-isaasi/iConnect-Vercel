import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectCredits, attachReportCredits } from './_credits.js';
import { handleReconcileBookingCredits } from './reconcile-booking-credits.js';
import { captureCancellationCredits, prepareCancellationCredits, persistBookingCreditEvidence, currencyFactor } from '../_lib/bookingCreditEvidence.js';

const row = (overrides = {}) => ({
  id: 'r1', tenant_id: 'tenant', booking_source: 'booking', evidence_key: 'op:refund',
  operation_key: 'op', leg: 'refund', provider: 'stripe', provider_id: 're_1',
  amount_minor: 1250, currency: 'GBP', status: 'confirmed', booking_ids: ['a'], detail: {}, ...overrides,
});
const note = overrides => row({ id: 'r2', leg: 'credit_note', provider: 'xero', provider_id: 'cn_1', ...overrides });

// Deliberately cap every page below the requested range.
function database(tables = {}, cap = 2) {
  const calls = [];
  const db = { tables, calls, from(table) {
    calls.push(table);
    assert.notEqual(table, 'booking_credit_verification', 'report must not read verification history');
    const filters = [];
    let start = 0, end = Infinity, update;
    const q = {
      select() { return q; },
      eq(k, v) { filters.push(r => r[k] === v); return q; },
      in(k, v) { filters.push(r => v.includes(r[k])); return q; },
      overlaps(k, v) { filters.push(r => v.some(id => r[k]?.includes(id))); return q; },
      order() { return q; },
      limit(n) { end = n; return q; },
      range(a, b) { start = a; end = b + 1; return q; },
      update(value) { update = value; return q; },
      async upsert(value, options) {
        if (db.failWrite) return { error: { message: 'write failed' } };
        const list = tables[table] ||= [];
        const prior = list.find(r => r.tenant_id === value.tenant_id && r.booking_source === value.booking_source && r.evidence_key === value.evidence_key);
        if (prior) { if (!options?.ignoreDuplicates) Object.assign(prior, value); }
        else list.push({ id: `row-${list.length}`, ...value });
        return { error: null };
      },
      then(resolve, reject) {
        if (db.failTable === table) return Promise.resolve({ error: { message: 'read failed' } }).then(resolve, reject);
        const data = (tables[table] || []).filter(r => filters.every(f => f(r))).slice(start, Math.min(end, start + cap));
        if (update) data.forEach(r => Object.assign(r, update));
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return q;
  } };
  return db;
}

test('local absence is zero regardless of obsolete provider coverage', () => {
  for (const reason_code of ['verified_empty', 'incomplete_coverage', 'lookup_failure', 'unsupported_route']) {
    assert.equal(projectCredits([], { verifications: [{ reason_code }] }).amount, 0);
  }
  assert.equal(projectCredits([]).reasonCode, 'no_recorded_credits');
});

test('successful partial operations sum, linked legs and duplicate instruments count once', () => {
  assert.equal(projectCredits([row(), note()]).amount, 12.5);
  assert.equal(projectCredits([row(), row()]).amount, 12.5);
  assert.equal(projectCredits([row(), row({ id: 'r3', operation_key: 'other', provider_id: 're_2', amount_minor: 500 })]).amount, 17.5);
  assert.equal(projectCredits([row(), note({ amount_minor: 1300 })]).reasonCode, 'ambiguous');
  assert.equal(projectCredits([row(), note({ operation_key: 'unlinked' })]).reasonCode, 'ambiguous');
});

test('pending and failed attempts neither count nor suppress successful amounts', () => {
  for (const status of ['pending', 'failed']) {
    const attempt = row({ id: 'attempt', operation_key: 'other', provider_id: 're_other', status, currency: 'USD', detail: { ambiguousAttribution: true } });
    assert.equal(projectCredits([attempt]).amount, 0);
    const result = projectCredits([row(), attempt]);
    assert.equal(result.amount, 12.5);
    assert.equal(result.breakdown[1].status, status);
    assert.equal(result.breakdown[1].amount, null);
  }
  assert.equal(projectCredits([row(), note({ status: 'unavailable', provider_id: null, amount_minor: null })]).amount, 12.5);
});

test('unknown local references, currencies, allocation and storage are not zero', () => {
  assert.equal(projectCredits([], { historicalUnknown: true }).reasonCode, 'amount_not_recorded');
  assert.equal(projectCredits([note({ amount_minor: null, status: 'unavailable' })]).reasonCode, 'amount_not_recorded');
  assert.equal(projectCredits([row(), note({ status: 'unavailable', amount_minor: null, operation_key: 'other' })]).amount, null);
  assert.equal(projectCredits([row()], { partialScope: true }).amount, null);
  assert.equal(projectCredits([row({ detail: { ambiguousAttribution: true } })]).amount, null);
  assert.equal(projectCredits([row(), row({ id: 'usd', provider_id: 're_usd', operation_key: 'usd', currency: 'USD' })]).amount, null);
  for (const amount_minor of [null, -1, 'bad', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(projectCredits([row({ amount_minor })]).amount, null);
  }
  assert.equal(projectCredits([row({ amount_minor: 500, currency: 'JPY' })]).amount, 500);
  assert.equal(projectCredits([row({ amount_minor: 1234, currency: 'KWD' })]).amount, 1.234);
});

test('provider-linked unavailable outcomes with recorded money cannot establish zero or a complete total', () => {
  const unresolved = note({ amount_minor: 6000, status: 'unavailable' });
  for (const rows of [[unresolved], [row(), unresolved]]) {
    const result = projectCredits(rows);
    assert.equal(result.amount, null);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reasonCode, 'unresolved_record');
  }
  // Known failed and pending operations retain the intentional exclusion rule.
  for (const status of ['pending', 'failed']) {
    assert.equal(projectCredits([{ ...unresolved, status }]).amount, 0);
    assert.equal(projectCredits([row(), { ...unresolved, status }]).amount, 12.5);
  }
});

test('consolidated local credits retain tenant/source isolation and legacy references on reload', async () => {
  const db = database({
    booking: [{ id: 'a', tenant_id: 'tenant', xero_credit_note_id: 'cn_1' }, { id: 'b', tenant_id: 'tenant', xero_credit_note_id: 'cn_1' }],
    booking_reversal_evidence: [
      note({ booking_ids: ['a', 'b'] }),
      row({ id: 'foreign', tenant_id: 'foreign', amount_minor: 999999 }),
      row({ id: 'complex', booking_source: 'complex_event_booking', amount_minor: 700 }),
    ],
  });
  const groups = [{ attendees: [{ id: 'a' }, { id: 'b' }] }, { bookingSource: 'complex_event_booking', attendees: [{ id: 'a' }] }];
  const bookings = [{ id: 'a' }, { id: 'b' }, { id: 'a', _report_booking_source: 'complex' }];
  for (let reload = 0; reload < 2; reload++) {
    await attachReportCredits({ db, tenantId: 'tenant', bookings, groups });
    assert.equal(groups[0].credits.amount, 12.5);
    assert.equal(groups[1].credits.amount, 7);
  }
  const partial = [{ attendees: [{ id: 'a' }] }];
  await attachReportCredits({ db, tenantId: 'tenant', bookings: [{ id: 'a' }], groups: partial });
  assert.equal(partial[0].credits.reasonCode, 'ambiguous');
  db.tables.booking_reversal_evidence = [];
  await attachReportCredits({ db, tenantId: 'tenant', bookings, groups });
  assert.equal(groups[0].credits.reasonCode, 'amount_not_recorded');
  db.tables.booking = [];
  await attachReportCredits({ db, tenantId: 'tenant', bookings: [{ id: 'a', status: 'cancelled' }], groups });
  assert.equal(groups[0].credits.amount, 0);
  for (const table of ['booking', 'booking_reversal_evidence']) {
    db.failTable = table;
    await attachReportCredits({ db, tenantId: 'tenant', bookings, groups });
    assert.equal(groups[0].credits.reasonCode, 'storage_failure');
  }
});

test('bounded ID batches and short-page pagination do not lose or multiply instruments', async () => {
  const bookings = Array.from({ length: 105 }, (_, i) => ({ id: `b${i}`, tenant_id: 'tenant' }));
  const db = database({ booking: bookings, booking_reversal_evidence: [
    ...bookings.map((b, i) => row({ id: `r${i}`, provider_id: `re_${i}`, operation_key: `op${i}`, booking_ids: [b.id], amount_minor: 100 })),
    row({ id: 'shared', provider_id: 're_shared', operation_key: 'shared', booking_ids: bookings.map(b => b.id), amount_minor: 500 }),
  ] });
  const groups = [{ attendees: bookings }];
  await attachReportCredits({ db, tenantId: 'tenant', bookings, groups });
  assert.equal(groups[0].credits.amount, 110);
  assert.equal(groups[0].credits.breakdown.length, 106);
});

test('retired report refresh rejects stale clients without provider or database calls', async () => {
  const res = { status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  await handleReconcileBookingCredits({ method: 'POST' }, res, new Proxy({}, { get() { throw Error('dependency accessed'); } }));
  assert.equal(res.code, 410);
  assert.equal(res.body.code, 'CREDIT_DISCOVERY_RETIRED');
  const report = readFileSync(new URL('../../client/src/pages/EventRegistrationReport.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(report, /BookingCreditRefresh|reconcile-booking-credits|canRefreshCredits/);
  const cron = readFileSync(new URL('../cron/reconcile-booking-credits.js', import.meta.url), 'utf8');
  assert.doesNotMatch(cron, /reconcileBookingCredits|refunds\.list|readXeroInvoiceCreditEvidence/);
});

test('financial capture preserves actual amounts, preflight identity and pending completion', async () => {
  const db = database();
  const args = { db, tenantId: 'tenant', source: 'booking', operationKey: 'op', bookings: [{ id: 'a', payment_method: 'card', stripe_payment_intent_id: 'pi_1' }] };
  await prepareCancellationCredits(args);
  await captureCancellationCredits({ ...args, results: { stripeRefund: { success: true, refundId: 're_1', amount: 100, amountMinor: 1250, currency: 'GBP', status: 'pending' } } });
  assert.equal(projectCredits(db.tables.booking_reversal_evidence).amount, 0);
  const source = readFileSync(new URL('../cron/reconcile-booking-credits.js', import.meta.url), 'utf8');
  const functionSource = source.slice(source.indexOf('export async function refreshPendingCredits'), source.indexOf('export default async function'));
  const refresh = new Function('persistBookingCreditEvidence', 'currencyFactor', `${functionSource.replace('export ', '')}; return refreshPendingCredits;`)(persistBookingCreditEvidence, currencyFactor);
  await refresh({ db, readEvidence: async () => ({ providerId: 're_1', amountMinor: 1250, currency: 'GBP', status: 'succeeded' }) });
  await prepareCancellationCredits(args);
  await captureCancellationCredits({ ...args, results: { stripeRefund: { success: true, amount: 100, alreadyRefunded: true } } });
  assert.equal(projectCredits(db.tables.booking_reversal_evidence).amount, 12.5);
  assert.equal(db.tables.booking_reversal_evidence.length, 1);
  db.failWrite = true;
  await assert.rejects(captureCancellationCredits({ ...args, results: { stripeRefund: { success: true, refundId: 're_1', amount: 100, amountMinor: 1250, currency: 'GBP', status: 'succeeded' } } }), /write failed/);
});
