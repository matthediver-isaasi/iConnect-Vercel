import test from 'node:test';
import assert from 'node:assert/strict';
import {
  annualRecordSchedule,
  classifyAnnualRenewal,
  deriveAnnualTerm,
  normalizeAnnualRenewalConfig,
} from './annualRenewalPolicy.js';

const config = {
  renewal_open_days: 30,
  renewal_grace_days: 7,
  renewal_disable_login: true,
  renewal_change_role: true,
  renewal_fallback_role_id: 'role-1',
};
const previous = {
  billing_period: 'annual',
  membership_year: '2025',
  term_start_date: '2025-01-01',
  term_end_date: '2025-12-31',
};
const targetMembershipYear = { label: '2026', start: '2026-01-01', end: '2026-12-31' };

test('annual renewal uses the persisted term boundary and keeps a full next year', () => {
  assert.equal(deriveAnnualTerm(previous, config).nextStart.toISOString().slice(0, 10), '2026-01-01');
  const result = classifyAnnualRenewal({
    previousRecord: previous,
    targetMembershipYear,
    config,
    now: new Date('2025-12-01T12:00:00Z'),
  });
  assert.equal(result.state, 'open');
  assert.equal(result.target.start.toISOString().slice(0, 10), '2026-01-01');
  assert.equal(result.target.end.toISOString().slice(0, 10), '2026-12-31');
});

test('opening and grace boundaries are inclusive, including zero-day settings', () => {
  const zero = { renewal_open_days: 0, renewal_grace_days: 0 };
  assert.equal(classifyAnnualRenewal({
    previousRecord: previous, targetMembershipYear, config: zero, now: new Date('2025-12-30T23:59:00Z'),
  }).state, 'renewable_soon');
  assert.equal(classifyAnnualRenewal({
    previousRecord: previous, targetMembershipYear, config: zero, now: new Date('2025-12-31T12:00:00Z'),
  }).eligible, true);
  assert.equal(classifyAnnualRenewal({
    previousRecord: previous, targetMembershipYear, config: zero, now: new Date('2026-01-01T00:00:00Z'),
  }).state, 'expired');

  assert.equal(classifyAnnualRenewal({
    previousRecord: previous, targetMembershipYear, config, now: new Date('2026-01-07T12:00:00Z'),
  }).state, 'grace');
  assert.equal(classifyAnnualRenewal({
    previousRecord: previous, targetMembershipYear, config, now: new Date('2026-01-08T00:00:00Z'),
  }).state, 'expired');
});

test('first memberships remain available and persisted monthly plans are excluded', () => {
  assert.equal(classifyAnnualRenewal({ targetMembershipYear, config }).state, 'initial');
  const monthly = classifyAnnualRenewal({
    previousRecord: { ...previous, billing_period: 'monthly_card' },
    targetMembershipYear,
    config,
  });
  assert.equal(monthly.eligible, false);
  assert.equal(monthly.code, 'recurring_membership_managed_separately');
});

test('config normalization is bounded and scheduling records exact term dates', () => {
  assert.deepEqual(normalizeAnnualRenewalConfig({
    renewal_open_days: 999,
    renewal_grace_days: -1,
    renewal_disable_login: true,
  }), {
    windowDays: 0,
    graceDays: 0,
    disableLogin: true,
    changeRole: false,
    fallbackRoleId: null,
  });
  assert.deepEqual(annualRecordSchedule({
    state: 'open',
    lifecycle: {
      isEarly: true,
      termStart: '2026-01-01',
      termEnd: '2026-12-31',
    },
  }), {
    status: 'scheduled',
    scheduled_activation_date: '2026-01-01',
    term_start_date: '2026-01-01',
    term_end_date: '2026-12-31',
    annual_renewal_state: 'open',
  });
});