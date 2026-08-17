// Task #3621 — Stripe monthly-card renewal engine tests.
// Run: node --test api/_lib/stripeCardRenewals.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRenewalAction } from './gocardlessDdRenewals.js';
import {
  resolveCardAutoRenew,
  pickReusablePaymentMethod,
  buildRenewalSubscriptionParams,
  findReusableCardPaymentMethod,
  executeCardAutoRenewal,
} from './stripeCardRenewals.js';
import { CARD_PLAN_KIND } from './stripeMonthlyCard.js';
import { STATUS } from './gocardlessState.js';

// ---------------------------------------------------------------------------
// decideRenewalAction with expectedKind='monthly_card'

const CARD_SNAP = { kind: 'monthly_card', membership_year: '2026/27', membership_year_start: '2026-04-01' };
const inNotice = new Date('2027-03-15T00:00:00Z');
const afterYearEnd = new Date('2027-04-02T00:00:00Z');

test('card snapshot rejected by default DD kind', () => {
  const d = decideRenewalAction({ snapshot: CARD_SNAP, planStatus: STATUS.ACTIVE, autoRenew: true, renewalRow: null, today: inNotice });
  assert.equal(d.action, 'none');
});

test('card snapshot accepted with expectedKind monthly_card', () => {
  const d = decideRenewalAction({ snapshot: CARD_SNAP, planStatus: STATUS.ACTIVE, autoRenew: true, renewalRow: null, today: inNotice, expectedKind: CARD_PLAN_KIND });
  assert.deepEqual({ action: d.action, mode: d.mode }, { action: 'send_notice', mode: 'auto' });
});

test('DD snapshot rejected when expecting monthly_card', () => {
  const d = decideRenewalAction({ snapshot: { ...CARD_SNAP, kind: 'monthly_direct_debit' }, planStatus: STATUS.ACTIVE, autoRenew: true, renewalRow: null, today: inNotice, expectedKind: CARD_PLAN_KIND });
  assert.equal(d.action, 'none');
});

test('card renewal auto-executes after year end (notice sent, auto mode)', () => {
  const d = decideRenewalAction({
    snapshot: CARD_SNAP, planStatus: STATUS.EXPIRED, autoRenew: true,
    renewalRow: { status: 'notice_sent', mode: 'auto' }, today: afterYearEnd, expectedKind: CARD_PLAN_KIND,
  });
  assert.equal(d.action, 'renew_auto');
});

test('card renewal awaits confirmation after year end (confirm mode)', () => {
  const d = decideRenewalAction({
    snapshot: CARD_SNAP, planStatus: STATUS.EXPIRED, autoRenew: false,
    renewalRow: { status: 'notice_sent', mode: 'confirm' }, today: afterYearEnd, expectedKind: CARD_PLAN_KIND,
  });
  assert.equal(d.action, 'await_confirmation');
});

test('card renewal blocked by next-year record from another method', () => {
  const d = decideRenewalAction({
    snapshot: CARD_SNAP, planStatus: STATUS.EXPIRED, autoRenew: true,
    renewalRow: { status: 'notice_sent', mode: 'auto' }, hasNextYearRecord: true,
    today: afterYearEnd, expectedKind: CARD_PLAN_KIND,
  });
  assert.equal(d.action, 'none');
});

test('DD decision behaviour unchanged (default expectedKind)', () => {
  const SNAP = { kind: 'monthly_direct_debit', membership_year: '2026/27', membership_year_start: '2026-04-01' };
  const d = decideRenewalAction({ snapshot: SNAP, planStatus: STATUS.ACTIVE, autoRenew: false, renewalRow: null, today: inNotice });
  assert.deepEqual({ action: d.action, mode: d.mode }, { action: 'send_notice', mode: 'confirm' });
});

// ---------------------------------------------------------------------------
// resolveCardAutoRenew — card plans share the tier's dd_auto_renew knob.

test('resolveCardAutoRenew reads live config first', () => {
  assert.equal(resolveCardAutoRenew({ success: true, config: { dd_auto_renew: false } }, { auto_renew: true }), false);
  assert.equal(resolveCardAutoRenew({ success: true, config: { dd_auto_renew: true } }, {}), true);
});

test('resolveCardAutoRenew falls back to snapshot then defaults true', () => {
  assert.equal(resolveCardAutoRenew(null, { auto_renew: false }), false);
  assert.equal(resolveCardAutoRenew({ success: false }, {}), true);
  assert.equal(resolveCardAutoRenew({ success: true, config: {} }, { auto_renew: false }), false);
});

// ---------------------------------------------------------------------------
// pickReusablePaymentMethod

test('prefers the customer default card', () => {
  const customer = { invoice_settings: { default_payment_method: 'pm_default' } };
  const pms = [{ id: 'pm_other', type: 'card' }, { id: 'pm_default', type: 'card' }];
  assert.equal(pickReusablePaymentMethod(customer, pms), 'pm_default');
});

test('falls back to first card when default missing from list', () => {
  const customer = { invoice_settings: { default_payment_method: 'pm_gone' } };
  const pms = [{ id: 'pm_a', type: 'card' }];
  assert.equal(pickReusablePaymentMethod(customer, pms), 'pm_a');
});

test('handles expanded default payment method object', () => {
  const customer = { invoice_settings: { default_payment_method: { id: 'pm_x' } } };
  assert.equal(pickReusablePaymentMethod(customer, [{ id: 'pm_x', type: 'card' }]), 'pm_x');
});

test('returns null for deleted customer or no cards', () => {
  assert.equal(pickReusablePaymentMethod({ deleted: true }, [{ id: 'pm', type: 'card' }]), null);
  assert.equal(pickReusablePaymentMethod({}, []), null);
  assert.equal(pickReusablePaymentMethod({}, [{ id: 'pm_sepa', type: 'sepa_debit' }]), null);
  assert.equal(pickReusablePaymentMethod(null, [{ id: 'pm', type: 'card' }]), null);
});

// ---------------------------------------------------------------------------
// buildRenewalSubscriptionParams

const OFFER = { monthlyAmount: 25, monthlyAmountMinor: 2500, instalmentCount: 12, planTotal: 300, currency: 'GBP' };

test('renewal subscription params are off-session, hard-fail, finite', () => {
  const now = new Date('2027-04-02T00:00:00Z');
  const p = buildRenewalSubscriptionParams({
    customerId: 'cus_1', paymentMethodId: 'pm_1', offer: OFFER,
    tenantId: 't1', memberId: 'm1', yearLabel: '2027/28', previousAgreementId: 'agree-prev', now,
  });
  assert.equal(p.customer, 'cus_1');
  assert.equal(p.default_payment_method, 'pm_1');
  assert.equal(p.off_session, true);
  assert.equal(p.payment_behavior, 'error_if_incomplete');
  assert.equal(p.items[0].price_data.unit_amount, 2500);
  assert.equal(p.items[0].price_data.currency, 'gbp');
  assert.equal(p.metadata.kind, CARD_PLAN_KIND);
  assert.equal(p.metadata.membership_year, '2027/28');
  assert.equal(p.metadata.renewal_of_agreement_id, 'agree-prev');
  // cancel_at: now + (N-1) months + 15 days — before an (N+1)th invoice.
  const cancelAt = new Date(p.cancel_at * 1000);
  const expected = new Date(Date.UTC(2028, 2, 17)); // 2027-04-02 + 11 months + 15 days
  assert.equal(cancelAt.toISOString().slice(0, 10), expected.toISOString().slice(0, 10));
});

// ---------------------------------------------------------------------------
// findReusableCardPaymentMethod

function fakeStripe({ customer, pms = [], failRetrieve = false } = {}) {
  return {
    customers: {
      retrieve: async () => {
        if (failRetrieve) throw new Error('No such customer');
        return customer;
      },
    },
    paymentMethods: { list: async () => ({ data: pms }) },
  };
}

test('findReusableCardPaymentMethod returns customer + default card', async () => {
  const stripe = fakeStripe({
    customer: { id: 'cus_1', invoice_settings: { default_payment_method: 'pm_1' } },
    pms: [{ id: 'pm_1', type: 'card' }],
  });
  const r = await findReusableCardPaymentMethod({ stripe, previousAgreement: { stripe_customer_id: 'cus_1' } });
  assert.deepEqual(r, { customerId: 'cus_1', paymentMethodId: 'pm_1' });
});

test('findReusableCardPaymentMethod null when no saved customer / deleted / no cards / retrieve fails', async () => {
  assert.equal(await findReusableCardPaymentMethod({ stripe: fakeStripe({}), previousAgreement: {} }), null);
  assert.equal(await findReusableCardPaymentMethod({
    stripe: fakeStripe({ customer: { deleted: true } }), previousAgreement: { stripe_customer_id: 'cus_1' },
  }), null);
  assert.equal(await findReusableCardPaymentMethod({
    stripe: fakeStripe({ customer: { id: 'cus_1' }, pms: [] }), previousAgreement: { stripe_customer_id: 'cus_1' },
  }), null);
  assert.equal(await findReusableCardPaymentMethod({
    stripe: fakeStripe({ failRetrieve: true }), previousAgreement: { stripe_customer_id: 'cus_1' },
  }), null);
});

// ---------------------------------------------------------------------------
// executeCardAutoRenewal — failure paths never create local records.

function makeDbSpy() {
  const inserts = [];
  const db = {
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: null, error: null }),
        insert(row) {
          inserts.push({ table, row });
          return {
            select() {
              return { single: async () => ({ data: { id: 'new-agree', ...row }, error: null }) };
            },
          };
        },
        upsert(row) {
          inserts.push({ table, row, upsert: true });
          return { select() { return { maybeSingle: async () => ({ data: row, error: null }) }; } };
        },
      };
    },
  };
  return { db, inserts };
}

const PREV_AGREEMENT = {
  id: 'agree-prev',
  stripe_customer_id: 'cus_1',
  environment: 'test',
  tenant_id: 't1',
  member_id: 'm1',
  metadata: { card: { kind: 'monthly_card', membership_year: '2026/27' } },
};

const SIM_OK = {
  success: true,
  membershipYear: { label: '2027/28', start: '2027-04-01' },
  config: { id: 'cfg', card_monthly_enabled: true, dd_monthly_amount: 25, dd_instalment_count: 12, pricing_model: 'flat', dd_auto_renew: true },
  currency: 'GBP',
  tierLabel: 'Standard',
  annualCost: 300,
};

test('executeCardAutoRenewal fails (no records) when no reusable card', async () => {
  const { db, inserts } = makeDbSpy();
  const outcome = await executeCardAutoRenewal({
    tenantId: 't1', memberId: 'm1', previousAgreement: PREV_AGREEMENT, renewalRow: null,
    deps: {
      db,
      simulate: async () => SIM_OK,
      getStripe: async () => ({ stripe: fakeStripe({ customer: { id: 'cus_1' }, pms: [] }), environment: 'test' }),
      sendEmail: async () => ({ sent: true }),
    },
  });
  assert.equal(outcome.renewed, false);
  assert.equal(outcome.failed, true);
  assert.equal(inserts.length, 0);
});

test('executeCardAutoRenewal fails (no records) when off-session charge setup throws', async () => {
  const { db, inserts } = makeDbSpy();
  const stripe = fakeStripe({
    customer: { id: 'cus_1', invoice_settings: { default_payment_method: 'pm_1' } },
    pms: [{ id: 'pm_1', type: 'card' }],
  });
  stripe.subscriptions = { create: async () => { throw new Error('Your card was declined.'); } };
  const outcome = await executeCardAutoRenewal({
    tenantId: 't1', memberId: 'm1', previousAgreement: PREV_AGREEMENT, renewalRow: null,
    deps: {
      db,
      simulate: async () => SIM_OK,
      getStripe: async () => ({ stripe, environment: 'test' }),
      sendEmail: async () => ({ sent: true }),
    },
  });
  assert.equal(outcome.renewed, false);
  assert.equal(outcome.failed, true);
  assert.match(outcome.detail, /card charge setup failed/);
  assert.equal(inserts.length, 0);
});

test('executeCardAutoRenewal skips (not failed) before year rollover', async () => {
  const { db, inserts } = makeDbSpy();
  const outcome = await executeCardAutoRenewal({
    tenantId: 't1', memberId: 'm1', previousAgreement: PREV_AGREEMENT, renewalRow: null,
    deps: {
      db,
      simulate: async () => ({ ...SIM_OK, membershipYear: { label: '2026/27', start: '2026-04-01' } }),
      getStripe: async () => { throw new Error('should not be called'); },
    },
  });
  assert.equal(outcome.renewed, false);
  assert.equal(outcome.failed, undefined);
  assert.equal(inserts.length, 0);
});

test('mode flip: renewal reaches the previous agreement\'s account via the alternate key, never writes failed', async () => {
  // Tenant flipped membership mode to live after the plan was created in
  // test; the environment-matched primary now misses the customer
  // (resource_missing) and the alternate account must be tried.
  const { db, inserts } = makeDbSpy();
  const missingStripe = fakeStripe({ failRetrieve: true });
  const rightStripe = fakeStripe({
    customer: { id: 'cus_1', invoice_settings: { default_payment_method: 'pm_1' } },
    pms: [{ id: 'pm_1', type: 'card' }],
  });
  const subCalls = [];
  rightStripe.subscriptions = { create: async (params, opts) => { subCalls.push({ params, opts }); return { id: 'sub_alt' }; } };
  missingStripe.subscriptions = { create: async () => { throw new Error('should not create on the wrong account'); } };
  let requestedEnv = null;
  const outcome = await executeCardAutoRenewal({
    tenantId: 't1', memberId: 'm1', previousAgreement: PREV_AGREEMENT, renewalRow: null,
    deps: {
      db,
      simulate: async () => SIM_OK,
      getStripe: async (_tenantId, preferredEnvironment) => {
        requestedEnv = preferredEnvironment;
        return {
          stripe: missingStripe,
          environment: 'live',
          alternate: { stripe: rightStripe, environment: 'test' },
        };
      },
      ensurePlan: async () => ({ created: true }),
      sendEmail: async () => ({ sent: true }),
    },
  });
  assert.equal(requestedEnv, 'test', 'previous agreement environment requested');
  assert.equal(outcome.renewed, true, outcome.detail);
  assert.equal(subCalls.length, 1, 'subscription created on the account that holds the customer');
  const agreementInsert = inserts.find((i) => i.table === 'membership_billing_agreements');
  assert.equal(agreementInsert.row.environment, 'test');
  assert.equal(agreementInsert.row.stripe_subscription_id, 'sub_alt');
});

test('mode flip: unusable card in BOTH accounts still fails (no false renewal)', async () => {
  const { db, inserts } = makeDbSpy();
  const outcome = await executeCardAutoRenewal({
    tenantId: 't1', memberId: 'm1', previousAgreement: PREV_AGREEMENT, renewalRow: null,
    deps: {
      db,
      simulate: async () => SIM_OK,
      getStripe: async () => ({
        stripe: fakeStripe({ failRetrieve: true }),
        environment: 'live',
        alternate: { stripe: fakeStripe({ customer: { id: 'cus_1' }, pms: [] }), environment: 'test' },
      }),
      sendEmail: async () => ({ sent: true }),
    },
  });
  assert.equal(outcome.renewed, false);
  assert.equal(outcome.failed, true);
  assert.equal(inserts.length, 0);
});

test('executeCardAutoRenewal happy path creates subscription then agreement/history/plan/renewal rows', async () => {
  const { db, inserts } = makeDbSpy();
  const stripe = fakeStripe({
    customer: { id: 'cus_1', invoice_settings: { default_payment_method: 'pm_1' } },
    pms: [{ id: 'pm_1', type: 'card' }],
  });
  const subCalls = [];
  stripe.subscriptions = {
    create: async (params, opts) => { subCalls.push({ params, opts }); return { id: 'sub_new' }; },
  };
  const planCalls = [];
  const emails = [];
  const outcome = await executeCardAutoRenewal({
    tenantId: 't1', memberId: 'm1', previousAgreement: PREV_AGREEMENT,
    renewalRow: { renewal_year: '2027/28', notice_sent_at: '2027-03-02T00:00:00Z' },
    deps: {
      db,
      simulate: async () => SIM_OK,
      getStripe: async () => ({ stripe, environment: 'test' }),
      ensurePlan: async (args) => { planCalls.push(args); return { created: true, plan: { id: 'plan-1' } }; },
      sendEmail: async (key) => { emails.push(key); return { sent: true }; },
    },
  });
  assert.equal(outcome.renewed, true, outcome.detail);
  assert.equal(subCalls.length, 1);
  assert.equal(subCalls[0].opts.idempotencyKey, 'card-renew-sub:t1:m1:2027/28');
  assert.equal(subCalls[0].params.off_session, true);

  const agreementInsert = inserts.find((i) => i.table === 'membership_billing_agreements');
  assert.ok(agreementInsert, 'agreement inserted');
  assert.equal(agreementInsert.row.provider, 'stripe');
  assert.equal(agreementInsert.row.stripe_subscription_id, 'sub_new');
  assert.equal(agreementInsert.row.metadata.card.renewal_of_agreement_id, 'agree-prev');
  assert.equal(agreementInsert.row.idempotency_key, 'card-agree:t1:m1:2027/28');

  const historyInsert = inserts.find((i) => i.table === 'member_membership_history');
  assert.ok(historyInsert, 'history row inserted');
  assert.equal(historyInsert.row.payment_method, 'card_monthly');
  assert.equal(historyInsert.row.billing_period, 'monthly_card');
  assert.equal(historyInsert.row.membership_year, '2027/28');

  assert.equal(planCalls.length, 1);
  assert.equal(planCalls[0].session.subscription, 'sub_new');

  const renewalUpsert = inserts.find((i) => i.table === 'membership_dd_renewals');
  assert.ok(renewalUpsert, 'renewal row upserted');
  assert.equal(renewalUpsert.row.status, 'renewed');
  assert.equal(renewalUpsert.row.new_agreement_id, 'new-agree');

  assert.deepEqual(emails, ['renewal_confirmed']);
});
