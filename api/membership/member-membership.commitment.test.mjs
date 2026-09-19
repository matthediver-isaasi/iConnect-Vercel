import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shapePersistedCommitment,
  shapePersistedCommitments,
  enrichDirectDebitCommitments,
  enrichStripeCommitmentSchedules,
} from './member-membership.js';

test('shapes an immutable rolling commitment without live pricing substitution', () => {
  const commitment = shapePersistedCommitment({
    id: 'term-1',
    membership_source: 'personal',
    term_key: 'rolling:2026-09-15',
    term_start_date: '2026-09-15',
    term_end_date: '2027-09-14',
    membership_renewal_date: '2027-09-15',
    term_duration_months: 12,
    config_id: 'config-20',
    tier_label: 'Professional',
    final_cost: 240,
    total_with_vat: 288,
    currency: 'GBP',
    payment_method: 'stripe_monthly_card',
    payment_frequency: 'monthly',
    commitment_snapshot: {
      version: 1,
      start_mode: 'immediate',
      billing_period: 'annual',
      config: { id: 'config-20', name: '2026 Professional' },
      amounts: { final_cost: 240, total_with_vat: 288, monthly_amount: 24, currency: 'GBP' },
    },
  }, new Date('2027-01-01T00:00:00Z'));

  assert.equal(commitment.lifecycle, 'current');
  assert.equal(commitment.structureName, '2026 Professional');
  assert.equal(commitment.agreedPrice, 288);
  assert.equal(commitment.monthlyAmount, 24);
  assert.equal(commitment.billingPeriod, 'annual');
  assert.equal(commitment.paymentFrequency, 'monthly');
  assert.equal(commitment.renewalDate, '2027-09-15');
});

function scheduleDb(agreement, plan, mandate = null) {
  return { from(table) {
    const chain = {
      select() { return chain; }, eq() { return chain; }, order() { return chain; }, limit() { return chain; },
      async maybeSingle() { return { data: table === 'gocardless_mandates' ? mandate : table === 'membership_billing_agreements' ? agreement : plan }; },
      then(resolve) { return Promise.resolve({ data: [] }).then(resolve); },
    };
    return chain;
  } };
}

test('migration history and scheduled commitment expose active mandate separately from unpaid term', async () => {
  const record = { id: 'history', tenant_id: 'tenant', member_id: 'member', membership_source: 'personal',
    billing_agreement_id: 'agreement', payment_method: 'direct_debit', term_key: 'term',
    status: 'pending_payment_setup', payment_status: 'unpaid', term_start_date: '2026-10-01', term_end_date: '2027-09-30' };
  const agreement = { id: 'agreement', tenant_id: 'tenant', member_id: 'member', provider: 'gocardless',
    status: 'mandate_pending', metadata: { dd: { auto_renew: true,
      billing_request_mode: 'migration_existing_mandate', activation_rule: 'first_payment' } } };
  const plan = { id: 'plan', tenant_id: 'tenant', member_id: 'member', billing_agreement_id: 'agreement',
    provider: 'gocardless', environment: 'live', gocardless_mandate_id: 'mandate', status: 'mandate_pending' };
  const mandate = { tenant_id: 'tenant', environment: 'live', gocardless_mandate_id: 'mandate', status: 'active' };
  const commitment = shapePersistedCommitment(record, new Date('2026-09-18'));
  await enrichDirectDebitCommitments({
    db: scheduleDb(agreement, plan, mandate), tenantId: 'tenant', history: [record], commitments: [commitment],
    loadSchedule: async () => ({ canEdit: false }),
  });
  assert.equal(commitment.lifecycle, 'scheduled');
  assert.equal(record.status, 'pending_payment_setup');
  assert.equal(record.payment_status, 'unpaid');
  assert.equal(record.mandatePresentation.awaitingFirstPayment, true);
  assert.equal(commitment.mandatePresentation.mandateStatus, 'active');
  assert.ok(!commitment.collectionDetails.blockers.some(text => /awaiting an active mandate/.test(text)));
});

test('Stripe enrichment validates personal and organisation ownership before reading provider timing', async () => {
  for (const source of ['personal', 'organisation']) {
    for (const mismatch of [false, true]) {
      const owner = source === 'personal' ? { member_id: 'member' } : { organization_id: 'org' };
      const record = { id: 'history', tenant_id: 'tenant', ...owner, membership_source: source,
        billing_agreement_id: 'agreement', payment_method: 'card_monthly', term_key: 'term' };
      const agreement = { id: 'agreement', tenant_id: 'tenant', ...owner, provider: 'stripe',
        ...(mismatch ? source === 'personal' ? { member_id: 'other' } : { organization_id: 'other' } : {}) };
      const plan = { id: 'plan', tenant_id: 'tenant', ...owner, billing_agreement_id: 'agreement', provider: 'stripe' };
      const commitment = { ...shapePersistedCommitment(record), lifecycle: 'current' };
      let reads = 0;
      await enrichStripeCommitmentSchedules({
        db: scheduleDb(agreement, plan), tenantId: 'tenant', history: [record], commitments: [commitment],
        loadSchedule: async (args) => { reads++; assert.equal(args.plan.id, 'plan'); return { regularDay: 19, canEdit: false }; },
      });
      assert.equal(reads, mismatch ? 0 : 1);
      assert.equal(commitment.collectionSchedule.regularDay, mismatch ? null : 19);
    }
  }
});

test('GoCardless enrichment passes explicit server eligibility, never derives it from a payment record', async () => {
  for (const canEditSchedule of [false, true]) {
    const record = { id: 'history', tenant_id: 'tenant', member_id: 'member', membership_source: 'personal',
      billing_agreement_id: 'agreement', payment_method: 'direct_debit', term_key: 'term' };
    const agreement = { id: 'agreement', tenant_id: 'tenant', member_id: 'member', provider: 'gocardless',
      metadata: { dd: { auto_renew: true } } };
    const plan = { id: 'plan', tenant_id: 'tenant', member_id: 'member', billing_agreement_id: 'agreement' };
    const commitment = { ...shapePersistedCommitment(record), lifecycle: 'current' };
    await enrichDirectDebitCommitments({
      db: scheduleDb(agreement, plan), tenantId: 'tenant', history: [record], commitments: [commitment],
      canEditSchedule, paused: true,
      loadSchedule: async (args) => {
        assert.equal(args.canEdit, canEditSchedule);
        assert.equal(args.paused, true);
        return { regularDay: 10, canEdit: false, reason: 'Paused' };
      },
    });
    assert.equal(commitment.collectionSchedule.regularDay, 10);
    assert.equal(commitment.collectionSchedule.canEdit, false);
  }
});

test('distinguishes scheduled terms and ignores ambiguous legacy rows', () => {
  const commitments = shapePersistedCommitments([{
    id: 'legacy',
    membership_year: '2025/2026',
    final_cost: 100,
  }, {
    id: 'scheduled',
    term_key: 'rolling:2027-09-15',
    term_start_date: '2027-09-15',
    term_end_date: '2028-09-14',
    membership_renewal_date: '2028-09-15',
    term_duration_months: 12,
    status: 'scheduled',
  }], new Date('2027-01-01T00:00:00Z'));

  assert.equal(commitments.length, 1);
  assert.equal(commitments[0].id, 'scheduled');
  assert.equal(commitments[0].lifecycle, 'scheduled');
});

test('legacy Direct Debit with missing policy remains explicitly reviewable without inventing dates', () => {
  const result = shapePersistedCommitment({
    id: 'legacy-dd', billing_agreement_id: 'agreement',
    payment_method: 'direct_debit', final_cost: 120,
  });
  assert.equal(result.collectionPolicy.needs_review, true);
  assert.equal(result.collectionPolicy.end_policy, null);
  assert.equal(result.collectionPolicy.pricing_policy, 'fixed');
  assert.equal(result.startDate, null);
  assert.equal(result.endDate, null);
  assert.equal(result.agreedPrice, 120);
});

test('dynamic commitments do not fabricate fixed term totals', () => {
  const result = shapePersistedCommitment({
    id: 'dynamic', term_key: 'rolling:2026-09-18',
    payment_method: 'direct_debit',
    final_cost: 120, total_with_vat: 144,
    commitment_snapshot: {
      collection_policy: { version: 1, end_policy: 'continue', pricing_policy: 'dynamic' },
      amounts: { monthly_amount: 12, total_with_vat: 144 },
    },
  });
  assert.equal(result.collectionPolicy.pricing_policy, 'dynamic');
  assert.equal(result.agreedPrice, null);
  assert.equal(result.agreedNetPrice, null);
  assert.equal(result.monthlyAmount, null);
});

test('collection enrichment rejects an agreement owned by another tenant or member', async () => {
  for (const mismatch of [{ tenant_id: 'other' }, { member_id: 'someone-else' }]) {
    const record = {
      id: 'history', tenant_id: 'tenant', member_id: 'member',
      membership_source: 'personal', billing_agreement_id: 'agreement',
      payment_method: 'direct_debit', term_key: 'rolling:2026-09-18',
    };
    const commitment = { ...shapePersistedCommitment(record), lifecycle: 'current' };
    let reads = 0;
    const db = { from(table) {
      assert.equal(table, 'membership_billing_agreements');
      reads++;
      const chain = {
        select() { return chain; },
        eq(column, value) {
          if (column === 'tenant_id') assert.equal(value, 'tenant');
          if (column === 'id') assert.equal(value, 'agreement');
          return chain;
        },
        async maybeSingle() {
          return { data: {
            id: 'agreement', tenant_id: 'tenant', member_id: 'member', ...mismatch,
            metadata: { dd: { auto_renew: true, monthly_amount: 999 } },
          } };
        },
      };
      return chain;
    } };
    await enrichDirectDebitCommitments({
      db, tenantId: 'tenant', history: [record], commitments: [commitment],
    });
    assert.equal(reads, 1);
    assert.equal(commitment.collectionDetails.state, 'unknown');
    assert.equal(commitment.collectionDetails.amount, null);
    assert.equal(commitment.collectionPolicy.needs_review, true);
  }
});