import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentReportCountdown, paymentReportGrace } from './membershipPaymentReportGrace.js';

test('countdown follows supplied grace end including zero-day and final-day boundaries', () => {
  const row = { currentExpiryDate: '2026-10-01' };
  assert.equal(paymentReportCountdown(row, '2026-09-29').expiryTiming, '2 days until expiry');
  assert.deepEqual(paymentReportCountdown(row, '2026-10-08', '2026-10-08'), {
    expiryTiming: '0 grace days remaining', expiryTone: 'grace',
  });
  assert.equal(paymentReportCountdown(row, '2026-10-09', '2026-10-08').expiryTone, 'expired');
  assert.equal(paymentReportCountdown(row, '2026-10-02', '2026-10-01').expiryTiming, 'Grace exceeded by 1 days');
  assert.equal(paymentReportCountdown(row, '2026-10-09').expiryTone, null);
});

test('applied configuration drives grace, with snapshot priority and no inferred defaults', async () => {
  const row = { historyId: 'h', memberId: 'm', currentExpiryDate: '2026-10-01' };
  const record = { id: 'h', tenant_id: 't', member_id: 'm', config_id: 'c', payment_method: 'upfront',
    billing_period: 'annual', term_start_date: '2025-10-02', term_end_date: row.currentExpiryDate };
  const run = (days, snapshot) => paymentReportGrace(null, { row, tenantId: 't', today: '2026-10-09',
    history: [{ ...record, commitment_snapshot: snapshot ? { config: snapshot } : null }],
    configs: [{ id: 'c', tenant_id: 't', renewal_grace_days: days }] });
  assert.equal((await run(30)).expiryTiming, '22 grace days remaining');
  assert.equal((await run(7)).expiryTiming, 'Grace exceeded by 1 days');
  assert.equal((await run(30, { renewal_grace_days: 7 })).expiryTone, 'expired');
  assert.equal((await run(null)).expiryTone, null);
  assert.match((await run(null)).expiryTiming, /policy unknown/);
});
