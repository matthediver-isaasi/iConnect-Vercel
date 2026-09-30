import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveStructureCollectionPolicy, resolveSavedCollectionPolicy, describeCollectionPolicy } from '../../shared/gocardlessCollectionPolicy.js';
import { resolveDdOffer, buildAgreementSnapshot, monthlyBillingRequestFingerprint, isMonthlyConsentPolicyCurrent, newDdConsentScheduleError } from './gocardlessDirectDebit.js';
import { shouldSuppressAnnualInvoice } from './membershipInstalmentInvoicing.js';
import { decideRenewalAction } from './gocardlessDdRenewals.js';
import { assertMonthlyCollectionsWithinTerm } from './rollingMonthlyRenewal.js';

function simulation(endPolicy, pricingPolicy, startMode = 'immediate') {
  return {
    success: true, currency: 'GBP', annualCost: 120, finalCost: 120, vatRatePercent: 0,
    config: {
      id: 'structure', structure_scope_type: 'member', start_mode: startMode, billing_period: 'annual',
      pricing_model: 'flat', dd_enabled: true, dd_monthly_amount: 10, dd_instalment_count: 12,
      dd_policy_version: 1, dd_collection_end_policy: endPolicy, dd_pricing_policy: pricingPolicy,
      dd_invoicing_mode: pricingPolicy === 'dynamic' ? 'per_instalment' : 'annual',
    },
    membershipYear: { label: startMode === 'immediate' ? 'rolling:2026-09-18' : '2026/2027', start: '2026-09-18', end: '2027-09-17' },
  };
}

for (const endPolicy of ['stop', 'continue']) {
  for (const pricingPolicy of ['fixed', 'dynamic']) {
    test(`${pricingPolicy} + ${endPolicy}: immutable consent, term boundary and renewal authority`, () => {
      const sim = simulation(endPolicy, pricingPolicy);
      const offer = resolveDdOffer(sim);
      const snapshot = buildAgreementSnapshot({ offer, simResult: sim });
      assert.deepEqual(snapshot.collection_policy, { version: 1, end_policy: endPolicy, pricing_policy: pricingPolicy });
      assert.deepEqual(snapshot.commitment.commitment_snapshot.collection_policy, snapshot.collection_policy);
      assert.equal(snapshot.monthly_amount, 10);
      assert.equal(snapshot.plan_total, pricingPolicy === 'dynamic' ? null : 120);
      assert.equal(snapshot.commitment.commitment_snapshot.amounts.total_with_vat, pricingPolicy === 'dynamic' ? null : 120);
      const fingerprint = monthlyBillingRequestFingerprint(snapshot);
      sim.config.dd_monthly_amount = 50;
      sim.config.dd_collection_end_policy = endPolicy === 'continue' ? 'stop' : 'continue';
      sim.config.dd_pricing_policy = pricingPolicy === 'fixed' ? 'dynamic' : 'fixed';
      sim.config.dd_invoicing_mode = 'per_instalment';
      assert.equal(snapshot.monthly_amount, 10);
      assert.equal(monthlyBillingRequestFingerprint(snapshot), fingerprint);
      assert.equal(isMonthlyConsentPolicyCurrent({ metadata: { dd: snapshot } }, resolveDdOffer(sim)), false);
      assert.doesNotThrow(() => assertMonthlyCollectionsWithinTerm(snapshot, '2026-09-23', 12));
      assert.throws(() => assertMonthlyCollectionsWithinTerm(snapshot, '2026-10-23', 12), /outside/);
      const action = decideRenewalAction({
        snapshot, planStatus: 'active', autoRenew: endPolicy !== 'continue',
        renewalRow: { status: 'notice_sent', mode: 'auto' }, today: new Date('2027-09-18'),
      });
      assert.equal(action.action, endPolicy === 'continue' ? 'renew_auto' : 'await_confirmation');
      assert.ok(describeCollectionPolicy(resolveSavedCollectionPolicy(snapshot)).length > 20);
    });
  }
}

test('legacy authority requires an explicit saved boolean; later settings are not evidence', () => {
  assert.equal(resolveSavedCollectionPolicy({ auto_renew: true }).end_policy, 'continue');
  assert.equal(resolveSavedCollectionPolicy({ auto_renew: false }).end_policy, 'stop');
  assert.equal(resolveSavedCollectionPolicy({ auto_renew: 'true' }).needs_review, true);
  assert.equal(resolveSavedCollectionPolicy(null).needs_review, true);
  assert.equal(resolveSavedCollectionPolicy({ config: { dd_auto_renew: true } }).needs_review, true);
  assert.equal(resolveSavedCollectionPolicy({ auto_renew: true, collection_policy: { version: 99 } }).needs_review, true);
  assert.throws(() => resolveStructureCollectionPolicy({ dd_policy_version: 1, dd_collection_end_policy: 'continue', dd_pricing_policy: 'dynamic' }), /per-instalment/);
  const action = decideRenewalAction({ snapshot: { kind: 'monthly_direct_debit', membership_year_start: '2026-01-01' }, planStatus: 'active', autoRenew: true, today: new Date('2027-01-01') });
  assert.equal(action.action, 'none');
  assert.match(action.reason, /review/);
});

test('fixed-date DD snapshots retain the exact saved calendar term, separate from collection authority', () => {
  const sim = simulation('continue', 'fixed', 'fixed_date');
  const snapshot = buildAgreementSnapshot({ offer: resolveDdOffer(sim), simResult: sim });
  assert.equal(snapshot.commitment.term_key, 'fixed:2026-09-18');
  assert.equal(snapshot.commitment.term_end_date, '2027-09-17');
  assert.equal(snapshot.commitment.membership_renewal_date, '2027-09-18');
  assert.equal(snapshot.commitment.commitment_snapshot.config.start_mode, 'fixed_date');
});

test('fixed-date successors preserve their original anchor across multiple terms', () => {
  for (const pricing of ['fixed', 'dynamic']) {
    const sim = simulation('continue', pricing, 'fixed_date');
    const first = buildAgreementSnapshot({ offer: resolveDdOffer(sim), simResult: sim });
    assert.equal(first.commitment.term_anchor_date, '2026-09-18');
    let previous = first.commitment;
    for (const year of [2027, 2028]) {
      sim.previousTerm = { ...previous, id: `history-${year - 1}` };
      sim.membershipYear = {
        label: `${year}/${year + 1}`, start: `${year}-09-18`, end: `${year + 1}-09-17`,
      };
      const next = buildAgreementSnapshot({ offer: resolveDdOffer(sim), simResult: sim });
      assert.equal(next.commitment.term_anchor_date, '2026-09-18');
      assert.equal(next.commitment.term_start_date, `${year}-09-18`);
      assert.equal(next.commitment.membership_renewal_date, `${year + 1}-09-18`);
      assert.equal(next.commitment.previous_term_id, `history-${year - 1}`);
      assert.equal(previous.term_anchor_date, '2026-09-18');
      previous = next.commitment;
    }
  }
});

test('new fixed consent rejects a midterm impossible schedule before provider setup; legacy stays unchanged', () => {
  const sim = simulation('stop', 'fixed', 'fixed_date');
  const snapshot = buildAgreementSnapshot({ offer: resolveDdOffer(sim), simResult: sim });
  assert.equal(newDdConsentScheduleError(snapshot, new Date('2026-09-18')), null);
  assert.equal(newDdConsentScheduleError(snapshot, new Date('2027-03-01')).code, 'DD_SCHEDULE_OUTSIDE_TERM');
  const legacy = { ...snapshot };
  delete legacy.collection_policy;
  assert.equal(newDdConsentScheduleError(legacy, new Date('2027-03-01')), null);
  snapshot.instalment_count = 1;
  snapshot.first_collection_rule = 'nominated_day';
  snapshot.collection_day = 20;
  assert.equal(newDdConsentScheduleError(snapshot, new Date('2027-09-16')).code, 'DD_SCHEDULE_OUTSIDE_TERM');
});

test('dynamic consent needs a future eligible collection, not a fictitious fixed term count; null totals suppress annual invoices', async () => {
  const sim = simulation('continue', 'dynamic', 'fixed_date');
  const snapshot = buildAgreementSnapshot({ offer: resolveDdOffer(sim), simResult: sim });
  assert.equal(newDdConsentScheduleError(snapshot, new Date('2027-03-01')), null);
  assert.equal(newDdConsentScheduleError(snapshot, new Date('2027-09-18')).code, 'DD_SCHEDULE_OUTSIDE_TERM');
  const db = { from: (table) => {
    assert.equal(table, 'membership_billing_agreements');
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { id: 'agreement', metadata: { dd: snapshot } } }) };
    return query;
  } };
  assert.equal(snapshot.final_cost, null);
  assert.equal(snapshot.total_with_vat, null);
  assert.equal(await shouldSuppressAnnualInvoice({ billing_agreement_id: 'agreement', total_with_vat: null }, { db }), true);
});

test('all new monthly mandate entrypoints reject impossible terms before creating a provider request', () => {
  for (const [path, marker] of [
    ['../membership/direct-debit.js', 'let snapshot ='],
    ['../membership/org-direct-debit.js', 'let snapshot ='],
    ['../public/membership-fees/[token].js', 'let snapshot = unstartedAgreement?.metadata?.dd'],
    ['../public/form-payment.js', 'async function handleCreateMonthlyDirectDebit('],
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const start = source.indexOf(marker);
    assert.ok(start >= 0, path);
    const section = source.slice(start);
    const validation = section.indexOf('newDdConsentScheduleError(');
    const providerCall = section.indexOf('.createBillingRequest(');
    assert.ok(validation >= 0 && providerCall > validation, path);
    assert.match(section.slice(validation, providerCall), /status\(400\)\.json\(scheduleError\)/);
  }
});