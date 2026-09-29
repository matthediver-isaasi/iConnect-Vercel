import test from 'node:test';
import assert from 'node:assert/strict';
import {
  annualRecordSchedule,
  classifyAnnualRenewal,
  deriveAnnualTerm,
  normalizeAnnualRenewalConfig,
  resolveEntityAnnualRenewalEligibility,
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

function historyClient(history = [], agreements = []) {
  return { from(table) {
    const filters = [];
    const q = {
      select() { return q; },
      eq(key, value) { filters.push(row => row[key] === value); return q; },
      in(key, values) { filters.push(row => values.includes(row[key])); return q; },
      order() { return q; }, limit() { return q; },
      then(resolve, reject) {
        const rows = table === 'membership_billing_agreements' ? agreements : history;
        return Promise.resolve({ data: rows.filter(row => filters.every(f => f(row))), error: null }).then(resolve, reject);
      },
    };
    return q;
  } };
}

test('sanitized GFI candidate is an established renewal, not proof of a first-year failure', async () => {
  const history = [{
    tenant_id: 'tenant', organization_id: 'org', membership_year: '2025/2026',
    year_number: 6, billing_period: 'annual', status: 'active', payment_status: null,
    commitment_snapshot: null, term_start_date: null, term_end_date: null,
  }];
  const tier = { start_mode: 'fixed_date', billing_period: 'annual',
    membership_start_month: 8, membership_start_day: 1, renewal_open_days: 0, renewal_grace_days: 0 };
  for (const label of ['2026/2027', '2027/2028']) {
    const result = await resolveEntityAnnualRenewalEligibility(historyClient(history), {
      tenantId: 'tenant', organizationId: 'org', config: tier,
      membershipYear: { label, start: `${label.slice(0, 4)}-08-01`, end: `${label.slice(5)}-07-31` },
      now: new Date('2026-09-29T12:00:00Z'),
    });
    assert.equal(result.code, 'annual_renewal_grace_expired');
    assert.equal(result.lifecycle.renewalGraceEndDate, '2026-07-31');
    assert.equal(result.lifecycle.termStart, '2026-08-01');
  }
  const first = await resolveEntityAnnualRenewalEligibility(historyClient(), {
    tenantId: 'tenant', organizationId: 'org', config: tier,
    membershipYear: { label: '2026/2027', start: '2026-08-01', end: '2027-07-31' },
    now: new Date('2026-09-29T12:00:00Z'),
  });
  assert.equal(first.state, 'initial');
  assert.equal(first.eligible, true);
  assert.equal(first.lifecycle.termStart, '2026-08-01');
});

test('saved zero-grace policy cannot be replaced by a more permissive live policy', () => {
  const result = classifyAnnualRenewal({
    previousRecord: { ...previous, commitment_snapshot: { config: { renewal_grace_days: 0 } } },
    targetMembershipYear, config: { renewal_grace_days: 90 },
    now: new Date('2026-01-01T00:00:00Z'),
  });
  assert.equal(result.code, 'annual_renewal_grace_expired');
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