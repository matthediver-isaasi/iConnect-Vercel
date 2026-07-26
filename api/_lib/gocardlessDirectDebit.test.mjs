// Tests for the pure GoCardless Direct Debit plan helpers.
// Run: node --test api/_lib/gocardlessDirectDebit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toMinorUnits,
  resolveDdOffer,
  computeFirstCollectionDate,
  buildAgreementSnapshot,
  decideMembershipActivation,
} from './gocardlessDirectDebit.js';

function flatSim(overrides = {}, configOverrides = {}) {
  return {
    success: true,
    currency: 'GBP',
    annualCost: 120,
    finalCost: 120,
    tierLabel: 'Individual',
    membershipYear: { label: '2026/27', start: '2026-04-01' },
    config: {
      id: 'cfg-1',
      pricing_model: 'flat',
      dd_enabled: true,
      dd_monthly_amount: 10,
      dd_instalment_count: 12,
      dd_first_collection_rule: 'earliest',
      dd_activation_rule: 'first_payment',
      dd_grace_days: 7,
      currency: 'GBP',
      ...configOverrides,
    },
    ...overrides,
  };
}

test('toMinorUnits', () => {
  assert.equal(toMinorUnits(10), 1000);
  assert.equal(toMinorUnits('12.34'), 1234);
  assert.equal(toMinorUnits(10.005), 1001);
  assert.equal(toMinorUnits(0), null);
  assert.equal(toMinorUnits(-5), null);
  assert.equal(toMinorUnits('abc'), null);
});

test('resolveDdOffer: flat pricing offers DD with plan totals', () => {
  const offer = resolveDdOffer(flatSim());
  assert.equal(offer.monthlyAmount, 10);
  assert.equal(offer.monthlyAmountMinor, 1000);
  assert.equal(offer.instalmentCount, 12);
  assert.equal(offer.planTotal, 120);
  assert.equal(offer.currency, 'GBP');
  assert.equal(offer.activationRule, 'first_payment');
});

test('resolveDdOffer: disabled / missing amount / failed sim return null', () => {
  assert.equal(resolveDdOffer(null), null);
  assert.equal(resolveDdOffer({ success: false }), null);
  assert.equal(resolveDdOffer(flatSim({}, { dd_enabled: false })), null);
  assert.equal(resolveDdOffer(flatSim({}, { dd_monthly_amount: null })), null);
  assert.equal(resolveDdOffer(flatSim({}, { dd_monthly_amount: 0 })), null);
});

test('resolveDdOffer: banded pricing reads band dd_monthly_amount', () => {
  const sim = flatSim(
    { matchedBand: { id: 'band-1', dd_monthly_amount: '7.50' } },
    { pricing_model: 'tiered', dd_monthly_amount: null }
  );
  const offer = resolveDdOffer(sim);
  assert.equal(offer.monthlyAmount, 7.5);
  assert.equal(offer.planTotal, 90);

  const noBand = flatSim({}, { pricing_model: 'tiered', dd_monthly_amount: 10 });
  assert.equal(resolveDdOffer(noBand), null, 'band pricing must not fall back to config amount');
});

test('resolveDdOffer: instalment count clamped to 1..12, invalid rules fall back', () => {
  const offer = resolveDdOffer(flatSim({}, {
    dd_instalment_count: 99,
    dd_first_collection_rule: 'bogus',
    dd_activation_rule: 'bogus',
  }));
  assert.equal(offer.instalmentCount, 12);
  assert.equal(offer.firstCollectionRule, 'earliest');
  assert.equal(offer.activationRule, 'first_payment');
});

test('computeFirstCollectionDate: earliest has no constraints', () => {
  assert.deepEqual(
    computeFirstCollectionDate({ rule: 'earliest' }),
    { startDate: null, dayOfMonth: null }
  );
});

test('computeFirstCollectionDate: nominated_day clamps to 1..28', () => {
  assert.deepEqual(
    computeFirstCollectionDate({ rule: 'nominated_day', collectionDay: 15 }),
    { startDate: null, dayOfMonth: 15 }
  );
  assert.equal(computeFirstCollectionDate({ rule: 'nominated_day', collectionDay: 31 }).dayOfMonth, 28);
  assert.equal(computeFirstCollectionDate({ rule: 'nominated_day', collectionDay: 0 }).dayOfMonth, 1);
});

test('computeFirstCollectionDate: anniversary picks next occurrence on/after earliest', () => {
  // Year starts on the 1st; earliest charge 2026-07-10 -> next 1st is 2026-08-01
  const r = computeFirstCollectionDate({
    rule: 'anniversary',
    membershipYearStart: '2026-04-01',
    earliestChargeDate: '2026-07-10',
  });
  assert.deepEqual(r, { startDate: '2026-08-01', dayOfMonth: 1 });

  // Same-day earliest keeps that day (not pushed a month)
  const same = computeFirstCollectionDate({
    rule: 'anniversary',
    membershipYearStart: '2026-04-15',
    earliestChargeDate: '2026-07-15',
  });
  assert.deepEqual(same, { startDate: '2026-07-15', dayOfMonth: 15 });

  // Day-of-month clamped to 28 (year starting on the 30th)
  const clamped = computeFirstCollectionDate({
    rule: 'anniversary',
    membershipYearStart: '2026-04-30',
    earliestChargeDate: '2026-07-01',
  });
  assert.equal(clamped.dayOfMonth, 28);

  // Missing year start degrades to no constraint
  assert.deepEqual(
    computeFirstCollectionDate({ rule: 'anniversary', membershipYearStart: null }),
    { startDate: null, dayOfMonth: null }
  );
});

test('buildAgreementSnapshot: captures terms and is immune to later config edits', () => {
  const sim = flatSim();
  const offer = resolveDdOffer(sim);
  const snap = buildAgreementSnapshot({ offer, simResult: sim, acceptedAt: '2026-07-01T00:00:00.000Z' });

  assert.equal(snap.kind, 'monthly_direct_debit');
  assert.equal(snap.monthly_amount, 10);
  assert.equal(snap.monthly_amount_minor, 1000);
  assert.equal(snap.instalment_count, 12);
  assert.equal(snap.plan_total, 120);
  assert.equal(snap.membership_year, '2026/27');
  assert.equal(snap.membership_year_start, '2026-04-01');
  assert.equal(snap.config_id, 'cfg-1');
  assert.equal(snap.accepted_at, '2026-07-01T00:00:00.000Z');

  // Mutating the config AFTER snapshotting must not change the snapshot.
  sim.config.dd_monthly_amount = 99;
  sim.config.dd_instalment_count = 3;
  assert.equal(snap.monthly_amount, 10);
  assert.equal(snap.instalment_count, 12);
});

test('buildAgreementSnapshot: requires an offer', () => {
  assert.throws(() => buildAgreementSnapshot({ offer: null, simResult: flatSim() }));
});

test('decideMembershipActivation: rule/trigger matrix', () => {
  // manual never auto-activates
  assert.equal(decideMembershipActivation({ activationRule: 'manual', trigger: 'mandate_active' }), false);
  assert.equal(decideMembershipActivation({ activationRule: 'manual', trigger: 'first_payment_confirmed' }), false);
  // mandate activates on mandate OR (late) first payment
  assert.equal(decideMembershipActivation({ activationRule: 'mandate', trigger: 'mandate_active' }), true);
  assert.equal(decideMembershipActivation({ activationRule: 'mandate', trigger: 'first_payment_confirmed' }), true);
  // first_payment only on confirmed payment
  assert.equal(decideMembershipActivation({ activationRule: 'first_payment', trigger: 'mandate_active' }), false);
  assert.equal(decideMembershipActivation({ activationRule: 'first_payment', trigger: 'first_payment_confirmed' }), true);
  // unknown rule defaults to first_payment behaviour
  assert.equal(decideMembershipActivation({ activationRule: undefined, trigger: 'first_payment_confirmed' }), true);
});
