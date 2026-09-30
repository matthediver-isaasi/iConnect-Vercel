// GoCardless Phase 5 — renewal decision logic tests.
// Run: node --test api/_lib/gocardlessDdRenewals.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveNextYearLabel,
  computeRenewalWindow,
  decideRenewalAction,
  RENEWAL_NOTICE_DAYS,
  buildDdRenewalSnapshot,
} from './gocardlessDdRenewals.js';
import { STATUS } from './gocardlessState.js';
import { BNMS_PILOT_ACCOUNTING } from './xero.js';
import { buildAgreementSnapshot } from './gocardlessDirectDebit.js';

function pilotRenewalFixture() {
  return {
    previousAgreement: {
      tenant_id: 'ff2df806-b321-4254-b651-3af11fccf1db',
      member_id: '33e5d54d-162e-436d-9bff-ec6676d198f9', provider: 'gocardless', environment: 'live',
      metadata: { dd: {
        accounting_migration: { ...BNMS_PILOT_ACCOUNTING },
        first_collection_rule: 'nominated_day', collection_day: 1,
        currency: 'GBP', invoicing_mode: 'per_instalment',
        collection_policy: { version: 1, pricing_policy: 'dynamic', end_policy: 'continue' },
      } },
    },
    offer: {
      collectionPolicy: { version: 1, pricing_policy: 'dynamic', end_policy: 'continue' },
      monthlyAmount: 15, monthlyAmountMinor: 1500, instalmentCount: 12, planTotal: 180,
      currency: 'GBP', firstCollectionRule: 'earliest', collectionDay: null, invoicingMode: 'per_instalment',
    },
    simResult: {
      config: { id: 'structure', start_mode: 'immediate', billing_period: 'annual',
        dd_first_collection_rule: 'earliest', dd_collection_day: null },
      membershipYear: { start: '2027-10-01', end: '2028-09-30', label: 'rolling:2027-10-01' },
      annualCost: 180, vatRatePercent: 0,
    },
    acceptedAt: '2027-10-01T00:00:00.000Z',
  };
}

test('pilot renewal preserves exact mapping and nominated day 1 while restamping dynamic price and term', () => {
  const args = pilotRenewalFixture();
  const original = structuredClone(args);
  const snapshot = buildDdRenewalSnapshot(args);
  assert.deepEqual(snapshot.accounting_migration, BNMS_PILOT_ACCOUNTING);
  assert.notEqual(snapshot.accounting_migration, args.previousAgreement.metadata.dd.accounting_migration);
  assert.equal(snapshot.first_collection_rule, 'nominated_day');
  assert.equal(snapshot.collection_day, 1);
  assert.equal(snapshot.monthly_amount_minor, 1500);
  assert.equal(snapshot.commitment.term_start_date, '2027-10-01');
  assert.equal(snapshot.commitment.term_end_date, '2028-09-30');
  assert.equal(snapshot.collection_policy.pricing_policy, 'dynamic');
  assert.equal(snapshot.collection_policy.end_policy, 'continue');
  assert.deepEqual(args, original, 'shared config/offer and prior snapshot stay untouched');
  args.previousAgreement.metadata.dd = snapshot;
  const second = buildDdRenewalSnapshot(args);
  assert.deepEqual(second.accounting_migration, BNMS_PILOT_ACCOUNTING);
  assert.equal(second.collection_day, 1);
});

test('nonpilot renewal keeps existing shared configuration behaviour unchanged', () => {
  const args = pilotRenewalFixture();
  delete args.previousAgreement.metadata.dd.accounting_migration;
  assert.deepEqual(buildDdRenewalSnapshot(args), buildAgreementSnapshot(args));
  assert.equal(buildDdRenewalSnapshot(args).first_collection_rule, 'earliest');
  assert.equal(buildDdRenewalSnapshot(args).collection_day, null);
});

for (const [label, change] of [
  ['tenant', a => { a.previousAgreement.tenant_id = 'other'; }],
  ['member', a => { a.previousAgreement.member_id = 'other'; }],
  ['environment', a => { a.previousAgreement.environment = 'sandbox'; }],
  ['provider', a => { a.previousAgreement.provider = 'stripe'; }],
  ['mapping', a => { a.previousAgreement.metadata.dd.accounting_migration.bank_account_id = 'other'; }],
  ['day', a => { a.previousAgreement.metadata.dd.collection_day = 2; }],
  ['rule', a => { a.previousAgreement.metadata.dd.first_collection_rule = 'earliest'; }],
  ['prior policy', a => { a.previousAgreement.metadata.dd.collection_policy.pricing_policy = 'fixed'; }],
  ['new policy', a => { a.offer.collectionPolicy.end_policy = 'stop'; }],
  ['new currency', a => { a.offer.currency = 'EUR'; }],
  ['new invoice mode', a => { a.offer.invoicingMode = 'annual'; }],
]) {
  test(`pilot renewal fails closed for invalid ${label}`, () => {
    const args = pilotRenewalFixture();
    change(args);
    assert.throws(() => buildDdRenewalSnapshot(args), /BNMS pilot/);
  });
}

// ---------------------------------------------------------------------------
// deriveNextYearLabel

test('deriveNextYearLabel handles slash short form', () => {
  assert.equal(deriveNextYearLabel('2026/27'), '2027/28');
});

test('deriveNextYearLabel handles dash short form', () => {
  assert.equal(deriveNextYearLabel('2026-27'), '2027-28');
});

test('deriveNextYearLabel handles long forms', () => {
  assert.equal(deriveNextYearLabel('2026/2027'), '2027/2028');
  assert.equal(deriveNextYearLabel('2026-2027'), '2027-2028');
});

test('deriveNextYearLabel handles plain year', () => {
  assert.equal(deriveNextYearLabel('2026'), '2027');
});

test('deriveNextYearLabel pads century rollover short form', () => {
  assert.equal(deriveNextYearLabel('2098/99'), '2099/00');
});

test('deriveNextYearLabel returns null for garbage', () => {
  assert.equal(deriveNextYearLabel('banana'), null);
  assert.equal(deriveNextYearLabel(''), null);
  assert.equal(deriveNextYearLabel(null), null);
  assert.equal(deriveNextYearLabel(undefined), null);
});

// ---------------------------------------------------------------------------
// computeRenewalWindow

test('computeRenewalWindow derives year end + notice date', () => {
  const w = computeRenewalWindow({ membership_year_start: '2026-04-01' });
  assert.equal(w.yearEnd.toISOString().slice(0, 10), '2027-04-01');
  const expectedNotice = new Date(w.yearEnd.getTime() - RENEWAL_NOTICE_DAYS * 86_400_000);
  assert.equal(w.noticeDate.getTime(), expectedNotice.getTime());
});

test('computeRenewalWindow honours custom notice days', () => {
  const w = computeRenewalWindow({ membership_year_start: '2026-04-01' }, 10);
  assert.equal((w.yearEnd - w.noticeDate) / 86_400_000, 10);
});

test('computeRenewalWindow returns null without a start date', () => {
  assert.equal(computeRenewalWindow({}), null);
  assert.equal(computeRenewalWindow(null), null);
  assert.equal(computeRenewalWindow({ membership_year_start: 'not-a-date' }), null);
});

// ---------------------------------------------------------------------------
// decideRenewalAction

const SNAP = { kind: 'monthly_direct_debit', auto_renew: true, membership_year: '2026/27', membership_year_start: '2026-04-01' };
const beforeNotice = new Date('2027-01-01T00:00:00Z');
const inNotice = new Date('2027-03-15T00:00:00Z');   // after notice (2027-03-02), before year end
const afterYearEnd = new Date('2027-04-02T00:00:00Z');

test('non-DD snapshot -> none', () => {
  const d = decideRenewalAction({ snapshot: { kind: 'other' }, planStatus: STATUS.ACTIVE, autoRenew: true, renewalRow: null, today: inNotice });
  assert.equal(d.action, 'none');
});

test('non-renewable plan status -> none', () => {
  for (const status of ['cancelled', 'suspended', null]) {
    const d = decideRenewalAction({ snapshot: SNAP, planStatus: status, autoRenew: true, renewalRow: null, today: inNotice });
    assert.equal(d.action, 'none', `status ${status}`);
  }
});

test('before notice window -> none', () => {
  const d = decideRenewalAction({ snapshot: SNAP, planStatus: STATUS.ACTIVE, autoRenew: true, renewalRow: null, today: beforeNotice });
  assert.equal(d.action, 'none');
});

test('in notice window, no row -> send_notice with mode from saved authority', () => {
  const auto = decideRenewalAction({ snapshot: SNAP, planStatus: STATUS.ACTIVE, autoRenew: true, renewalRow: null, today: inNotice });
  assert.deepEqual({ action: auto.action, mode: auto.mode }, { action: 'send_notice', mode: 'auto' });
  const confirm = decideRenewalAction({ snapshot: { ...SNAP, auto_renew: false }, planStatus: STATUS.EXPIRED, autoRenew: true, renewalRow: null, today: inNotice });
  assert.deepEqual({ action: confirm.action, mode: confirm.mode }, { action: 'send_notice', mode: 'confirm' });
});

test('next year already recorded elsewhere -> none (never a parallel charge)', () => {
  const d = decideRenewalAction({ snapshot: SNAP, planStatus: STATUS.ACTIVE, autoRenew: true, renewalRow: null, hasNextYearRecord: true, today: inNotice });
  assert.equal(d.action, 'none');
});

test('notice sent, before year end -> none (waiting)', () => {
  const d = decideRenewalAction({
    snapshot: SNAP, planStatus: STATUS.ACTIVE, autoRenew: true,
    renewalRow: { status: 'notice_sent', mode: 'auto' }, today: inNotice,
  });
  assert.equal(d.action, 'none');
});

test('notice sent, after year end, auto mode -> renew_auto', () => {
  const d = decideRenewalAction({
    snapshot: SNAP, planStatus: STATUS.EXPIRED, autoRenew: true,
    renewalRow: { status: 'notice_sent', mode: 'auto' }, today: afterYearEnd,
  });
  assert.equal(d.action, 'renew_auto');
});

test('notice sent, after year end, confirm mode -> await_confirmation', () => {
  const d = decideRenewalAction({
    snapshot: SNAP, planStatus: STATUS.EXPIRED, autoRenew: false,
    renewalRow: { status: 'notice_sent', mode: 'confirm' }, today: afterYearEnd,
  });
  assert.equal(d.action, 'await_confirmation');
});

test('terminal renewal rows -> none (idempotent)', () => {
  for (const status of ['renewed', 'confirmed', 'declined', 'failed']) {
    const d = decideRenewalAction({
      snapshot: SNAP, planStatus: STATUS.EXPIRED, autoRenew: true,
      renewalRow: { status, mode: 'auto' }, today: afterYearEnd,
    });
    assert.equal(d.action, 'none', `renewal status ${status}`);
  }
});
