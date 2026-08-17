// Task #3620 — tests for the Stripe monthly-card membership plan library.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_PLAN_KIND,
  resolveCardMonthlyOffer,
  buildCardAgreementSnapshot,
  graceDaysForCardAgreement,
  decideCardActivation,
  cardPlanCompletionDecision,
  cardPlanNeedsSettlement,
  isCardAgreement,
  processStripeCardPlanEvent,
} from './stripeMonthlyCard.js';

// ---------------------------------------------------------------------------
// resolveCardMonthlyOffer
// ---------------------------------------------------------------------------

const flatSim = (overrides = {}, configOverrides = {}) => ({
  success: true,
  currency: 'GBP',
  config: {
    card_monthly_enabled: true,
    pricing_model: 'flat',
    dd_monthly_amount: 10,
    dd_instalment_count: 12,
    dd_activation_rule: 'first_payment',
    dd_grace_days: 7,
    dd_terms_version: 'v2',
    ...configOverrides,
  },
  ...overrides,
});

test('resolveCardMonthlyOffer: flat config produces the offer', () => {
  const offer = resolveCardMonthlyOffer(flatSim());
  assert.equal(offer.monthlyAmount, 10);
  assert.equal(offer.monthlyAmountMinor, 1000);
  assert.equal(offer.instalmentCount, 12);
  assert.equal(offer.planTotal, 120);
  assert.equal(offer.currency, 'GBP');
  assert.equal(offer.activationRule, 'first_payment');
  assert.equal(offer.graceDays, 7);
  assert.equal(offer.termsVersion, 'v2');
});

test('resolveCardMonthlyOffer: disabled config returns null', () => {
  assert.equal(resolveCardMonthlyOffer(flatSim({}, { card_monthly_enabled: false })), null);
});

test('resolveCardMonthlyOffer: dd_enabled alone does not enable card monthly', () => {
  assert.equal(
    resolveCardMonthlyOffer(flatSim({}, { card_monthly_enabled: false, dd_enabled: true })),
    null,
  );
});

test('resolveCardMonthlyOffer: tiered pricing uses the matched band amount', () => {
  const sim = flatSim(
    { matchedBand: { id: 'b1', dd_monthly_amount: 25.5 } },
    { pricing_model: 'tiered', dd_monthly_amount: null },
  );
  const offer = resolveCardMonthlyOffer(sim);
  assert.equal(offer.monthlyAmount, 25.5);
  assert.equal(offer.monthlyAmountMinor, 2550);
  assert.equal(offer.planTotal, 306);
});

test('resolveCardMonthlyOffer: tiered with no band amount returns null (no fallback)', () => {
  const sim = flatSim({ matchedBand: { id: 'b1', dd_monthly_amount: null } },
    { pricing_model: 'tiered' });
  assert.equal(resolveCardMonthlyOffer(sim), null);
});

test('resolveCardMonthlyOffer: failed simulation or zero amount returns null', () => {
  assert.equal(resolveCardMonthlyOffer({ success: false }), null);
  assert.equal(resolveCardMonthlyOffer(flatSim({}, { dd_monthly_amount: 0 })), null);
});

test('resolveCardMonthlyOffer: instalment count clamps to 1..12', () => {
  assert.equal(resolveCardMonthlyOffer(flatSim({}, { dd_instalment_count: 99 })).instalmentCount, 12);
  assert.equal(resolveCardMonthlyOffer(flatSim({}, { dd_instalment_count: 0 })).instalmentCount, 12);
  assert.equal(resolveCardMonthlyOffer(flatSim({}, { dd_instalment_count: 6 })).instalmentCount, 6);
});

// ---------------------------------------------------------------------------
// snapshot + grace + activation
// ---------------------------------------------------------------------------

test('buildCardAgreementSnapshot: captures the offer immutably', () => {
  const offer = resolveCardMonthlyOffer(flatSim());
  const snap = buildCardAgreementSnapshot({
    offer,
    simResult: { membershipYear: { label: '2026/27', start: '2026-04-01' }, config: { id: 'c1' } },
    acceptedAt: '2026-08-17T00:00:00.000Z',
  });
  assert.equal(snap.kind, CARD_PLAN_KIND);
  assert.equal(snap.monthly_amount_minor, 1000);
  assert.equal(snap.instalment_count, 12);
  assert.equal(snap.membership_year, '2026/27');
  assert.equal(snap.membership_year_start, '2026-04-01');
  assert.equal(snap.accepted_at, '2026-08-17T00:00:00.000Z');
});

test('graceDaysForCardAgreement: snapshot wins, defaults to 7, clamps to 90', () => {
  assert.equal(graceDaysForCardAgreement({ metadata: { card: { grace_days: 14 } } }), 14);
  assert.equal(graceDaysForCardAgreement({ metadata: {} }), 7);
  assert.equal(graceDaysForCardAgreement({ metadata: { card: { grace_days: 500 } } }), 90);
});

test('isCardAgreement: provider or snapshot kind', () => {
  assert.equal(isCardAgreement({ provider: 'stripe' }), true);
  assert.equal(isCardAgreement({ metadata: { card: { kind: CARD_PLAN_KIND } } }), true);
  assert.equal(isCardAgreement({ provider: 'gocardless', metadata: { dd: {} } }), false);
});

test('decideCardActivation: rules map to triggers', () => {
  assert.equal(decideCardActivation({ activationRule: 'manual', trigger: 'first_payment_confirmed' }), false);
  assert.equal(decideCardActivation({ activationRule: 'mandate', trigger: 'checkout_complete' }), true);
  assert.equal(decideCardActivation({ activationRule: 'mandate', trigger: 'first_payment_confirmed' }), true);
  assert.equal(decideCardActivation({ activationRule: 'first_payment', trigger: 'checkout_complete' }), false);
  assert.equal(decideCardActivation({ activationRule: 'first_payment', trigger: 'first_payment_confirmed' }), true);
});

// ---------------------------------------------------------------------------
// cardPlanCompletionDecision
// ---------------------------------------------------------------------------

test('cardPlanCompletionDecision: duplicate invoice is a no-op', () => {
  const plan = { instalments_total: 12, instalments_paid: 3, metadata: { paid_invoice_ids: ['in_1'] } };
  assert.deepEqual(cardPlanCompletionDecision({ plan, invoiceId: 'in_1' }), { duplicate: true });
});

test('cardPlanCompletionDecision: increments and completes on the last instalment', () => {
  const plan = { instalments_total: 3, instalments_paid: 2, metadata: { paid_invoice_ids: ['a', 'b'] } };
  const d = cardPlanCompletionDecision({ plan, invoiceId: 'c' });
  assert.equal(d.duplicate, false);
  assert.equal(d.instalmentsPaid, 3);
  assert.equal(d.complete, true);
  assert.deepEqual(d.paidInvoiceIds, ['a', 'b', 'c']);
});

test('cardPlanCompletionDecision: mid-plan payment does not complete', () => {
  const d = cardPlanCompletionDecision({
    plan: { instalments_total: 12, instalments_paid: 0, metadata: {} },
    invoiceId: 'in_x',
  });
  assert.equal(d.complete, false);
  assert.equal(d.instalmentsPaid, 1);
});

// ---------------------------------------------------------------------------
// processStripeCardPlanEvent routing (fake db)
// ---------------------------------------------------------------------------

// Minimal chainable supabase stub: every from() query resolves via the
// provided resolver(table) -> { data, error }.
function fakeDb(resolver) {
  return {
    from(table) {
      const chain = {
        _table: table,
        select() { return chain; },
        eq() { return chain; },
        neq() { return chain; },
        update() { return chain; },
        insert() { return chain; },
        maybeSingle() { return Promise.resolve(resolver(table)); },
        single() { return Promise.resolve(resolver(table)); },
        then(onFulfilled, onRejected) {
          return Promise.resolve(resolver(table)).then(onFulfilled, onRejected);
        },
      };
      return chain;
    },
  };
}

test('processStripeCardPlanEvent: ignores checkout sessions of other kinds', async () => {
  const outcome = await processStripeCardPlanEvent({
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', mode: 'subscription', metadata: { kind: 'something_else' } } },
  }, { db: fakeDb(() => ({ data: null, error: null })) });
  assert.equal(outcome.handled, false);
});

test('processStripeCardPlanEvent: our checkout with no local agreement is unhandled (retryable)', async () => {
  const outcome = await processStripeCardPlanEvent({
    id: 'evt_2',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_2', mode: 'subscription', metadata: { kind: CARD_PLAN_KIND } } },
  }, { db: fakeDb(() => ({ data: null, error: null })) });
  assert.equal(outcome.handled, false);
  assert.match(outcome.detail, /no agreement/);
});

test('processStripeCardPlanEvent: invoice without a local plan is unhandled', async () => {
  const outcome = await processStripeCardPlanEvent({
    id: 'evt_3',
    type: 'invoice.paid',
    data: { object: { id: 'in_1', subscription: 'sub_unknown' } },
  }, { db: fakeDb(() => ({ data: null, error: null })) });
  assert.equal(outcome.handled, false);
});

test('processStripeCardPlanEvent: invoice with no subscription is unhandled', async () => {
  const outcome = await processStripeCardPlanEvent({
    id: 'evt_4',
    type: 'invoice.paid',
    data: { object: { id: 'in_2' } },
  }, { db: fakeDb(() => ({ data: null, error: null })) });
  assert.equal(outcome.handled, false);
  assert.match(outcome.detail, /no subscription/);
});

// ---------------------------------------------------------------------------
// resumable completion (settlement retry after counter commit)
// ---------------------------------------------------------------------------

test('cardPlanNeedsSettlement: true only for fully-counted, unsettled plans', () => {
  assert.equal(cardPlanNeedsSettlement({ instalments_total: 3, instalments_paid: 3, status: 'active' }), true);
  assert.equal(cardPlanNeedsSettlement({ instalments_total: 3, instalments_paid: 2, status: 'active' }), false);
  assert.equal(cardPlanNeedsSettlement({ instalments_total: 3, instalments_paid: 3, status: 'active', completed_at: '2026-01-01' }), false);
  assert.equal(cardPlanNeedsSettlement({ instalments_total: 3, instalments_paid: 3, status: 'expired' }), false);
  assert.equal(cardPlanNeedsSettlement({ instalments_total: 0, instalments_paid: 0, status: 'active' }), false);
});

// Shared harness for settlement scenarios: a fully-counted, unsettled plan.
function settlementHarness({
  historyRows = [{ id: 'h1', billing_agreement_id: 'a1', member_id: 'm1', payment_status: 'unpaid' }],
  historyRow,
  planMetadata,
} = {}) {
  const plan = {
    id: 'p1',
    tenant_id: 't1',
    provider: 'stripe',
    billing_agreement_id: 'a1',
    stripe_subscription_id: 'sub_1',
    instalments_total: 3,
    instalments_paid: 3,           // counter already committed…
    status: 'active',              // …but settlement never happened
    completed_at: null,
    metadata: planMetadata ?? { paid_invoice_ids: ['in_a', 'in_b', 'in_final'] },
  };
  const agreement = { id: 'a1', tenant_id: 't1', provider: 'stripe', status: 'active', member_id: 'm1', metadata: { card: { kind: CARD_PLAN_KIND } } };
  const updates = [];
  const db = {
    from(table) {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        neq() { return chain; },
        is() { return chain; },
        insert() { return chain; },
        update(payload) { updates.push({ table, payload }); return chain; },
        maybeSingle() {
          if (table === 'membership_payment_plans') return Promise.resolve({ data: plan, error: null });
          if (table === 'membership_billing_agreements') return Promise.resolve({ data: agreement, error: null });
          if (table === 'member') return Promise.resolve({ data: null, error: null }); // workflow helper skips gracefully
          if (table === 'member_membership_history') {
            return Promise.resolve({ data: historyRow !== undefined ? historyRow : (historyRows[0] || null), error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        single() { return chain.maybeSingle(); },
        then(res, rej) {
          // list-shaped awaits (update .select() / inserts)
          const rows = table === 'membership_payment_plans' ? [{ id: 'p1' }]
            : table === 'member_membership_history' ? historyRows
            : [];
          return Promise.resolve({ data: rows, error: null }).then(res, rej);
        },
      };
      return chain;
    },
  };
  return { plan, agreement, updates, db };
}

const invoicePaidEvent = {
  id: 'evt_retry',
  type: 'invoice.paid',
  data: { object: { id: 'in_final', subscription: 'sub_1', amount_paid: 1000, amount_due: 1000 } },
};

function stripeStub({ cancelFails = false, retrievedStatus = 'active' } = {}) {
  const calls = { cancel: 0, retrieve: 0 };
  return {
    calls,
    subscriptions: {
      async cancel() { calls.cancel++; if (cancelFails) { const e = new Error('boom'); e.statusCode = 500; throw e; } return {}; },
      async retrieve() { calls.retrieve++; return { status: retrievedStatus }; },
    },
  };
}

test('processStripeCardPlanEvent: duplicate final invoice RESUMES settlement instead of exiting', async () => {
  const { updates, db } = settlementHarness();
  const stripe = stripeStub();
  const outcome = await processStripeCardPlanEvent(invoicePaidEvent, { db, getStripe: async () => stripe });
  assert.equal(outcome.handled, true);
  assert.match(outcome.detail, /settlement resumed/);
  // guarded history settle attempted, subscription cancelled, THEN terminal transition
  assert.ok(updates.some((u) => u.table === 'member_membership_history' && u.payload.payment_status === 'paid'));
  assert.equal(stripe.calls.cancel, 1);
  const planUpdate = updates.find((u) => u.table === 'membership_payment_plans' && u.payload.status === 'expired');
  assert.ok(planUpdate, 'expected a terminal plan update');
  assert.ok(planUpdate.payload.completed_at, 'expected completed_at to be set');
});

test('settlement: unconfirmed subscription cancel BLOCKS the terminal transition (retryable)', async () => {
  const { updates, db } = settlementHarness();
  const stripe = stripeStub({ cancelFails: true, retrievedStatus: 'active' });
  const outcome = await processStripeCardPlanEvent(invoicePaidEvent, { db, getStripe: async () => stripe });
  assert.equal(outcome.handled, true);
  // No expired/completed_at write happened — plan stays resumable.
  assert.ok(!updates.some((u) => u.table === 'membership_payment_plans' && u.payload.status === 'expired'));
  assert.equal(stripe.calls.retrieve, 1, 'verified subscription state after failed cancel');
});

test('settlement: cancel failure but subscription already canceled remotely still concludes', async () => {
  const { updates, db } = settlementHarness();
  const stripe = stripeStub({ cancelFails: true, retrievedStatus: 'canceled' });
  await processStripeCardPlanEvent(invoicePaidEvent, { db, getStripe: async () => stripe });
  assert.ok(updates.some((u) => u.table === 'membership_payment_plans' && u.payload.status === 'expired'));
});

test('settlement: history settle DB error THROWS (webhook retry) instead of settling silently', async () => {
  const { db } = settlementHarness();
  const origFrom = db.from.bind(db);
  db.from = (table) => {
    const chain = origFrom(table);
    if (table === 'member_membership_history') {
      const origThen = chain.then;
      chain.then = (res, rej) => Promise.resolve({ data: null, error: { message: 'db down' } }).then(res, rej);
      void origThen;
    }
    return chain;
  };
  await assert.rejects(
    processStripeCardPlanEvent(invoicePaidEvent, { db, getStripe: async () => stripeStub() }),
    /mark membership paid failed/,
  );
});

test('settlement: workflow_pending marker set BEFORE the paid flip and cleared after', async () => {
  const { updates, db } = settlementHarness();
  await processStripeCardPlanEvent(invoicePaidEvent, { db, getStripe: async () => stripeStub() });
  const markerSetIdx = updates.findIndex((u) => u.table === 'membership_payment_plans' && u.payload.metadata?.workflow_pending);
  const paidFlipIdx = updates.findIndex((u) => u.table === 'member_membership_history' && u.payload.payment_status === 'paid');
  const markerClearIdx = updates.findIndex((u) => u.table === 'membership_payment_plans' && u.payload.metadata && u.payload.metadata.workflow_pending === null);
  assert.ok(markerSetIdx >= 0 && paidFlipIdx >= 0 && markerClearIdx >= 0);
  assert.ok(markerSetIdx < paidFlipIdx, 'marker persisted before the paid flip');
  assert.ok(markerClearIdx > paidFlipIdx, 'marker cleared after obligations');
});

test('settlement: pre-existing workflow_pending marker refires the workflow on an already-paid row', async () => {
  const paidRow = { id: 'h1', billing_agreement_id: 'a1', member_id: 'm1', payment_status: 'paid' };
  const { updates, db } = settlementHarness({
    historyRows: [], // guarded flip returns 0 rows (already paid on a previous attempt)
    historyRow: paidRow,
    planMetadata: {
      paid_invoice_ids: ['in_a', 'in_b', 'in_final'],
      workflow_pending: { table: 'member_membership_history', agreement_id: 'a1' },
    },
  });
  // The workflow helper skips gracefully (no member row in the fake db) —
  // the important part is no throw, marker cleared, plan concluded.
  const outcome = await processStripeCardPlanEvent(invoicePaidEvent, { db, getStripe: async () => stripeStub() });
  assert.equal(outcome.handled, true);
  assert.ok(updates.some((u) => u.table === 'membership_payment_plans' && u.payload.metadata && u.payload.metadata.workflow_pending === null));
  assert.ok(updates.some((u) => u.table === 'membership_payment_plans' && u.payload.status === 'expired'));
});

test('settlement: MISSING history row blocks settlement (throws, marker retained, no terminal state)', async () => {
  // Guarded flip returns 0 rows AND no history row exists for the agreement.
  const { updates, db } = settlementHarness({ historyRows: [], historyRow: null });
  await assert.rejects(
    processStripeCardPlanEvent(invoicePaidEvent, { db, getStripe: async () => stripeStub() }),
    /membership history row missing/,
  );
  assert.ok(!updates.some((u) => u.table === 'membership_payment_plans' && u.payload.status === 'expired'));
  assert.ok(!updates.some((u) => u.table === 'membership_payment_plans' && u.payload.metadata && u.payload.metadata.workflow_pending === null),
    'marker must NOT be cleared when the history row is missing');
});

test('settlement: alternate-mode subscription is not terminalized on single-mode resource_missing (client array)', async () => {
  const { plan, agreement, updates, db } = settlementHarness();
  const missingErr = () => { const e = new Error('No such subscription'); e.code = 'resource_missing'; return e; };
  const testMode = { subscriptions: { async cancel() { throw missingErr(); }, async retrieve() { throw missingErr(); } } };
  let liveCancelled = 0;
  const liveMode = { subscriptions: { async cancel() { liveCancelled++; return {}; }, async retrieve() { return { status: 'active' }; } } };
  const { settleCardPlanCompletion } = await import('./stripeMonthlyCard.js');
  const out = await settleCardPlanCompletion({ plan, agreement, stripe: [testMode, liveMode], db });
  assert.equal(liveCancelled, 1, 'fell through to the alternate-mode client');
  assert.equal(out.concluded, true);
  assert.ok(updates.some((u) => u.table === 'membership_payment_plans' && u.payload.status === 'expired'));
});

test('annual PaymentIntent guard: open (even pending) card agreement for the year blocks; concluded or other-year does not', async () => {
  const { annualPaymentBlockedByOpenPlan } = await import('../membership/monthly-card.js');
  const makeDb = (rows) => ({
    from() {
      const chain = {
        select() { return chain; }, eq() { return chain; }, in() { return chain; },
        order() { return chain; }, limit() { return chain; },
        then(res, rej) { return Promise.resolve({ data: rows, error: null }).then(res, rej); },
      };
      return chain;
    },
  });
  const args = { tenantId: 't1', memberId: 'm1', yearLabel: '2026/2027' };

  // Member started monthly-card checkout then cancelled/returned: the pending
  // agreement still exists and MUST block the one-off annual payment.
  const pendingCard = [{ id: 'a1', status: 'pending', provider: 'stripe', metadata: { card: { membership_year: '2026/2027' } } }];
  const blocked = await annualPaymentBlockedByOpenPlan({ ...args, db: makeDb(pendingCard) });
  assert.ok(blocked, 'pending card agreement blocks annual payment');
  assert.equal(blocked.provider, 'stripe');

  // Open DD agreement blocks too (provider-independent).
  const pendingDd = [{ id: 'a2', status: 'active', provider: 'gocardless', metadata: { dd: { membership_year: '2026/2027' } } }];
  const ddBlocked = await annualPaymentBlockedByOpenPlan({ ...args, db: makeDb(pendingDd) });
  assert.ok(ddBlocked);
  assert.equal(ddBlocked.provider, 'gocardless');

  // Agreement for a DIFFERENT year does not block. (Open-status filtering is
  // applied by the query itself, so a fake db returning only open rows for
  // another year models a concluded/absent agreement for this year.)
  const otherYear = [{ id: 'a3', status: 'pending', provider: 'stripe', metadata: { card: { membership_year: '2025/2026' } } }];
  assert.equal(await annualPaymentBlockedByOpenPlan({ ...args, db: makeDb(otherYear) }), null);

  // No agreements at all.
  assert.equal(await annualPaymentBlockedByOpenPlan({ ...args, db: makeDb([]) }), null);
});

test('invoice.paid before checkout: OUR unmatched invoice is retryable, foreign invoice is skipped', async () => {
  const emptyDb = {
    from() {
      const chain = {
        select() { return chain; }, eq() { return chain; }, neq() { return chain; }, is() { return chain; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        then(res, rej) { return Promise.resolve({ data: [], error: null }).then(res, rej); },
      };
      return chain;
    },
  };
  const oursEvent = {
    id: 'evt_ooo', type: 'invoice.paid',
    data: { object: { id: 'in_x', subscription: 'sub_new', amount_paid: 1000, subscription_details: { metadata: { kind: CARD_PLAN_KIND } } } },
  };
  const ours = await processStripeCardPlanEvent(oursEvent, { db: emptyDb, getStripe: async () => null });
  assert.equal(ours.handled, false);
  assert.equal(ours.retryable, true, 'our out-of-order invoice must stay retryable');

  const foreignEvent = {
    id: 'evt_f', type: 'invoice.paid',
    data: { object: { id: 'in_y', subscription: 'sub_other', amount_paid: 500, subscription_details: { metadata: { kind: 'something_else' } } } },
  };
  const foreign = await processStripeCardPlanEvent(foreignEvent, { db: emptyDb, getStripe: async () => null });
  assert.equal(foreign.handled, false);
  assert.ok(!foreign.retryable, 'foreign subscriptions are skipped, not retried');
});

test('processStripeCardPlanEvent: duplicate invoice on an already-settled plan stays a no-op', async () => {
  const plan = {
    id: 'p2', provider: 'stripe', billing_agreement_id: 'a1', stripe_subscription_id: 'sub_2',
    instalments_total: 3, instalments_paid: 3, status: 'expired', completed_at: '2026-08-01T00:00:00Z',
    metadata: { paid_invoice_ids: ['in_x'] },
  };
  const db = fakeDb((table) => (table === 'membership_payment_plans'
    ? { data: plan, error: null }
    : { data: table === 'membership_billing_agreements' ? { id: 'a1', provider: 'stripe' } : null, error: null }));
  const outcome = await processStripeCardPlanEvent({
    id: 'evt_dup',
    type: 'invoice.paid',
    data: { object: { id: 'in_x', subscription: 'sub_2', amount_paid: 1000, amount_due: 1000 } },
  }, { db });
  assert.equal(outcome.handled, true);
  assert.match(outcome.detail, /already counted$/);
});

test('processStripeCardPlanEvent: non-stripe plan for the subscription is not touched', async () => {
  const db = fakeDb((table) => {
    if (table === 'membership_payment_plans') {
      return { data: { id: 'p1', provider: 'gocardless', billing_agreement_id: 'a1' }, error: null };
    }
    return { data: null, error: null };
  });
  const outcome = await processStripeCardPlanEvent({
    id: 'evt_5',
    type: 'invoice.paid',
    data: { object: { id: 'in_3', subscription: 'sub_1' } },
  }, { db });
  assert.equal(outcome.handled, false);
  assert.match(outcome.detail, /not a stripe plan/);
});
