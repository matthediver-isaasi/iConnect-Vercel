import test from 'node:test';
import assert from 'node:assert/strict';
import { assessFormMembershipRenewalEvidence as assess } from './formMembershipRenewalEvidence.js';

const config = {
  id: 'purchased', tenant_id: 'tenant', structure_scope_type: 'member',
  start_mode: 'fixed_date', billing_period: 'annual', renewal_open_days: 60, renewal_grace_days: 7,
};
const history = {
  id: 'prior', tenant_id: 'tenant', member_id: 'member', status: 'active',
  payment_status: 'paid', term_start_date: '2026-01-01', term_end_date: '2026-12-31',
  commitment_snapshot: { config, payment_frequency: 'upfront' },
};
function fixture(extra = {}) {
  return {
    tenantId: 'tenant', memberId: 'member', histories: [structuredClone(history)],
    agreements: [], successorConfig: { ...config, id: 'successor' }, now: '2026-11-01', ...extra,
  };
}

test('60 days early preserves all prepaid time and buys a full successor year', () => {
  const input = fixture();
  const original = structuredClone(input);
  const result = assess(input);
  assert.equal(result.state, 'eligible_renewal');
  assert.equal(result.currentEnd, '2026-12-31');
  assert.equal(result.successorStart, '2027-01-01');
  assert.equal(result.successorEnd, '2027-12-31');
  assert.deepEqual(input, original);
});

test('inclusive UTC fixed windows, including explicit zero, use purchased not successor policy', () => {
  for (const [now, state] of [
    ['2026-10-31', 'renewal_not_open'], ['2026-11-01', 'eligible_renewal'],
    ['2027-01-07T23:59:59Z', 'eligible_renewal'], ['2027-01-08', 'renewal_closed'],
  ]) {
    assert.equal(assess(fixture({ now, successorConfig: { ...config, renewal_open_days: 0, renewal_grace_days: 0 } })).state, state);
  }
  const zero = structuredClone(history);
  zero.commitment_snapshot.config.renewal_open_days = 0;
  zero.commitment_snapshot.config.renewal_grace_days = 0;
  for (const [now, eligible] of [['2026-12-30', false], ['2026-12-31', true], ['2027-01-01', false]]) {
    assert.equal(assess(fixture({ histories: [zero], now })).eligible, eligible);
  }
});

test('active unpaid is neither settled nor eligible for successor payment', () => {
  const result = assess(fixture({ histories: [{ ...history, payment_status: 'unpaid' }] }));
  assert.equal(result.state, 'current_membership');
  assert.equal(result.eligible, false);
});

test('late grace does not shift the successor to checkout date', () => {
  const result = assess(fixture({ now: '2027-01-06' }));
  assert.equal(result.successorStart, '2027-01-01');
  assert.equal(result.successorEnd, '2027-12-31');
});

test('rolling monthly anchor survives February clamping and zero-day window', () => {
  const prior = structuredClone(history);
  Object.assign(prior, {
    term_key: 'rolling:2028-01-31', term_start_date: '2028-01-31',
    term_end_date: '2028-02-28', membership_renewal_date: '2028-02-29', term_anchor_date: '2028-01-31',
  });
  prior.commitment_snapshot.config.renewal_open_days = 0;
  prior.commitment_snapshot.config.renewal_grace_days = 0;
  const input = fixture({ histories: [prior], now: '2028-02-29',
    successorConfig: { ...config, start_mode: 'immediate', billing_period: 'monthly' } });
  assert.equal(assess(input).successorEnd, '2028-03-30');
  assert.equal(assess(input).eligible, true);
  assert.equal(assess({ ...input, now: '2028-02-28' }).eligible, false);
});

test('nonannual successor lengths are calendar based', () => {
  const result = assess(fixture({ successorConfig: { ...config, billing_period: 'quarterly' } }));
  assert.equal(result.successorEnd, '2027-03-31');
});

test('paid successor and pending successor both block competing payment', () => {
  for (const payment_status of ['paid', 'unpaid']) {
    const future = { ...history, id: 'next', previous_term_id: history.id,
      term_start_date: '2027-01-01', term_end_date: '2027-12-31', status: 'scheduled', payment_status };
    const result = assess(fixture({ histories: [history, future] }));
    assert.equal(result.eligible, false);
    assert.equal(result.state, payment_status === 'paid' ? 'next_term_purchased' : 'renewal_pending');
  }
});

test('missing, cross-tenant, paused, ambiguous and expiry-only evidence fails closed', () => {
  const cases = [
    { histories: null }, { agreements: null }, { tenantId: 'other' }, { paused: true },
    { histories: [{ ...history, term_start_date: null }] },
    { histories: [{ ...history, commitment_snapshot: null }] },
    { histories: [history, { ...history, id: 'overlap' }] },
    { successorConfig: { ...config, tenant_id: 'other' } },
    { successorConfig: { ...config, effective_to: '2026-12-31' } },
    { histories: [{ ...history, membership_renewal_date: '2027-02-01' }] },
  ];
  for (const extra of cases) assert.equal(assess(fixture(extra)).eligible, false);
});

test('recurring predecessor retains its own payment status and agreement identity', () => {
  const prior = { ...history, payment_status: 'partially_paid', billing_agreement_id: 'old-dd' };
  const agreements = [{ id: 'old-dd', tenant_id: 'tenant', member_id: 'member', status: 'active',
    provider: 'gocardless', metadata: { dd: { auto_renew: false } } }];
  const input = fixture({ histories: [prior], agreements });
  const original = structuredClone(input);
  const result = assess(input);
  assert.equal(result.currentAgreementId, 'old-dd');
  assert.equal(result.currentPaymentStatus, 'partially_paid');
  assert.equal(result.eligible, true);
  assert.deepEqual(input, original, 'assessment never completes, cancels or mutates the old plan');
  assert.equal(assess({ ...input, agreements: [] }).eligible, false);
  assert.equal(assess({ ...input, agreements: [...agreements, { ...agreements[0], id: 'new-dd' }] }).state, 'renewal_pending');
});

test('ongoing DD remains continuing outside the election window; finite consent is not upgraded', () => {
  for (const auto_renew of [true, false]) {
    const input = fixture({
      histories: [{ ...history, billing_agreement_id: 'dd', payment_status: 'partially_paid' }],
      agreements: [{ id: 'dd', tenant_id: 'tenant', member_id: 'member', provider: 'gocardless',
        status: 'active', metadata: { dd: { auto_renew } } }],
    });
    assert.equal(assess(input).state, auto_renew ? 'continuing_arrangement' : 'eligible_renewal');
    assert.equal(assess({ ...input, now: '2027-01-15' }).state,
      auto_renew ? 'continuing_arrangement' : 'renewal_closed');
    assert.equal(assess({ ...input, now: '2026-10-01' }).state,
      auto_renew ? 'continuing_arrangement' : 'renewal_not_open');
    assert.equal(assess({ ...input, now: '2027-01-15' }).eligible, false);
    input.agreements[0].metadata = {};
    assert.equal(assess(input).state, 'review_required');
  }
});