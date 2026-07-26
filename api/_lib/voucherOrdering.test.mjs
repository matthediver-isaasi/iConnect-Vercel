import test from 'node:test';
import assert from 'node:assert/strict';
import {
  orderVoucherIdsForRedemption,
  computeExpiryBreakdown,
} from './voucherOrdering.js';

const byId = {
  a: { expires_at: '2026-12-31T00:00:00Z', issued_at: '2026-01-01T00:00:00Z' },
  b: { expires_at: '2026-06-30T00:00:00Z', issued_at: '2026-02-01T00:00:00Z' },
  c: { expires_at: '2026-06-30T00:00:00Z', issued_at: '2026-01-15T00:00:00Z' },
  d: { expires_at: null, issued_at: '2025-01-01T00:00:00Z' },
};

test('auto mode sorts first-expiry-first-used (expiry asc, then issued asc)', () => {
  const { orderedIds, overrideNote } = orderVoucherIdsForRedemption(
    ['a', 'b', 'c', 'd'],
    byId,
    false
  );
  assert.deepEqual(orderedIds, ['c', 'b', 'a', 'd']);
  assert.equal(overrideNote, null);
});

test('vouchers without expiry sort last in auto mode', () => {
  const { orderedIds } = orderVoucherIdsForRedemption(['d', 'b'], byId, false);
  assert.deepEqual(orderedIds, ['b', 'd']);
});

test('manual mode preserves client-sent order and records an override note', () => {
  const { orderedIds, overrideNote } = orderVoucherIdsForRedemption(
    ['a', 'd', 'b', 'c'],
    byId,
    true
  );
  assert.deepEqual(orderedIds, ['a', 'd', 'b', 'c']);
  assert.match(overrideNote, /manually selected/i);
  assert.match(overrideNote, /first-expiry-first-used/i);
});

test('single voucher and missing lookup data are no-ops', () => {
  assert.deepEqual(orderVoucherIdsForRedemption(['a'], byId, false).orderedIds, ['a']);
  assert.deepEqual(orderVoucherIdsForRedemption(['b', 'a'], null, false).orderedIds, ['b', 'a']);
  assert.deepEqual(orderVoucherIdsForRedemption(null, byId, false).orderedIds, []);
});

test('expiry breakdown: awarded 100, used 30, remaining 70', () => {
  const txns = [
    { type: 'voucher_awarded', amount: 100 },
    { type: 'booking_usage', amount: 30 },
  ];
  const { originalValue, usedValue } = computeExpiryBreakdown(70, txns);
  assert.equal(originalValue, 100);
  assert.equal(usedValue, 30);
});

test('expiry breakdown: award row must not zero the original value', () => {
  // Regression: subtracting credits (award) made original ≈ 0.
  const { originalValue, usedValue } = computeExpiryBreakdown(100, [
    { type: 'voucher_awarded', amount: 100 },
  ]);
  assert.equal(originalValue, 100);
  assert.equal(usedValue, 0);
});

test('expiry breakdown: refunds reduce used value', () => {
  // used 30, refunded 10 back, remaining 80 => used 20, original 100
  const txns = [
    { type: 'booking_usage', amount: 30 },
    { type: 'cancellation_refund', amount: 10 },
  ];
  const { originalValue, usedValue } = computeExpiryBreakdown(80, txns);
  assert.equal(usedValue, 20);
  assert.equal(originalValue, 100);
});

test('expiry breakdown: negative-signed usage amounts are normalised', () => {
  const { usedValue, originalValue } = computeExpiryBreakdown(70, [
    { type: 'booking_usage', amount: -30 },
  ]);
  assert.equal(usedValue, 30);
  assert.equal(originalValue, 100);
});

test('expiry breakdown: no ledger rows => original equals remaining', () => {
  const { originalValue, usedValue } = computeExpiryBreakdown(50, []);
  assert.equal(originalValue, 50);
  assert.equal(usedValue, 0);
});

test('cron auth: fails closed without CRON_SECRET, 401 on mismatch', async (t) => {
  const prev = process.env.CRON_SECRET;
  const { default: handler } = await import('../cron/process-voucher-expiries.js');
  const makeRes = () => {
    const res = { statusCode: null, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
  };
  t.after(() => {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  });

  delete process.env.CRON_SECRET;
  let res = makeRes();
  await handler({ headers: {} }, res);
  assert.equal(res.statusCode, 500);

  process.env.CRON_SECRET = 'test-secret';
  res = makeRes();
  await handler({ headers: { authorization: 'Bearer wrong' } }, res);
  assert.equal(res.statusCode, 401);

  res = makeRes();
  await handler({ headers: {} }, res);
  assert.equal(res.statusCode, 401);
});
