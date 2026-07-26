// Unit tests for the Task #3117 monthly voucher rollup math (pure functions
// only — no DB). Run: node --test api/_lib/voucherMonthlyRollup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monthKey,
  prevMonth,
  nextMonth,
  monthEndIso,
  isValidMonth,
  deriveOriginalValue,
  allocationDate,
  buildMovements,
  rollupMonth,
} from './voucherMonthlyRollup.js';

const ORG = 'org-1';
const ORG2 = 'org-2';

function v(id, value, alloc, org = ORG, extra = {}) {
  return { id, organization_id: org, value, valid_from: alloc, ...extra };
}
function tx(voucherId, type, amount, createdAt, extra = {}) {
  return { voucher_id: voucherId, organization_id: extra.org ?? ORG, type, amount, created_at: createdAt, event_id: extra.event_id ?? null, booking_reference: extra.ref ?? null };
}

test('month helpers', () => {
  assert.equal(monthKey('2026-03-15T10:00:00Z'), '2026-03');
  assert.equal(monthKey(null), null);
  assert.equal(monthKey('garbage'), null);
  assert.equal(prevMonth('2026-01'), '2025-12');
  assert.equal(nextMonth('2025-12'), '2026-01');
  assert.equal(monthEndIso('2026-02'), '2026-02-28T23:59:59.999Z');
  assert.ok(isValidMonth('2026-07'));
  assert.ok(!isValidMonth('2026-13'));
  assert.ok(!isValidMonth('2026-7'));
});

test('deriveOriginalValue reconstructs award value from ledger', () => {
  const voucher = { value: 40 };
  const txns = [
    { type: 'booking_usage', amount: 100 },
    { type: 'cancellation_refund', amount: 40 },
    { type: 'expiry', amount: 0 },
  ];
  // original = 40 + 100 - 40 = 100
  assert.equal(deriveOriginalValue(voucher, txns), 100);
  assert.equal(deriveOriginalValue({ value: 250 }, []), 250);
});

test('allocationDate prefers valid_from then issued_at then created_at', () => {
  assert.equal(allocationDate({ valid_from: 'a', issued_at: 'b', created_at: 'c' }), 'a');
  assert.equal(allocationDate({ issued_at: 'b', created_at: 'c' }), 'b');
  assert.equal(allocationDate({ created_at: 'c' }), 'c');
  assert.equal(allocationDate({}), null);
});

test('usage attributed to event month, not transaction month', () => {
  const vouchers = [v('v1', 0, '2026-01-05T00:00:00Z')];
  const transactions = [
    // Booked in Feb for an event in April.
    tx('v1', 'booking_usage', 100, '2026-02-10T00:00:00Z', { event_id: 'e1' }),
  ];
  const movements = buildMovements({ vouchers, transactions, eventStartById: { e1: '2026-04-20T09:00:00Z' } });

  const feb = rollupMonth({ month: '2026-02', movements });
  assert.equal(feb[ORG].used, 0);
  assert.equal(feb[ORG].closing_balance, 100); // still held in Feb
  assert.equal(feb[ORG].reserved_future, 100); // but committed
  assert.equal(feb[ORG].available_balance, 0);

  const apr = rollupMonth({ month: '2026-04', movements });
  assert.equal(apr[ORG].used, 100);
  assert.equal(apr[ORG].opening_balance, 100);
  assert.equal(apr[ORG].closing_balance, 0);
  assert.equal(apr[ORG].reserved_future, 0);
});

test('usage without a resolvable event falls back to txn month', () => {
  const vouchers = [v('v1', 50, '2026-01-01T00:00:00Z')];
  const transactions = [tx('v1', 'booking_usage', 50, '2026-03-03T00:00:00Z')];
  const movements = buildMovements({ vouchers, transactions, eventStartById: {} });
  const mar = rollupMonth({ month: '2026-03', movements });
  assert.equal(mar[ORG].used, 50);
  assert.equal(mar[ORG].closing_balance, 50); // opening 100 - used 50
});

test('pre-event cancellation nets against used in the event month', () => {
  const vouchers = [v('v1', 100, '2026-01-01T00:00:00Z')];
  const transactions = [
    tx('v1', 'booking_usage', 60, '2026-02-01T00:00:00Z', { event_id: 'e1', ref: 'B-1' }),
    // Cancelled in March, event in April -> refund month <= event month.
    tx('v1', 'cancellation_refund', 60, '2026-03-15T00:00:00Z', { event_id: 'e1', ref: 'B-1' }),
  ];
  const movements = buildMovements({ vouchers, transactions, eventStartById: { e1: '2026-04-10T00:00:00Z' } });
  const apr = rollupMonth({ month: '2026-04', movements });
  assert.equal(apr[ORG].used, 0); // netted: never reported as used
  assert.equal(apr[ORG].reinstated, 0);
  assert.equal(apr[ORG].closing_balance, 100);
  // March: nothing recognised, balance unchanged.
  const mar = rollupMonth({ month: '2026-03', movements });
  assert.equal(mar[ORG].used, 0);
  assert.equal(mar[ORG].closing_balance, 100);
});

test('post-event reinstatement is a correcting adjustment in the approval month', () => {
  const vouchers = [v('v1', 100, '2026-01-01T00:00:00Z')];
  const transactions = [
    tx('v1', 'booking_usage', 60, '2026-02-01T00:00:00Z', { event_id: 'e1', ref: 'B-1' }),
    // Event in March; refund approved in May (after the usage month closed).
    tx('v1', 'cancellation_refund', 60, '2026-05-02T00:00:00Z', { event_id: 'e1', ref: 'B-1' }),
  ];
  const movements = buildMovements({ vouchers, transactions, eventStartById: { e1: '2026-03-10T00:00:00Z' } });

  // March keeps the usage (closed month never rewritten).
  const mar = rollupMonth({ month: '2026-03', movements });
  assert.equal(mar[ORG].used, 60);
  assert.equal(mar[ORG].closing_balance, 40);

  // May shows the correcting reinstatement.
  const may = rollupMonth({ month: '2026-05', movements });
  assert.equal(may[ORG].reinstated, 60);
  assert.equal(may[ORG].opening_balance, 40);
  assert.equal(may[ORG].closing_balance, 100);
  const reinst = movements.find((m) => m.bucket === 'reinstated');
  assert.equal(reinst.ref, 'B-1'); // references original booking
});

test('expiry and adjustments recognised in txn month', () => {
  const vouchers = [v('v1', 0, '2026-01-01T00:00:00Z')];
  const transactions = [
    tx('v1', 'credit_adjustment', 20, '2026-02-01T00:00:00Z'),
    tx('v1', 'debit_adjustment', 5, '2026-02-10T00:00:00Z'),
    tx('v1', 'expiry', 115, '2026-02-20T00:00:00Z'),
  ];
  // original = 0 + 5 + 115 - 20 = 100
  const movements = buildMovements({ vouchers, transactions, eventStartById: {} });
  const jan = rollupMonth({ month: '2026-01', movements });
  assert.equal(jan[ORG].allocated, 100);
  const feb = rollupMonth({ month: '2026-02', movements });
  assert.equal(feb[ORG].adjustments_positive, 20);
  assert.equal(feb[ORG].adjustments_negative, 5);
  assert.equal(feb[ORG].expired, 115);
  assert.equal(feb[ORG].closing_balance, 0);
});

test('carry-forward: closing(N) equals opening(N+1) via replay', () => {
  const vouchers = [v('v1', 30, '2026-01-01T00:00:00Z')];
  const transactions = [
    tx('v1', 'booking_usage', 70, '2026-02-05T00:00:00Z', { event_id: 'e1' }),
  ];
  const movements = buildMovements({ vouchers, transactions, eventStartById: { e1: '2026-02-15T00:00:00Z' } });
  const feb = rollupMonth({ month: '2026-02', movements });
  const mar = rollupMonth({ month: '2026-03', movements });
  assert.equal(mar[ORG].opening_balance, feb[ORG].closing_balance);
});

test('openingByOrg (prior snapshot) overrides replay and includeOrgIds emits zero rows', () => {
  const movements = [];
  const rows = rollupMonth({
    month: '2026-06',
    movements,
    openingByOrg: { [ORG]: 42.5 },
    includeOrgIds: [ORG2],
  });
  assert.equal(rows[ORG].opening_balance, 42.5);
  assert.equal(rows[ORG].closing_balance, 42.5);
  assert.equal(rows[ORG2].opening_balance, 0);
  assert.equal(rows[ORG2].closing_balance, 0);
});

test('multi-org isolation and zero-balance orgs with activity included', () => {
  const vouchers = [
    v('v1', 0, '2026-01-01T00:00:00Z', ORG),
    v('v2', 200, '2026-01-01T00:00:00Z', ORG2),
  ];
  const transactions = [
    tx('v1', 'booking_usage', 100, '2026-01-10T00:00:00Z', { event_id: 'e1', org: ORG }),
    // original v1 = 0 + 100 = 100
  ];
  const movements = buildMovements({ vouchers, transactions, eventStartById: { e1: '2026-01-20T00:00:00Z' } });
  const feb = rollupMonth({ month: '2026-02', movements });
  assert.equal(feb[ORG].opening_balance, 0); // fully used, still reported
  assert.equal(feb[ORG2].opening_balance, 200);
  assert.equal(feb[ORG2].closing_balance, 200);
});

test('reserved_future only counts commitments made by month end', () => {
  const vouchers = [v('v1', 0, '2026-01-01T00:00:00Z')];
  const transactions = [
    // Booked in March for a June event; original value = 80.
    tx('v1', 'booking_usage', 80, '2026-03-05T00:00:00Z', { event_id: 'e1' }),
  ];
  const movements = buildMovements({ vouchers, transactions, eventStartById: { e1: '2026-06-01T00:00:00Z' } });
  const feb = rollupMonth({ month: '2026-02', movements });
  assert.equal(feb[ORG].reserved_future, 0); // not yet booked in Feb
  const mar = rollupMonth({ month: '2026-03', movements });
  assert.equal(mar[ORG].reserved_future, 80);
  const jun = rollupMonth({ month: '2026-06', movements });
  assert.equal(jun[ORG].reserved_future, 0); // event month reached
});

test('unknown txn types fall back to signed adjustments (balance identity holds)', () => {
  const vouchers = [v('v1', 10, '2026-01-01T00:00:00Z')];
  const transactions = [tx('v1', 'mystery_type', -3, '2026-01-05T00:00:00Z')];
  const movements = buildMovements({ vouchers, transactions, eventStartById: {} });
  const jan = rollupMonth({ month: '2026-01', movements });
  assert.equal(jan[ORG].adjustments_negative, 3);
});

test('vouchers/txns without organisation are skipped, not crashed', () => {
  const vouchers = [v('v1', 10, '2026-01-01T00:00:00Z', null)];
  const transactions = [
    { voucher_id: 'v1', organization_id: null, type: 'booking_usage', amount: 5, created_at: '2026-01-02T00:00:00Z' },
  ];
  const movements = buildMovements({ vouchers, transactions, eventStartById: {} });
  assert.equal(movements.length, 0);
});
