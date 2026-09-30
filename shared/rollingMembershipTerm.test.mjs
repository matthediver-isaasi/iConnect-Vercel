import test from 'node:test';
import assert from 'node:assert/strict';
import { billingPeriodMonths, addCalendarMonths, buildRollingTerm, rollingDateString } from './rollingMembershipTerm.js';

test('pricing billing periods are distinct from monthly collection methods', () => {
  assert.equal(billingPeriodMonths('annual'), 12);
  assert.equal(billingPeriodMonths('quarterly'), 3);
  assert.equal(billingPeriodMonths('monthly'), 1);
  assert.throws(() => billingPeriodMonths('monthly_card'), /Unsupported/);
  for (const [billingPeriod, renewal] of [['annual', '2027-09-15'], ['quarterly', '2026-12-15'], ['monthly', '2026-10-15']]) {
    const term = buildRollingTerm({ startDate: '2026-09-15', billingPeriod });
    assert.equal(term.membership_renewal_date, renewal);
    assert.equal(term.term_key, 'rolling:2026-09-15');
  }
});

test('month-end and leap anchors recover their original day without drifting', () => {
  const january = buildRollingTerm({ startDate: '2027-01-31', billingPeriod: 'monthly' });
  assert.equal(january.membership_renewal_date, '2027-02-28');
  const february = buildRollingTerm({ previousTerm: { id: 'first', ...january }, billingPeriod: 'monthly' });
  assert.equal(february.membership_renewal_date, '2027-03-31');
  assert.equal(february.previous_term_id, 'first');
  assert.equal(february.term_anchor_date, '2027-01-31');
  assert.equal(addCalendarMonths('2024-02-29', 12), '2025-02-28');
  assert.equal(addCalendarMonths('2027-02-28', 12, '2024-02-29'), '2028-02-29');
  assert.throws(() => buildRollingTerm({ startDate: '2027-03-01', previousTerm: january, billingPeriod: 'monthly' }), /previous renewal date/);
});

test('date-only validation rejects normalized dates and missing commencement', () => {
  assert.throws(() => rollingDateString('2026-02-30'), /Invalid/);
  assert.throws(() => buildRollingTerm({ billingPeriod: 'annual' }), /date is required/);
  assert.equal(rollingDateString(new Date('2026-09-15T23:59:59Z')), '2026-09-15');
});