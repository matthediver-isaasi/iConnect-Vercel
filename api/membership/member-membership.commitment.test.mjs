import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shapePersistedCommitment,
  shapePersistedCommitments,
  enrichDirectDebitCommitments,
  enrichStripeCommitmentSchedules,
  shapeLegacyCurrentMembership,
  createMemberMembershipHandler,
} from './member-membership.js';

const BNMS = 'ff2df806-b321-4254-b651-3af11fccf1db';

function legacyCurrent(overrides = {}) {
  return {
    id: '0ff50f40-15b1-567f-a4d1-c353d9342fae',
    tenant_id: BNMS,
    membership_source: 'personal',
    membership_year: '2025/2026',
    status: 'active',
    payment_status: 'paid',
    payment_method: 'upfront',
    billing_period: 'annual',
    config_id: null,
    term_start_date: null,
    term_end_date: '2026-09-29',
    membership_renewal_date: null,
    term_key: null,
    term_duration_months: null,
    commitment_snapshot: null,
    billing_agreement_id: null,
    tier_label: 'Overseas full member',
    final_cost: 109,
    total_with_vat: 109,
    currency: 'GBP',
    notes: JSON.stringify({ source: 'bnms_non_dd_current_backfill' }),
    ...overrides,
  };
}

test('recognises the narrow paid BNMS legacy current membership without inventing dates', () => {
  const result = shapeLegacyCurrentMembership(
    legacyCurrent(),
    BNMS,
    new Date('2026-09-22T12:00:00Z'),
  );
  assert.equal(result.paidAmount, 109);
  assert.equal(result.endDate, '2026-09-29');
  assert.equal(result.startDate, null);
  assert.equal(result.renewalDate, null);
  assert.equal(result.readOnly, true);
  assert.deepEqual(shapePersistedCommitments([legacyCurrent()]), []);
});

test('legacy current recognition fails closed for expired, cross-tenant, and paid-state conflicts', () => {
  const now = new Date('2026-09-22T12:00:00Z');
  assert.equal(shapeLegacyCurrentMembership(
    legacyCurrent({ term_end_date: '2026-09-21' }), BNMS, now,
  ), null);
  assert.equal(shapeLegacyCurrentMembership(
    legacyCurrent({ tenant_id: 'another-tenant' }), 'another-tenant', now,
  ), null);
  assert.equal(shapeLegacyCurrentMembership(
    legacyCurrent({ payment_status: 'unpaid' }), BNMS, now,
  ), null);
  assert.equal(shapeLegacyCurrentMembership(
    legacyCurrent({ total_with_vat: 110 }), BNMS, now,
  ), null);
  assert.equal(shapeLegacyCurrentMembership(
    legacyCurrent({ notes: JSON.stringify({ source: 'untrusted' }) }), BNMS, now,
  ), null);
});

test('operator-attested paid legacy membership preserves an unknown price rather than inventing zero', () => {
  const result = shapeLegacyCurrentMembership(
    legacyCurrent({ final_cost: null, total_with_vat: null }),
    BNMS,
    new Date('2026-09-22T12:00:00Z'),
  );
  assert.ok(result);
  assert.equal(result.paymentStatus, 'paid');
  assert.equal(result.paidAmount, null);
});

test('handler keeps live config separate while the recorded legacy price wins and no successor is simulated', async () => {
  const memberId = 'd91d8aa3-4981-4ba0-b923-ab6ccb092f9f';
  const row = legacyCurrent({ member_id: memberId });
  const db = {
    from(table) {
      let selection = '';
      const result = () => {
        if (table === 'member' && selection.startsWith('id,')) {
          return { data: {
            id: memberId,
            first_name: 'Pilot',
            last_name: 'Member',
            email: 'pilot@example.test',
            tenant_id: BNMS,
            organization_id: null,
          }, error: null };
        }
        if (table === 'member') {
          return { data: { membership_paused: false }, error: null };
        }
        if (table === 'member_membership_history') return { data: [row], error: null };
        if (['bnms_dd_alpha_membership_recognition', 'bnms_membership_recognition_beta_pilot', 'bnms_dd_manual_membership_recognition'].includes(table)) return { data: [], error: null };
        throw new Error(`Unexpected table ${table}`);
      };
      const chain = {
        select(value) { selection = value; return chain; },
        eq() { return chain; },
        order() { return chain; },
        async maybeSingle() { return result(); },
        then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
      };
      return chain;
    },
  };
  let simulations = 0;
  const handler = createMemberMembershipHandler({
    db,
    getTenantContext: async () => ({ tenantId: BNMS }),
    getSessionMember: async () => ({ id: memberId, tenant_id: BNMS }),
    hasAdminAccess: async () => true,
    getConfigForMember: async () => ({
      id: 'live-2026',
      tenant_id: BNMS,
      name: '2026-2027 Overseas full member',
      structure_scope_type: 'member',
      currency: 'GBP',
      billing_period: 'annual',
      membership_start_month: 10,
      membership_start_day: 1,
      online_card_payment: true,
      annual_cost: 999,
    }),
    simulateMembershipForMember: async () => {
      simulations++;
      return { success: true, finalCost: 999 };
    },
    enrichMembershipHistoryPrices: async () => {},
    getNow: () => new Date('2026-09-22T12:00:00Z'),
  });
  let statusCode = 200;
  let payload;
  await handler(
    { method: 'GET', query: { memberId } },
    {
      status(code) { statusCode = code; return this; },
      json(value) { payload = value; return value; },
    },
  );

  assert.equal(statusCode, 200);
  assert.equal(payload.config.source, 'live');
  assert.equal(payload.legacyCurrentMembership.paidAmount, 109);
  assert.equal(payload.legacyCurrentMembership.endDate, '2026-09-29');
  assert.equal(payload.legacyCurrentMembership.startDate, null);
  assert.equal(payload.currentYearCost, null);
  assert.equal(payload.nextYearPreview, null);
  assert.deepEqual(payload.currentCommitments, []);
  assert.equal(simulations, 0);
});

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

test('does not create a future commitment from BNMS provenance notes', () => {
  const commitments = shapePersistedCommitments([{
    id: 'bnms-current-2025',
    membership_year: '2025/2026',
    status: 'active',
    payment_status: 'paid',
    config_id: null,
    tier_label: 'Retained BNMS type',
    final_cost: 120,
    total_with_vat: 144,
    currency: 'GBP',
    term_start_date: null,
    term_end_date: '2026-09-30',
    membership_renewal_date: null,
    term_key: null,
    commitment_snapshot: null,
    billing_agreement_id: null,
    notes: JSON.stringify({
      source: 'bnms_non_dd_current_backfill',
      term_key: 'rolling:forged',
      membership_renewal_date: '2099-01-01',
      billing_agreement_id: 'forged',
    }),
  }]);

  assert.deepEqual(commitments, []);
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