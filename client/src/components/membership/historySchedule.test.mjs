import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getMembershipHistorySchedule,
  historyScheduleDateLabel,
  membershipHistoryTermLabel,
  retainedHistoryDate,
} from './historySchedule.js';

test('preserves an ordinary membership-year heading and retained fixed term', () => {
  assert.deepEqual(getMembershipHistorySchedule({
    membership_year: '2026/2027',
    term_start_date: '2026-04-01',
    term_end_date: '2027-03-31',
    membership_renewal_date: '2027-04-01',
    term_duration_months: 12,
    payment_method: 'stripe',
    commitment_snapshot: { payment_frequency: 'upfront' },
  }), {
    heading: 'Membership 2026/2027',
    schedule: 'From 1 April 2026 · 12 months',
    renewalDate: '1 April 2027',
    endDate: '31 March 2027',
    paymentLabel: 'Card payment',
  });
});

test('presents a legacy upfront year and retained expiry without inventing a start', () => {
  const record = {
    membership_year: '2025/2026',
    status: 'active',
    payment_status: 'paid',
    tier_label: 'Legacy Professional',
    term_start_date: null,
    term_end_date: '2026-09-30',
    membership_renewal_date: null,
    term_key: null,
    commitment_snapshot: null,
    billing_agreement_id: null,
    notes: JSON.stringify({
      source: 'bnms_non_dd_current_backfill',
      term_start_date: '2025-10-01',
      membership_renewal_date: '2026-10-01',
    }),
  };

  assert.deepEqual(getMembershipHistorySchedule(record), {
    heading: 'Membership 2025/2026',
    schedule: null,
    renewalDate: null,
    endDate: '30 September 2026',
  });
  assert.equal(membershipHistoryTermLabel(record), '2025/2026');
});

test('uses a saved start for a readable rolling heading, never the term-key date', () => {
  assert.equal(getMembershipHistorySchedule({
    membership_year: 'rolling',
    term_key: 'rolling:1999-09-09',
    term_start_date: '2026-02-03',
  }).heading, 'Membership from 3 February 2026');

  assert.equal(getMembershipHistorySchedule({
    membership_year: 'rolling',
    term_key: 'rolling:1999-09-09',
  }).heading, 'Membership');
});

test('an ordinary retained year heading remains unchanged even with a rolling term key', () => {
  assert.equal(getMembershipHistorySchedule({
    membership_year: '2026/2027',
    term_key: 'rolling:2026-05-12',
    term_start_date: '2026-05-12',
  }).heading, 'Membership 2026/2027');
});

test('preserves conventional single-year and hyphenated year headings', () => {
  assert.equal(
    getMembershipHistorySchedule({ membership_year: '2026' }).heading,
    'Membership 2026',
  );
  assert.equal(
    getMembershipHistorySchedule({ membership_year: '2026-2027' }).heading,
    'Membership 2026-2027',
  );
});

test('preserves the short-end year labels retained by card and Direct Debit flows', () => {
  for (const membership_year of ['2026/27', '2026-27']) {
    for (const payment_method of ['card_monthly', 'direct_debit']) {
      const presentation = getMembershipHistorySchedule({
        membership_year,
        payment_method,
      });
      assert.equal(presentation.heading, `Membership ${membership_year}`);
      // A readable label is not evidence for any term date.
      assert.equal(presentation.renewalDate, null);
      assert.equal(presentation.endDate, null);
      assert.equal(presentation.schedule, payment_method === 'direct_debit' ? 'Ongoing — Direct Debit' : null);
    }
  }
});

test('treats a rolling membership-year label as an indicator but not date evidence', () => {
  assert.equal(getMembershipHistorySchedule({
    membership_year: 'rolling:1999-09-09',
    term_start_date: '2026-08-07',
  }).heading, 'Membership from 7 August 2026');

  assert.deepEqual(getMembershipHistorySchedule({
    membership_year: 'rolling:1999-09-09',
  }), {
    heading: 'Membership',
    schedule: null,
    renewalDate: null,
    endDate: null,
  });
});

test('presents a retained start in the schedule even for an ordinary year', () => {
  assert.deepEqual(getMembershipHistorySchedule({
    membership_year: '2026/2027',
    term_start_date: '2026-11-18',
  }), {
    heading: 'Membership 2026/2027',
    schedule: 'From 18 November 2026',
    renewalDate: null,
    endDate: null,
  });
});

test('does not derive rolling dates from membership year, identifier, or created_at', () => {
  assert.deepEqual(getMembershipHistorySchedule({
    membership_year: '2026-02-03',
    term_key: 'rolling:2026-02-03',
    id: 'rolling-2026-02-03',
    created_at: '2026-02-03T12:00:00Z',
    term_duration_months: 6,
  }), {
    heading: 'Membership',
    schedule: '6 months',
    renewalDate: null,
    endDate: null,
  });
});

test('supports a commitment snapshot when top-level commitment fields are absent', () => {
  assert.deepEqual(getMembershipHistorySchedule({
    membership_year: 'rolling',
    commitment_snapshot: {
      term_key: 'rolling:saved',
      term_start_date: '2026-09-15',
      term_end_date: '2027-03-14',
      membership_renewal_date: '2027-03-15',
      term_duration_months: 6,
      payment_method: 'stripe_monthly_card',
      payment_frequency: 'monthly',
    },
  }), {
    heading: 'Membership from 15 September 2026',
    schedule: 'From 15 September 2026 · 6 months',
    renewalDate: '15 March 2027',
    endDate: '14 March 2027',
    paymentLabel: 'Monthly card payments',
  });
});

test('keeps duration separate from monthly payment frequency', () => {
  const result = getMembershipHistorySchedule({
    membership_year: '2026/2027',
    term_duration_months: 3,
    payment_method: 'card_monthly',
    commitment_snapshot: { collection_frequency: 'monthly' },
  });
  assert.equal(result.schedule, '3 months');
  assert.equal(result.paymentLabel, 'Monthly card payments');
});

for (const method of [
  'direct_debit',
  'gocardless',
  'monthly_direct_debit',
  'direct_debit_monthly',
  'gocardless_monthly',
  'gocardless_monthly_dd',
]) {
  test(`presents ${method} as an ongoing Direct Debit without a renewal prompt`, () => {
    const result = getMembershipHistorySchedule({
      membership_year: '2026/2027',
      membership_renewal_date: '2027-04-01',
      term_end_date: '2027-03-31',
      term_duration_months: 12,
      commitment_snapshot: {
        payment_method: method,
        payment_frequency: 'monthly',
      },
    });
    assert.equal(result.schedule, 'Ongoing — Direct Debit · 12 months');
    assert.equal(result.renewalDate, null);
    assert.equal(result.endDate, '31 March 2027');
    assert.equal('paymentLabel' in result, false);
  });
}

test('adds a retained DD commencement without implying that membership is active', () => {
  const result = getMembershipHistorySchedule({
    membership_year: 'rolling',
    term_start_date: '2026-12-01',
    term_duration_months: 3,
    commitment_snapshot: {
      payment_method: 'gocardless',
      payment_frequency: 'monthly',
    },
  });
  assert.equal(
    result.schedule,
    'Ongoing — Direct Debit · From 1 December 2026 · 3 months',
  );
  assert.equal(result.renewalDate, null);
});

for (const method of ['stripe', 'card', 'monthly_card', 'card_monthly', 'stripe_monthly_card']) {
  test(`supports Stripe/card alias ${method}`, () => {
    const result = getMembershipHistorySchedule({
      payment_method: method,
      commitment_snapshot: {
        payment_frequency: method === 'stripe' || method === 'card' ? 'monthly' : null,
      },
    });
    assert.equal(result.paymentLabel, 'Monthly card payments');
  });
}

test('does not confuse a monthly billing period with payment frequency', () => {
  const result = getMembershipHistorySchedule({
    term_duration_months: 12,
    payment_method: 'stripe',
    billing_period: 'monthly',
    commitment_snapshot: { billing_period: 'monthly' },
  });
  assert.equal(result.schedule, '12 months');
  assert.equal(result.paymentLabel, 'Card payment');
});

test('strictly rejects impossible dates and malformed timestamps', () => {
  assert.equal(retainedHistoryDate('2026-02-29'), null);
  assert.equal(retainedHistoryDate('2026-13-01'), null);
  assert.equal(retainedHistoryDate('01/02/2026'), null);
  assert.equal(retainedHistoryDate('2026-02-01Tnot-a-time'), null);
  assert.equal(retainedHistoryDate(new Date('2026-02-01')), null);
  assert.equal(retainedHistoryDate('2024-02-29'), '2024-02-29');
  assert.equal(
    retainedHistoryDate('2026-02-01T23:30:00-05:00'),
    '2026-02-01',
  );
  assert.equal(historyScheduleDateLabel('bad'), null);
});

test('suppresses contradictory ranges rather than partially presenting them', () => {
  for (const dates of [
    {
      term_start_date: '2026-04-01',
      term_end_date: '2026-03-31',
    },
    {
      term_start_date: '2026-04-01',
      membership_renewal_date: '2026-04-01',
    },
    {
      term_end_date: '2027-04-01',
      membership_renewal_date: '2027-04-01',
    },
  ]) {
    const result = getMembershipHistorySchedule({
      membership_year: 'rolling',
      term_key: 'rolling:do-not-use',
      ...dates,
    });
    assert.equal(result.heading, 'Membership');
    assert.equal(result.schedule, null);
    assert.equal(result.renewalDate, null);
    assert.equal(result.endDate, null);
  }
});

test('ignores current pricing/configuration-shaped data and never assumes twelve months', () => {
  assert.deepEqual(getMembershipHistorySchedule({
    membership_year: 'rolling',
    term_key: 'rolling:no-saved-start',
    currentPricing: { billing_period: 'annual', duration_months: 12 },
    config: { term_duration_months: 12, membership_start_date: '2026-01-01' },
  }), {
    heading: 'Membership',
    schedule: null,
    renewalDate: null,
    endDate: null,
  });
});