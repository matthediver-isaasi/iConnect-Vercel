import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paymentReportExpiry } from './membershipPaymentReportExpiry.js';

test('expiry uses whole UTC days with an exclusive 90-day cutoff', () => {
  for (const [date, category, days] of [
    ['2026-03-02', 'expired_over_90', 91],
    ['2026-03-03', 'expired_within_90', 90],
    ['2026-05-31', 'expired_within_90', 1],
    ['2026-06-01', 'not_expired', 0],
    ['2027-01-01', 'not_expired', 0],
    ['2026-02-30', 'unknown', null],
    [null, 'unknown', null],
    ['01/01/2026', 'unknown', null],
  ]) {
    assert.deepEqual(paymentReportExpiry({ currentExpiryDate: date }, '2026-06-01'),
      { expiryCategory: category, daysPastExpiry: days });
  }
  assert.throws(() => paymentReportExpiry({}, 'invalid'));
});

test('UI binds expiry to query identity, API, export, and page/export reset', () => {
  const source = readFileSync('client/src/pages/MembershipPaymentReport.jsx', 'utf8');
  assert.match(source, /queryKey: \["membership-payment-report", page, paymentMethod, expiry,/);
  assert.match(source, /method: paymentMethod,\s+expiry,/);
  assert.match(source, /format: "csv", method: paymentMethod, expiry/);
  assert.match(source, /cancelExport\(\);\s+setExpiry\(value\);\s+setPage\(1\)/);
  assert.match(source, /Expired over 90 days ago/);
});
