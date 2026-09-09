// Tests for the pure GoCardless Direct Debit plan helpers.
// Run: node --test api/_lib/gocardlessDirectDebit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  toMinorUnits,
  resolveDdOffer,
  computeFirstCollectionDate,
  computeSubscriptionCollectionDate,
  buildAgreementSnapshot,
  buildMonthlyBillingRequest,
  monthlyBillingRequestFingerprint,
  remainingSubscriptionInstalments,
  publicDdConsentTerms,
  decideMembershipActivation,
  ensureSubscriptionForAgreement,
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

test('new monthly Bacs billing request is mandate-only and retains the full immutable schedule', () => {
  const sim = flatSim({ annualCost: 240, finalCost: 83.25 });
  const offer = resolveDdOffer(sim);
  const snapshot = buildAgreementSnapshot({
    offer,
    simResult: sim,
    acceptedAt: '2026-07-10T12:00:00.000Z',
    includeBillingRequestPayment: false,
    billingRequestMode: 'mandate_only',
  });
  const request = buildMonthlyBillingRequest({
    snapshot,
    metadata: { kind: 'monthly_direct_debit' },
  });

  assert.equal(request.paymentAmountMinor, undefined);
  assert.equal(request.paymentDescription, undefined);
  assert.equal(snapshot.billing_request_payment, undefined);
  assert.equal(snapshot.monthly_amount_minor, 1000);
  assert.equal(snapshot.instalment_count, 12);
  assert.equal(snapshot.billing_request_mode, 'mandate_only');
  assert.equal(remainingSubscriptionInstalments(snapshot), 12);
  assert.deepEqual(request.metadata, { kind: 'monthly_direct_debit' });
});

test('mandate-only request retains the snapshotted band amount despite a prorated annual total', () => {
  const sim = flatSim(
    {
      annualCost: 180,
      finalCost: 41.75,
      matchedBand: { id: 'band-1', dd_monthly_amount: '7.50' },
    },
    { pricing_model: 'tiered', dd_monthly_amount: null }
  );
  const offer = resolveDdOffer(sim);
  const snapshot = buildAgreementSnapshot({
    offer,
    simResult: sim,
    includeBillingRequestPayment: false,
    billingRequestMode: 'mandate_only',
  });
  assert.equal(buildMonthlyBillingRequest({ snapshot }).paymentAmountMinor, undefined);
  assert.equal(snapshot.monthly_amount_minor, 750);
  assert.equal(remainingSubscriptionInstalments(snapshot), 12);
});

test('legacy first-payment snapshots retain their original one-off contract', () => {
  const sim = flatSim();
  const snapshot = buildAgreementSnapshot({
    offer: resolveDdOffer(sim),
    simResult: sim,
    includeBillingRequestPayment: true,
  });
  const request = buildMonthlyBillingRequest({ snapshot });
  assert.equal(request.paymentAmountMinor, 1000);
  assert.equal(snapshot.billing_request_payment.remaining_instalments, 11);
  assert.equal(remainingSubscriptionInstalments(snapshot), 11);
  assert.match(request.paymentDescription, /first instalment of GBP 10\.00 paid now/i);
});

test('mandate-only request fails closed without a complete immutable schedule', () => {
  assert.throws(
    () => buildMonthlyBillingRequest({
      snapshot: { kind: 'monthly_direct_debit', currency: 'GBP' },
    }),
    /positive amount and collection count/,
  );
});

test('public consent terms include the immutable finite schedule and timing', () => {
  assert.deepEqual(publicDdConsentTerms({
    monthlyAmount: '7.50',
    instalmentCount: 6,
    planTotal: 45,
    currency: 'GBP',
    firstCollectionRule: 'nominated_day',
    collectionDay: 15,
  }), {
    monthlyAmount: 7.5,
    instalmentCount: 6,
    planTotal: 45,
    currency: 'GBP',
    firstCollectionRule: 'nominated_day',
    collectionDay: 15,
  });
});

test('monthly billing request idempotency follows collection terms, not annual totals', () => {
  const sim = flatSim({ annualCost: 240, finalCost: 80 });
  const first = buildAgreementSnapshot({
    offer: resolveDdOffer(sim),
    simResult: sim,
    includeBillingRequestPayment: false,
    billingRequestMode: 'mandate_only',
  });
  const annualOnlyChange = { ...first, annual_cost: 999, final_cost: 333 };
  const monthlyChange = {
    ...first,
    monthly_amount_minor: 1200,
  };
  assert.equal(
    monthlyBillingRequestFingerprint(first),
    monthlyBillingRequestFingerprint(annualOnlyChange),
  );
  assert.notEqual(
    monthlyBillingRequestFingerprint(first),
    monthlyBillingRequestFingerprint(monthlyChange),
  );
});

test('mandate-only subscription keeps the accepted first-collection timing', () => {
  const sim = flatSim();
  const snapshot = buildAgreementSnapshot({
    offer: resolveDdOffer(sim),
    simResult: sim,
    acceptedAt: '2026-07-10T12:00:00.000Z',
    includeBillingRequestPayment: false,
    billingRequestMode: 'mandate_only',
  });
  assert.deepEqual(
    computeSubscriptionCollectionDate(snapshot, '2026-07-15'),
    { startDate: null, dayOfMonth: null },
  );

  snapshot.first_collection_rule = 'nominated_day';
  snapshot.collection_day = 15;
  assert.deepEqual(
    computeSubscriptionCollectionDate(snapshot, '2026-07-15'),
    { startDate: null, dayOfMonth: 15 },
  );
});

test('anniversary subscription advances beyond a stale provider date and today', () => {
  assert.deepEqual(
    computeSubscriptionCollectionDate({
      kind: 'monthly_direct_debit',
      first_collection_rule: 'anniversary',
      membership_year_start: '2026-04-01',
    }, '2026-09-04', null, '2026-08-31'),
    { startDate: '2026-10-01', dayOfMonth: 1 },
  );
});

function makeDdDb(initial = {}) {
  const tables = Object.fromEntries(
    Object.entries(initial).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]),
  );
  const ensure = (name) => (tables[name] ||= []);

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.operation = 'select';
      this.payload = null;
    }
    select() { return this; }
    insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
    update(payload) { this.operation = 'update'; this.payload = payload; return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
    matches() { return ensure(this.table).filter((row) => this.filters.every((filter) => filter(row))); }
    run() {
      if (this.operation === 'insert') {
        const row = { id: `${this.table}-${ensure(this.table).length + 1}`, ...this.payload };
        ensure(this.table).push(row);
        return { data: [row], error: null };
      }
      if (this.operation === 'update') {
        const rows = this.matches();
        rows.forEach((row) => Object.assign(row, this.payload));
        return { data: rows.map((row) => ({ ...row })), error: null };
      }
      return { data: this.matches().map((row) => ({ ...row })), error: null };
    }
    maybeSingle() {
      const result = this.run();
      return Promise.resolve({ data: result.data[0] || null, error: result.error });
    }
    single() {
      const result = this.run();
      return Promise.resolve({ data: result.data[0] || null, error: result.error });
    }
    then(resolve, reject) {
      try { resolve(this.run()); } catch (error) { reject(error); }
    }
  }

  return {
    tables,
    from(table) { return new Query(table); },
  };
}

test('mandate activation creates one subscription containing every accepted collection', async () => {
  const sim = flatSim();
  const snapshot = buildAgreementSnapshot({
    offer: resolveDdOffer(sim),
    simResult: sim,
    acceptedAt: '2026-07-10T12:00:00.000Z',
    includeBillingRequestPayment: false,
    billingRequestMode: 'mandate_only',
  });
  snapshot.first_collection_rule = 'anniversary';
  snapshot.membership_year_start = '2026-04-01';
  const agreement = {
    id: 'agreement-1',
    tenant_id: 'tenant-1',
    member_id: 'member-1',
    organization_id: null,
    gocardless_mandate_id: 'mandate-1',
    metadata: { dd: snapshot },
  };
  const db = makeDdDb({
    membership_payment_plans: [],
    membership_payment_status_history: [],
    gocardless_mandates: [{
      gocardless_mandate_id: 'mandate-1',
      next_possible_charge_date: '2026-08-12',
    }],
    gocardless_payments: [],
  });
  const subscriptionCalls = [];
  const gc = {
    getGocardlessEnvironment: () => 'sandbox',
    gocardlessForTenant: async () => ({
      getMandate: async () => ({
        id: 'mandate-1',
        status: 'active',
        next_possible_charge_date: '2026-09-04',
      }),
      createSubscription: async (args) => {
        subscriptionCalls.push(args);
        return { id: 'subscription-1', start_date: args.startDate };
      },
    }),
  };

  const now = () => new Date('2026-08-31T00:00:00.000Z');
  const first = await ensureSubscriptionForAgreement(agreement, { db, gc, now });
  const second = await ensureSubscriptionForAgreement(agreement, { db, gc, now });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(subscriptionCalls.length, 1);
  assert.equal(subscriptionCalls[0].amountMinor, 1000);
  assert.equal(subscriptionCalls[0].count, 12);
  assert.equal(subscriptionCalls[0].startDate, '2026-10-01');
  assert.equal(subscriptionCalls[0].dayOfMonth, 1);
  assert.equal(db.tables.membership_payment_plans[0].instalments_total, 12);
  assert.equal(db.tables.gocardless_mandates[0].next_possible_charge_date, '2026-09-04');
  assert.equal(db.tables.gocardless_payments.length, 0);
});

test('all membership setup routes share the snapshotted monthly request contract', async () => {
  const routes = await Promise.all([
    readFile(new URL('../membership/direct-debit.js', import.meta.url), 'utf8'),
    readFile(new URL('../membership/org-direct-debit.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/dd-invitations/[token].js', import.meta.url), 'utf8'),
    readFile(new URL('../public/membership-fees/[token].js', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/components/forms/MembershipPaymentField.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/pages/MembershipFeePage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/pages/DirectDebitInvitationPage.jsx', import.meta.url), 'utf8'),
  ]);
  for (const source of routes.slice(0, 4)) {
    assert.match(source, /buildMonthlyBillingRequest\s*\(/);
  }
  for (const source of [routes[0], routes[1], routes[3]]) {
    assert.match(source, /monthlyBillingRequestFingerprint\s*\(\s*snapshot\s*\)/);
    assert.match(source, /billingRequest\.id/);
    assert.match(source, /includeBillingRequestPayment:\s*false/);
    assert.match(source, /billingRequestMode:\s*reusable\s*\?\s*'reused_mandate'\s*:\s*'mandate_only'/);
  }
  assert.match(routes[2], /monthlyBillingRequestFingerprint\s*\(\s*snap\s*\)/);
  assert.match(routes[2], /buildMonthlyBillingRequest\s*\(\s*\{\s*snapshot:\s*snap/s);
  assert.match(routes[2], /publicDdConsentTerms\s*\(/);
  assert.match(routes[3], /publicDdConsentTerms\s*\(/);
  assert.match(routes[4], /If a new bank setup is needed/);
  assert.match(routes[4], /If an existing Direct Debit can be reused/);
  assert.match(routes[4], /finite schedule/);
  assert.doesNotMatch(routes[4], /first instalment.*paid immediately/s);
  for (const source of routes.slice(5)) {
    assert.match(source, /directDebitFirstCollectionText\s*\(/);
    assert.match(source, /text-dd-first-collection/);
  }
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

