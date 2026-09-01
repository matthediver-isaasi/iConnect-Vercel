// Task #3620 — tests for the Stripe monthly-card membership plan library.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Durable settlement now fires the membership-paid workflow through the real
// triggerWorkflows (via fireWorkflowForPaidRow), which requires the module-level
// Supabase client. We give it an offline test client (fake env) and intercept
// every REST request so the workflow query returns "no workflows" — that path
// resolves durable delivery as { status: 'completed', noop: true }, exactly
// what settlement needs to confirm delivery without a real database. This must
// run BEFORE ./stripeMonthlyCard.js is imported (it transitively creates the
// client at module load), so the production module is loaded via top-level
// await AFTER the environment is prepared.
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ??= 'offline-test-key';
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (url.startsWith(process.env.SUPABASE_URL)) {
    // Any PostgREST read/write resolves to an empty collection: no workflows
    // match, so triggerWorkflows returns a completed no-op delivery.
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (typeof realFetch === 'function') return realFetch(input, init);
  throw new Error(`unexpected fetch to ${url}`);
};

const {
  CARD_PLAN_KIND,
  resolveCardMonthlyOffer,
  buildCardAgreementSnapshot,
  graceDaysForCardAgreement,
  decideCardActivation,
  cardPlanCompletionDecision,
  cardPlanNeedsSettlement,
  isCardAgreement,
  processStripeCardPlanEvent,
  compensateFormMonthlyCardConflict,
  settleCardPlanCompletion,
} = await import('./stripeMonthlyCard.js');

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
//
// Durable completion delivery is a two-part owner-token CAS design on
// membership_payment_plans.metadata:
//
//   workflow_pending  — the settlement LEASE (who may run right now):
//     claim  : update({..workflow_pending: marker}).eq('id').filter(<guard>)
//              .select('*').maybeSingle()  → plan ⇒ WON, null ⇒ LOST
//     renew  : update({..workflow_pending:{..claimed_at}}).filter(owner_token)
//              .select('*').maybeSingle()  → plan ⇒ still owned, null ⇒ lost
//     clear  : update({..workflow_pending: null}).filter(owner_token)
//              .select('id').maybeSingle() → {id} ⇒ owned, null ⇒ lost ⇒ throws
//
//   workflow_delivery — the OBLIGATION (whether the membership-paid workflow
//   has been confirmed by the workflow engine). It stays 'pending' until
//   fireWorkflowForPaidRow returns, then is flipped to 'completed':
//     reserve : update({..workflow_delivery:{status:'pending',key}})
//               .filter(owner_token).filter('workflow_delivery','is',null)
//               .select('*').maybeSingle()
//     complete: update({..workflow_delivery:{status:'completed',key}})
//               .filter(owner_token).filter(delivery key).select('*').maybeSingle()
//
// The membership-paid workflow now REQUIRES the member entity to exist for
// durable delivery (fireWorkflowForPaidRow throws with a deliveryKey when the
// member row is missing), so the fake serves member m1 with a tenant_id.
//
// The fake query records the update payload and terminates a maybeSingle()
// as the appropriate CAS step (by inspecting the written metadata) vs. an
// await (list results).
function settlementHarness({
  historyRows = [{ id: 'h1', billing_agreement_id: 'a1', member_id: 'm1', status: 'active', payment_status: 'unpaid' }],
  historyRow,
  planMetadata,
  instalmentsTotal = 3,
  instalmentsPaid = 3,
  planStatus = 'active',
  agreementStatus = 'active',
  activationRule = 'first_payment',
  formSubmissionId = null,
  claimWins = true,     // claim lease CAS: does this handler win the lease?
  renewWins = true,     // renew lease CAS (inside delivery reservation)
  deliveryOwned = true, // reserve/complete delivery CAS still owned by this handler
  clearWins = true,     // final workflow_pending: null clear: still owned?
} = {}) {
  const plan = {
    id: 'p1',
    tenant_id: 't1',
    provider: 'stripe',
    billing_agreement_id: 'a1',
    stripe_subscription_id: 'sub_1',
    instalments_total: instalmentsTotal,
    instalments_paid: instalmentsPaid,
    status: planStatus,
    completed_at: null,
    metadata: planMetadata ?? { paid_invoice_ids: ['in_a', 'in_b', 'in_final'] },
  };
  const agreement = {
    id: 'a1',
    tenant_id: 't1',
    provider: 'stripe',
    status: agreementStatus,
    member_id: 'm1',
    metadata: {
      card: { kind: CARD_PLAN_KIND, activation_rule: activationRule },
      ...(formSubmissionId ? { form_submission_id: formSubmissionId } : {}),
    },
  };
  const member = { id: 'm1', tenant_id: 't1', status: 'active', payment_status: 'unpaid' };
  const updates = [];
  // Plan CAS steps arrive in a fixed order; a shared counter distinguishes the
  // first workflow_pending write (claim) from later ones (renew).
  let markerWrites = 0;
  const db = {
    from(table) {
      const state = { updated: false, updatePayload: null, filters: [] };
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        neq() { return chain; },
        is() { return chain; },
        filter(col, op, val) { state.filters.push({ col, op, val }); return chain; },
        insert() { return chain; },
        update(payload) { state.updated = true; state.updatePayload = payload; updates.push({ table, payload }); return chain; },
        maybeSingle() {
          if (table === 'membership_payment_plans') {
            if (state.updated) {
              const md = state.updatePayload?.metadata || {};
              const marker = md.workflow_pending;
              const delivery = md.workflow_delivery;
              // Clearing the lease (workflow_pending: null) — the final CAS.
              if (marker === null) {
                return Promise.resolve({ data: clearWins ? { id: plan.id } : null, error: null });
              }
              // Delivery reservation / completion (workflow_delivery written).
              if (delivery && delivery.status === 'completed') {
                return Promise.resolve({ data: deliveryOwned ? { ...plan, metadata: md } : null, error: null });
              }
              if (delivery && delivery.status === 'pending') {
                return Promise.resolve({ data: deliveryOwned ? { ...plan, metadata: md } : null, error: null });
              }
              // A bare workflow_pending marker write: first = claim, later = renew.
              markerWrites += 1;
              if (markerWrites === 1) {
                return Promise.resolve({ data: claimWins ? { ...plan, metadata: md } : null, error: null });
              }
              return Promise.resolve({ data: renewWins ? { ...plan, metadata: md } : null, error: null });
            }
            return Promise.resolve({ data: plan, error: null });
          }
          if (table === 'membership_billing_agreements') return Promise.resolve({ data: agreement, error: null });
          // Durable delivery requires the member entity to exist.
          if (table === 'member') return Promise.resolve({ data: member, error: null });
          if (table === 'member_membership_history') {
            return Promise.resolve({ data: historyRow !== undefined ? historyRow : (historyRows[0] || null), error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        single() { return chain.maybeSingle(); },
        then(res, rej) {
          // list-shaped awaits (update .select() / inserts)
          const rows = table === 'membership_payment_plans'
            ? [{ ...plan, ...(state.updatePayload || {}) }]
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

test('form one-instalment first invoice activates agreement/history before final settlement', async () => {
  const event = {
    id: 'evt_single',
    type: 'invoice.paid',
    data: {
      object: {
        id: 'in_single',
        subscription: 'sub_1',
        amount_paid: 12000,
        amount_due: 12000,
      },
    },
  };
  const { updates, db } = settlementHarness({
    instalmentsTotal: 1,
    instalmentsPaid: 0,
    planStatus: 'first_payment_pending',
    agreementStatus: 'first_payment_pending',
    activationRule: 'first_payment',
    formSubmissionId: 'form-submission-1',
    planMetadata: { paid_invoice_ids: [] },
    historyRows: [{
      id: 'h1',
      billing_agreement_id: 'a1',
      member_id: 'm1',
      status: 'pending_payment_setup',
      payment_status: 'unpaid',
    }],
  });

  const outcome = await processStripeCardPlanEvent(event, {
    db,
    getStripe: async () => stripeStub(),
  });
  assert.equal(outcome.handled, true);
  assert.match(outcome.detail, /1\/1 paid; plan complete/);

  const agreementActiveIdx = updates.findIndex(
    (u) => u.table === 'membership_billing_agreements' && u.payload.status === 'active',
  );
  const historyActiveIdx = updates.findIndex(
    (u) => u.table === 'member_membership_history' && u.payload.status === 'active',
  );
  const historyPaidIdx = updates.findIndex(
    (u) => u.table === 'member_membership_history' && u.payload.payment_status === 'paid',
  );
  const terminalPlanIdx = updates.findIndex(
    (u) => u.table === 'membership_payment_plans'
      && u.payload.status === 'expired'
      && u.payload.completed_at,
  );

  assert.ok(agreementActiveIdx >= 0, 'first payment activates the billing agreement');
  assert.ok(historyActiveIdx >= 0, 'first payment activates the membership history');
  assert.ok(historyPaidIdx > historyActiveIdx, 'activation happens before final paid settlement');
  assert.ok(terminalPlanIdx > historyPaidIdx, 'the plan terminalizes only after active history is paid');
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
      let isPaidSettle = false;
      const origUpdate = chain.update;
      chain.update = (payload) => {
        isPaidSettle = payload?.payment_status === 'paid';
        return origUpdate(payload);
      };
      chain.then = (res, rej) => (
        isPaidSettle
          ? Promise.resolve({ data: null, error: { message: 'db down' } }).then(res, rej)
          : origThen(res, rej)
      );
    }
    return chain;
  };
  await assert.rejects(
    processStripeCardPlanEvent(invoicePaidEvent, { db, getStripe: async () => stripeStub() }),
    /mark membership paid failed/,
  );
});

test('settlement: workflow_pending owner-token marker set BEFORE the paid flip and cleared after', async () => {
  const { updates, db } = settlementHarness();
  await processStripeCardPlanEvent(invoicePaidEvent, { db, getStripe: async () => stripeStub() });
  const markerSetIdx = updates.findIndex((u) => u.table === 'membership_payment_plans' && u.payload.metadata?.workflow_pending);
  const paidFlipIdx = updates.findIndex((u) => u.table === 'member_membership_history' && u.payload.payment_status === 'paid');
  const markerClearIdx = updates.findIndex((u) => u.table === 'membership_payment_plans' && u.payload.metadata && u.payload.metadata.workflow_pending === null);
  assert.ok(markerSetIdx >= 0 && paidFlipIdx >= 0 && markerClearIdx >= 0);
  assert.ok(markerSetIdx < paidFlipIdx, 'marker persisted before the paid flip');
  assert.ok(markerClearIdx > paidFlipIdx, 'marker cleared after obligations');
  // The claim marker is an owner-token processing lease (CAS), not a bare flag.
  const claimMarker = updates[markerSetIdx].payload.metadata.workflow_pending;
  assert.equal(claimMarker.status, 'processing');
  assert.equal(typeof claimMarker.owner_token, 'string');
  assert.ok(claimMarker.owner_token.length > 0, 'claim marker carries an owner token');
  assert.ok(claimMarker.claimed_at, 'claim marker carries a claimed_at timestamp');
});

test('settlement DELIVERY: workflow_delivery is reserved PENDING before dispatch and flipped COMPLETED only after fireWorkflowForPaidRow', async () => {
  const { updates, db } = settlementHarness();
  await processStripeCardPlanEvent(invoicePaidEvent, { db, getStripe: async () => stripeStub() });

  const planDeliveryWrites = updates.filter(
    (u) => u.table === 'membership_payment_plans' && u.payload.metadata?.workflow_delivery,
  );
  const pendingIdx = planDeliveryWrites.findIndex((u) => u.payload.metadata.workflow_delivery.status === 'pending');
  const completedIdx = planDeliveryWrites.findIndex((u) => u.payload.metadata.workflow_delivery.status === 'completed');
  assert.ok(pendingIdx >= 0, 'a pending delivery reservation is persisted');
  assert.ok(completedIdx >= 0, 'the delivery is later marked completed');
  assert.ok(pendingIdx < completedIdx, 'delivery goes pending -> completed, never the reverse');

  // The pending reservation and the completion share the SAME stable
  // membership-paid delivery key (membership-paid:<table>:<rowId>), which the
  // workflow engine uses to deduplicate retries.
  const pendingDelivery = planDeliveryWrites[pendingIdx].payload.metadata.workflow_delivery;
  const completedDelivery = planDeliveryWrites[completedIdx].payload.metadata.workflow_delivery;
  assert.equal(pendingDelivery.key, 'membership-paid:member_membership_history:h1');
  assert.equal(completedDelivery.key, pendingDelivery.key);

  // Completion happens only AFTER the history row was flipped paid (workflow
  // dispatched from a settled row), and before the plan terminalizes.
  const paidFlipIdx = updates.findIndex((u) => u.table === 'member_membership_history' && u.payload.payment_status === 'paid');
  const completedUpdateIdx = updates.findIndex((u) => u.table === 'membership_payment_plans' && u.payload.metadata?.workflow_delivery?.status === 'completed');
  const terminalIdx = updates.findIndex((u) => u.table === 'membership_payment_plans' && u.payload.status === 'expired');
  assert.ok(paidFlipIdx >= 0 && completedUpdateIdx > paidFlipIdx, 'delivery completed after the paid flip');
  assert.ok(terminalIdx > completedUpdateIdx, 'plan terminalized only after delivery completed');
});

test('settlement DELIVERY: an already-PENDING delivery is retried with the SAME key and dispatch is not skipped', async () => {
  // A prior attempt reserved the delivery (status pending) but crashed before
  // the workflow engine confirmed. On retry the SAME membership-paid key is
  // reused and the workflow is dispatched again (idempotent on the engine
  // side), then completed.
  const deliveryKey = 'membership-paid:member_membership_history:h1';
  const { updates, db } = settlementHarness({
    planMetadata: {
      paid_invoice_ids: ['in_a', 'in_b', 'in_final'],
      workflow_pending: { status: 'processing', owner_token: 'tok-prev', claimed_at: '2020-01-01T00:00:00.000Z', table: 'member_membership_history', agreement_id: 'a1' },
      workflow_delivery: { key: deliveryKey, status: 'pending', owner_token: 'tok-prev', reserved_at: '2020-01-01T00:00:00.000Z' },
    },
  });
  const outcome = await processStripeCardPlanEvent(invoicePaidEvent, { db, getStripe: async () => stripeStub() });
  assert.equal(outcome.handled, true);

  // The retry completes the SAME delivery key (never mints a new one) …
  const completed = updates.filter((u) => u.table === 'membership_payment_plans' && u.payload.metadata?.workflow_delivery?.status === 'completed');
  assert.ok(completed.length >= 1, 'the pending delivery is confirmed on retry');
  for (const u of completed) {
    assert.equal(u.payload.metadata.workflow_delivery.key, deliveryKey, 'retry reuses the same membership-paid delivery key');
  }
  // … and the plan is terminalized once delivery is confirmed.
  assert.ok(updates.some((u) => u.table === 'membership_payment_plans' && u.payload.status === 'expired'));
});

test('settlement DELIVERY: a delivery already COMPLETED is not re-dispatched but the plan still concludes', async () => {
  // Resume where the workflow was already confirmed (delivery completed) but
  // the lease clear / subscription cancel never ran. The workflow must NOT be
  // re-dispatched; settlement just clears the lease and terminalizes.
  const deliveryKey = 'membership-paid:member_membership_history:h1';
  const paidRow = { id: 'h1', billing_agreement_id: 'a1', member_id: 'm1', payment_status: 'paid' };
  const { updates, db } = settlementHarness({
    historyRows: [],       // history already paid (guarded flip returns 0 rows)
    historyRow: paidRow,
    planMetadata: {
      paid_invoice_ids: ['in_a', 'in_b', 'in_final'],
      workflow_pending: { status: 'processing', owner_token: 'tok-prev', claimed_at: '2020-01-01T00:00:00.000Z', table: 'member_membership_history', agreement_id: 'a1' },
      workflow_delivery: { key: deliveryKey, status: 'completed', owner_token: 'tok-prev', completed_at: '2020-01-01T00:00:00.000Z' },
    },
  });
  const outcome = await processStripeCardPlanEvent(invoicePaidEvent, { db, getStripe: async () => stripeStub() });
  assert.equal(outcome.handled, true);
  // No fresh "completed" delivery write is required, but the lease is cleared
  // and the plan terminalizes.
  assert.ok(updates.some((u) => u.table === 'membership_payment_plans' && u.payload.metadata && u.payload.metadata.workflow_pending === null));
  assert.ok(updates.some((u) => u.table === 'membership_payment_plans' && u.payload.status === 'expired'));
});

test('settlement CONCURRENCY: only the lease owner may dispatch/clear; the loser returns workflow-settlement-in-progress and cannot terminalize', async () => {
  // Loser: the claim CAS finds no matching row (another handler already holds
  // the lease) → settlement must NOT flip the history row, NOT cancel the
  // subscription, and NOT terminalize the plan.
  const loser = settlementHarness({ claimWins: false });
  const loserStripe = stripeStub();
  const loserOut = await settleCardPlanCompletion({
    plan: loser.plan, agreement: loser.agreement, stripe: loserStripe, db: loser.db,
  });
  assert.equal(loserOut.concluded, false);
  assert.equal(loserOut.workflowFired, false);
  assert.equal(loserOut.transition.skippedReason, 'workflow-settlement-in-progress');
  assert.equal(loserStripe.calls.cancel, 0, 'loser must not cancel the subscription');
  assert.ok(!loser.updates.some((u) => u.table === 'member_membership_history' && u.payload.payment_status === 'paid'),
    'loser must not flip the history row to paid');
  assert.ok(!loser.updates.some((u) => u.table === 'membership_payment_plans' && u.payload.status === 'expired'),
    'loser must not terminalize the plan');

  // Owner: wins the claim CAS and dispatches/clears/terminalizes normally.
  const owner = settlementHarness({ claimWins: true, clearWins: true });
  const ownerStripe = stripeStub();
  const ownerOut = await settleCardPlanCompletion({
    plan: owner.plan, agreement: owner.agreement, stripe: ownerStripe, db: owner.db,
  });
  assert.equal(ownerOut.concluded, true);
  assert.equal(ownerStripe.calls.cancel, 1);
  assert.ok(owner.updates.some((u) => u.table === 'membership_payment_plans' && u.payload.status === 'expired'));
});

test('settlement CONCURRENCY: owner that LOSES the lease before the final clear throws (ownership lost) and cannot terminalize', async () => {
  // Claim/renew/deliver all succeed, but the final workflow_pending:null clear
  // CAS matches no row (the lease was reclaimed by another handler after
  // delivery) → the clear throws and the plan is NOT terminalized, so the
  // obligation stays owned by whoever now holds the lease.
  const { plan, agreement, updates, db } = settlementHarness({
    claimWins: true, renewWins: true, deliveryOwned: true, clearWins: false,
  });
  await assert.rejects(
    settleCardPlanCompletion({ plan, agreement, stripe: stripeStub(), db }),
    /settlement ownership was lost/,
  );
  assert.ok(!updates.some((u) => u.table === 'membership_payment_plans' && u.payload.status === 'expired'),
    'a handler that lost its lease must not terminalize the plan');
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
  // Durable delivery confirms against the (now present) member entity — no
  // throw, delivery + lease markers cleared, plan concluded.
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

// ---------------------------------------------------------------------------
// compensateFormMonthlyCardConflict
//
// A form Checkout resolving to an already-recorded membership year must NOT
// create a duplicate local plan: cancel the subscription, refund the paid
// first invoice (stable idempotency), mark the form failed and the agreement
// cancelled. Any hard failure flags the agreement for operator attention and
// re-throws so the durable event stays retryable.
// ---------------------------------------------------------------------------

// Capturing fake db: records every update() payload keyed by table and serves
// per-table reads from `reads`.
function captureDb(reads = {}) {
  const updates = [];
  const inserts = [];
  const db = {
    updates,
    inserts,
    from(table) {
      const chain = {
        _table: table,
        select() { return chain; },
        eq() { return chain; },
        neq() { return chain; },
        is() { return chain; },
        update(payload) { updates.push({ table, payload }); return chain; },
        insert(payload) { inserts.push({ table, payload }); return chain; },
        maybeSingle() { return Promise.resolve(reads[table] ?? { data: null, error: null }); },
        single() { return Promise.resolve(reads[table] ?? { data: null, error: null }); },
        then(res, rej) { return Promise.resolve(reads[table] ?? { data: null, error: null }).then(res, rej); },
      };
      return chain;
    },
  };
  return db;
}

// Stripe stub recording every call; behaviours toggle per scenario.
function conflictStripeStub({
  subscriptionStatus = 'active',
  invoice = null,
} = {}) {
  const calls = { subRetrieve: [], subCancel: [], invRetrieve: [], refundCreate: [] };
  return {
    calls,
    subscriptions: {
      async retrieve(id) { calls.subRetrieve.push(id); return { id, status: subscriptionStatus, latest_invoice: invoice?.id || null }; },
      async cancel(id, opts) { calls.subCancel.push({ id, opts }); return { id, status: 'canceled' }; },
    },
    invoices: {
      async retrieve(id) { calls.invRetrieve.push(id); return invoice; },
    },
    refunds: {
      async create(params, opts) { calls.refundCreate.push({ params, opts }); return { id: 're_1' }; },
    },
  };
}

const conflictAgreement = {
  id: 'a1',
  tenant_id: 't1',
  provider: 'stripe',
  status: 'first_payment_pending',
  metadata: { card: { kind: CARD_PLAN_KIND }, form_submission_id: 'fs1' },
};
const conflictSession = {
  id: 'cs1',
  subscription: 'sub_1',
  invoice: 'in_1',
  payment_status: 'paid',
  metadata: { form_submission_id: 'fs1' },
};

test('compensateFormMonthlyCardConflict: cancels sub, refunds paid invoice with stable idempotency, marks form failed + agreement cancelled', async () => {
  const invoice = { id: 'in_1', amount_paid: 1000, payment_intent: 'pi_1' };
  const stripe = conflictStripeStub({ subscriptionStatus: 'active', invoice });
  stripe.customers = { update: async () => ({ id: 'cus_1' }) };
  const db = captureDb({ form_submission: { data: { payment_meta: { foo: 'bar' } }, error: null } });

  const out = await compensateFormMonthlyCardConflict({
    agreement: conflictAgreement,
    session: conflictSession,
    detail: 'Already a member this year',
    db,
    stripe,
  });

  assert.equal(out.handled, true);
  assert.equal(out.conflict, true);
  assert.equal(out.refunded, true);
  assert.equal(out.refundId, 're_1');

  // Subscription cancelled (not already canceled).
  assert.deepEqual(stripe.calls.subCancel.map((c) => c.id), ['sub_1']);

  // Refund created against the invoice's payment intent with a stable,
  // agreement-scoped idempotency key (safe across webhook/browser/cron retries).
  assert.equal(stripe.calls.refundCreate.length, 1);
  assert.equal(stripe.calls.refundCreate[0].params.payment_intent, 'pi_1');
  assert.equal(stripe.calls.refundCreate[0].opts.idempotencyKey, 'form-card-conflict-refund:a1');

  // Form submission marked failed with the conflict-refunded state (prior
  // payment_meta preserved).
  const formUpd = db.updates.find((u) => u.table === 'form_submission');
  assert.ok(formUpd, 'expected a form_submission update');
  assert.equal(formUpd.payload.payment_status, 'failed');
  assert.equal(formUpd.payload.payment_meta.foo, 'bar');
  assert.equal(formUpd.payload.payment_meta.monthly_card_state.status, 'conflict_refunded');
  assert.equal(formUpd.payload.payment_meta.monthly_card_state.refund_id, 're_1');

  // A durable PENDING compensation state is persisted BEFORE any Stripe call
  // (so a crash mid-cleanup is recoverable by the reconcile cron sweep).
  const agreeUpds = db.updates.filter((u) => u.table === 'membership_billing_agreements');
  assert.ok(agreeUpds.length >= 2, 'expected pending-then-resolved agreement updates');
  assert.equal(agreeUpds[0].payload.metadata.form_conflict_resolution.status, 'pending');
  assert.equal(agreeUpds[0].payload.metadata.form_conflict_resolution.subscription_id, 'sub_1');

  // Inspect the FINAL agreement update: cancelled, attention cleared, resolved.
  const agreeUpd = agreeUpds[agreeUpds.length - 1];
  assert.equal(agreeUpd.payload.status, 'payment_plan_cancelled');
  assert.equal(agreeUpd.payload.needs_attention, false);
  assert.equal(agreeUpd.payload.attention_reason, null);
  assert.equal(agreeUpd.payload.metadata.form_conflict_resolution.status, 'resolved');
  assert.equal(agreeUpd.payload.metadata.form_conflict_resolution.refund_id, 're_1');

  // NEVER create a local plan for a conflicting checkout.
  assert.ok(!db.inserts.some((i) => i.table === 'membership_payment_plans'));
});

test('compensateFormMonthlyCardConflict: no refund when invoice amount_paid=0, still cancels sub + marks failed/cancelled', async () => {
  const invoice = { id: 'in_1', amount_paid: 0, payment_intent: null };
  const stripe = conflictStripeStub({ subscriptionStatus: 'active', invoice });
  const db = captureDb({ form_submission: { data: { payment_meta: {} }, error: null } });

  const out = await compensateFormMonthlyCardConflict({
    agreement: conflictAgreement,
    session: conflictSession,
    detail: 'Already a member',
    db,
    stripe,
  });

  assert.equal(out.handled, true);
  assert.equal(out.refunded, false);
  assert.equal(out.refundId, null);
  assert.equal(stripe.calls.refundCreate.length, 0, 'no refund attempted for a zero-paid invoice');
  assert.deepEqual(stripe.calls.subCancel.map((c) => c.id), ['sub_1']);

  const formUpd = db.updates.find((u) => u.table === 'form_submission');
  assert.equal(formUpd.payload.payment_status, 'failed');
  assert.equal(formUpd.payload.payment_meta.monthly_card_state.refund_id, null);

  // Final agreement update is the resolved cancellation (the first update is
  // the durable pending marker written before Stripe).
  const agreeUpds = db.updates.filter((u) => u.table === 'membership_billing_agreements');
  assert.equal(agreeUpds[0].payload.metadata.form_conflict_resolution.status, 'pending');
  const agreeUpd = agreeUpds[agreeUpds.length - 1];
  assert.equal(agreeUpd.payload.status, 'payment_plan_cancelled');
  assert.equal(agreeUpd.payload.needs_attention, false);
});

test('compensateFormMonthlyCardConflict: paid invoice with no payment intent THROWS (retryable) and flags needs_attention', async () => {
  const invoice = { id: 'in_1', amount_paid: 1000, payment_intent: null };
  const stripe = conflictStripeStub({ subscriptionStatus: 'active', invoice });
  const db = captureDb({ form_submission: { data: { payment_meta: {} }, error: null } });

  await assert.rejects(
    compensateFormMonthlyCardConflict({
      agreement: conflictAgreement,
      session: conflictSession,
      detail: 'conflict',
      db,
      stripe,
    }),
    /no refundable payment intent/,
  );

  // No refund could be issued, and the agreement is flagged for operator
  // attention (so the durable event stays visibly unresolved on retry).
  assert.equal(stripe.calls.refundCreate.length, 0);
  const attentionUpd = db.updates.find((u) => u.table === 'membership_billing_agreements' && u.payload.needs_attention === true);
  assert.ok(attentionUpd, 'expected agreement flagged needs_attention on failure');
  assert.match(attentionUpd.payload.attention_reason, /conflict cleanup pending/i);

  // The agreement is NOT cancelled and NO plan is created on the failure path.
  assert.ok(!db.updates.some((u) => u.table === 'membership_billing_agreements' && u.payload.status === 'payment_plan_cancelled'));
  assert.ok(!db.inserts.some((i) => i.table === 'membership_payment_plans'));
});

// ---------------------------------------------------------------------------
// processor contract: a form-checkout conflict NEVER creates a local plan
// ---------------------------------------------------------------------------

test('processStripeCardPlanEvent: form-checkout membership conflict resolves via compensation and NEVER inserts a plan', async () => {
  // A capturing db that also serves the finalize helper's reads so it reaches
  // its conflict branch: the form_submission is setup_complete with a persisted
  // monthly_card_state = { status: 'conflict' }.
  const reads = {
    membership_billing_agreements: { data: conflictAgreement, error: null },
    form_submission: {
      data: {
        id: 'fs1',
        form_id: 'form1',
        payment_status: 'setup_complete',
        payment_meta: { monthly_card_state: { status: 'conflict', code: 'MEMBERSHIP_YEAR_CONFLICT', detail: 'Already a member this year' } },
      },
      error: null,
    },
    form: {
      data: { id: 'form1', tenant_id: 't1', access_policy: null },
      error: null,
    },
    membership_payment_plans: { data: null, error: null },
  };
  const db = captureDb(reads);
  const invoice = { id: 'in_1', amount_paid: 1000, payment_intent: 'pi_1' };
  const stripe = conflictStripeStub({ subscriptionStatus: 'active', invoice });
  stripe.customers = { update: async () => ({ id: 'cus_1' }) };

  const event = {
    id: 'evt_conflict',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs1',
        mode: 'subscription',
        subscription: 'sub_1',
        invoice: 'in_1',
        customer: 'cus_1',
        customer_details: {
          address: {
            line1: '1 High Street',
            city: 'London',
            postal_code: 'SW1A 1AA',
            country: 'GB',
          },
        },
        payment_status: 'paid',
        metadata: { kind: CARD_PLAN_KIND, agreement_id: 'a1', form_submission_id: 'fs1' },
      },
    },
  };

  const outcome = await processStripeCardPlanEvent(event, { db, getStripe: async () => stripe });

  assert.equal(outcome.handled, true);
  assert.equal(outcome.conflict, true);

  // The core contract: compensation ran (subscription cancelled, refund issued)
  // and NO membership_payment_plans row was ever inserted.
  assert.deepEqual(stripe.calls.subCancel.map((c) => c.id), ['sub_1']);
  assert.ok(!db.inserts.some((i) => i.table === 'membership_payment_plans'),
    'a conflicting form checkout must never create a local plan');
});

// ---------------------------------------------------------------------------
// Reconcile cron wiring (api/cron/reconcile-stripe-card-plans.js)
//
// The cron only exports its default HTTP handler; its sweeps
// (reconcileFormConflictCompensations, reconcileStaleCheckouts →
// resetExpiredFormCheckout) are module-private. These are SOURCE contract
// tests: they assert the durable-replay and expired-checkout-cleanup wiring
// stays in place (a refactor that drops either safety net fails here).
// ---------------------------------------------------------------------------

const cronSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../cron/reconcile-stripe-card-plans.js'),
  'utf8',
);

// Expired-Checkout cleanup is now a SECURITY DEFINER, service-role-only
// transactional RPC (release_expired_form_monthly_card_checkout). The cron and
// the public form-payment create path both call it through the
// releaseExpiredFormMonthlyCardCheckout wrapper; the atomic guarantees live in
// the SQL migration. These sources are read for contract assertions.
const migrationSource = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../supabase/migrations/20260819_member_membership_history_billing_agreement_unique.sql',
  ),
  'utf8',
);
const formPaymentSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../public/form-payment.js'),
  'utf8',
);
// Just the RPC body, so assertions cannot accidentally match unrelated SQL.
const releaseRpcSql = migrationSource.slice(
  migrationSource.indexOf('CREATE OR REPLACE FUNCTION release_expired_form_monthly_card_checkout'),
);

test('reconcile cron: durable pending compensation replay is wired into the run', () => {
  // The run invokes the pending-compensation sweep FIRST, before checkout/plan
  // sweeps, so a crashed compensation is retried even when needs_attention.
  assert.match(cronSource, /await reconcileFormConflictCompensations\(results\);/);
  const orderIdx = cronSource.indexOf('await reconcileFormConflictCompensations(results);');
  const checkoutIdx = cronSource.indexOf('await reconcileStaleCheckouts(results);');
  assert.ok(orderIdx >= 0 && checkoutIdx >= 0 && orderIdx < checkoutIdx,
    'compensation replay must run before the stale-checkout sweep');

  // It selects agreements whose durable form_conflict_resolution.status is
  // still 'pending' and replays a synthetic checkout.session.completed through
  // the shared processor, requiring outcome.conflict && outcome.handled.
  assert.match(cronSource, /metadata->form_conflict_resolution->>status['"]\s*,\s*['"]eq['"]\s*,\s*['"]pending['"]/);
  assert.match(cronSource, /type:\s*['"]checkout\.session\.completed['"]/);
  assert.match(cronSource, /kind:\s*CARD_PLAN_KIND/);
  assert.match(cronSource, /!outcome\?\.conflict\s*\|\|\s*!outcome\?\.handled/);
  // On failure the agreement is (re-)flagged for attention so it stays visible.
  assert.match(cronSource, /flagAttention\(\s*\n?\s*['"]membership_billing_agreements['"]/);
});

test('reconcile cron: expired checkout cleanup runs EVEN WHEN applyStatusTransition returns no-change', () => {
  // payment_setup_required -> payment_setup_required is intentionally a no-op
  // transition, but the expired provider link must STILL be cleared so the
  // next attempt creates a fresh Checkout. Assert the reset is not gated on
  // outcome.applied: it runs unconditionally, before the applied/no-change
  // bookkeeping, and a 'no-change' skip is tolerated (not warned).
  const expiredBranch = cronSource.slice(
    cronSource.indexOf("session.status === 'expired'"),
    cronSource.indexOf('} else {', cronSource.indexOf("session.status === 'expired'")),
  );
  assert.ok(expiredBranch.length > 0, 'located the expired-session branch');

  const resetIdx = expiredBranch.indexOf('await resetExpiredFormCheckout(agreement);');
  const appliedGuardIdx = expiredBranch.indexOf('!outcome.applied');
  assert.ok(resetIdx >= 0, 'expired branch calls resetExpiredFormCheckout');
  assert.ok(appliedGuardIdx < 0 || resetIdx < appliedGuardIdx,
    'cleanup must run before (i.e. independent of) any outcome.applied check');
  // The cleanup is NOT wrapped in `if (outcome.applied) { ... reset ... }`.
  assert.doesNotMatch(expiredBranch, /if \(outcome\.applied\)[\s\S]*resetExpiredFormCheckout/);
  // A no-change transition is treated as success, not a warning.
  assert.match(expiredBranch, /outcome\.skippedReason !== ['"]no-change['"]/);
});

test('reconcile cron: expired checkout cleanup delegates to the transactional RPC wrapper (no ad-hoc deletes)', () => {
  // The cron no longer performs its own multi-statement cleanup. On a verified
  // expired session it resets the agreement status and calls the RPC wrapper,
  // which retires the agreement atomically. Prove the old racy client-side
  // delete/link-scrub is gone and replaced by the single RPC call.
  assert.match(cronSource, /session\.status === ['"]expired['"]/);
  assert.match(cronSource, /toStatus:\s*STATUS\.PAYMENT_SETUP_REQUIRED/);
  assert.match(cronSource, /await resetExpiredFormCheckout\(agreement\);/);

  // resetExpiredFormCheckout is now a thin wrapper over the RPC helper, keyed
  // by the agreement id AND the exact Checkout session id.
  assert.match(cronSource, /async function resetExpiredFormCheckout/);
  assert.match(cronSource, /releaseExpiredFormMonthlyCardCheckout\(\s*supabase\s*,\s*\{/);
  assert.match(cronSource, /agreementId:\s*agreement\.id/);
  assert.match(cronSource, /checkoutSessionId:\s*agreement\.stripe_checkout_session_id/);
  // A failed release must surface (throw) so the sweep does not silently leave
  // the reservation dangling.
  assert.match(cronSource, /if \(!released\.ok\)/);

  // The retired client-side cleanup must NOT reappear anywhere in the cron.
  assert.doesNotMatch(cronSource, /\.eq\(['"]status['"],\s*['"]pending_payment_setup['"]\)/);
  assert.doesNotMatch(cronSource, /delete monthly\.checkout_url;/);
});

test('release RPC: retires the agreement (status + idempotency key) and clears the member reservation atomically', () => {
  // Single SECURITY DEFINER function ⇒ one transaction; all effects commit or
  // roll back together.
  assert.match(releaseRpcSql, /LANGUAGE\s+plpgsql/i);
  assert.match(releaseRpcSql, /SECURITY\s+DEFINER/i);
  assert.match(releaseRpcSql, /SET\s+search_path\s*=\s*public,\s*pg_temp/i);

  // The agreement is terminalized to 'expired', detached from any member, and
  // its applicant/year idempotency key is rewritten to an expired-form key so a
  // fresh create cannot collide with the retired reservation.
  assert.match(releaseRpcSql, /UPDATE\s+membership_billing_agreements/i);
  assert.match(releaseRpcSql, /status\s*=\s*'expired'/i);
  assert.match(releaseRpcSql, /member_id\s*=\s*NULL/i);
  assert.match(releaseRpcSql, /idempotency_key\s*=\s*'expired-form-card:'/i);
  // The stale provider links are cleared so the next attempt mints a new one.
  assert.match(releaseRpcSql, /stripe_checkout_session_id\s*=\s*NULL/i);
  assert.match(releaseRpcSql, /stripe_subscription_id\s*=\s*NULL/i);
  assert.match(releaseRpcSql, /redirect_url\s*=\s*NULL/i);

  // The uncharged member reservation (pending_payment_setup / unpaid) is
  // deleted, scoped to THIS agreement only.
  assert.match(
    releaseRpcSql,
    /DELETE\s+FROM\s+member_membership_history[\s\S]*?WHERE\s+billing_agreement_id\s*=\s*p_agreement_id[\s\S]*?status\s*=\s*'pending_payment_setup'[\s\S]*?payment_status\s*=\s*'unpaid'/i,
  );

  // The originating form submission's checkout links are scrubbed, guarded to a
  // still-pending submission — in the SAME transaction.
  assert.match(releaseRpcSql, /UPDATE\s+form_submission/i);
  assert.match(releaseRpcSql, /monthly_card,checkout_url/);
  assert.match(releaseRpcSql, /monthly_card,checkout_session_id/);
  assert.match(releaseRpcSql, /payment_status\s*=\s*'pending'/i);
});

test('release RPC: BLOCKS the release when a payment plan already exists (never destroys a charged membership)', () => {
  // If any plan is attached to the agreement, the reservation must NOT be
  // released — the applicant has already been charged. The function returns a
  // PAYMENT_PLAN_EXISTS error instead of deleting anything.
  assert.match(
    releaseRpcSql,
    /IF\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+membership_payment_plans\s+WHERE\s+billing_agreement_id\s*=\s*p_agreement_id\s*\)/i,
  );
  assert.match(releaseRpcSql, /'PAYMENT_PLAN_EXISTS'/);
  // The plan-exists guard is evaluated BEFORE any destructive DELETE/UPDATE.
  const guardIdx = releaseRpcSql.indexOf('PAYMENT_PLAN_EXISTS');
  const deleteIdx = releaseRpcSql.search(/DELETE\s+FROM\s+member_membership_history/i);
  const updateIdx = releaseRpcSql.search(/UPDATE\s+membership_billing_agreements/i);
  assert.ok(guardIdx >= 0 && deleteIdx > guardIdx && updateIdx > guardIdx,
    'plan-exists guard must run before the delete/update mutations');
  // The lookup + mutation are serialized under a row lock (FOR UPDATE) so a
  // concurrent checkout completion cannot slip a plan in mid-release.
  assert.match(releaseRpcSql, /FROM\s+membership_billing_agreements[\s\S]*?FOR\s+UPDATE/i);
});

test('release RPC: is service-role-only (execute revoked from PUBLIC/anon/authenticated)', () => {
  assert.match(releaseRpcSql, /REVOKE\s+ALL\s+ON\s+FUNCTION\s+release_expired_form_monthly_card_checkout\([^)]*\)\s+FROM\s+PUBLIC/i);
  assert.match(releaseRpcSql, /REVOKE\s+ALL\s+ON\s+FUNCTION\s+release_expired_form_monthly_card_checkout\([^)]*\)\s+FROM\s+anon/i);
  assert.match(releaseRpcSql, /REVOKE\s+ALL\s+ON\s+FUNCTION\s+release_expired_form_monthly_card_checkout\([^)]*\)\s+FROM\s+authenticated/i);
  assert.match(releaseRpcSql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+release_expired_form_monthly_card_checkout\([^)]*\)\s+TO\s+service_role/i);
});

test('form-payment create: releases ONLY a verified expired session, then restarts create; retrieve failure fails closed', () => {
  // The create path retrieves the saved session and branches on the VERIFIED
  // Stripe status. A non-expired session resumes the existing checkout; only a
  // status === 'expired' session triggers the release.
  assert.match(formPaymentSource, /existingSession\.status\s*!==\s*['"]expired['"]/);
  const notExpiredIdx = formPaymentSource.indexOf("existingSession.status !== 'expired'");
  const releaseIdx = formPaymentSource.indexOf('releaseExpiredFormMonthlyCardCheckout(supabase', notExpiredIdx);
  assert.ok(notExpiredIdx >= 0 && releaseIdx > notExpiredIdx,
    'the release is reached only after the non-expired branch returns (i.e. status is verified expired)');

  // After a successful release the create handler re-enters ONCE to mint a
  // fresh agreement/session from the same still-pending submission.
  assert.match(formPaymentSource, /return handleCreateMonthlyCard\(req, res, supabase, tenantData\);/);
  const restartIdx = formPaymentSource.indexOf('return handleCreateMonthlyCard(req, res, supabase, tenantData);', releaseIdx);
  assert.ok(restartIdx > releaseIdx, 'create recurses after the release, not before');

  // FAIL CLOSED: if the session cannot be retrieved/verified, the handler
  // returns an error WITHOUT releasing anything (no destructive cleanup on an
  // unverifiable session).
  const verifyBlock = formPaymentSource.slice(
    formPaymentSource.indexOf('existingSession = await stripe.checkout.sessions.retrieve'),
    notExpiredIdx,
  );
  assert.ok(verifyBlock.length > 0, 'located the session-verification block');
  assert.match(verifyBlock, /catch \(err\)[\s\S]*?return res\.status\(500\)/);
  assert.doesNotMatch(verifyBlock, /releaseExpiredFormMonthlyCardCheckout/);
});

test('form-payment: a resource_missing Stripe error never triggers a release (fails closed)', () => {
  // resource_missing / 404 is handled where sessions are looked up, but it must
  // NEVER be treated as "expired" and must NEVER call the release RPC — a
  // missing session is unverifiable, so the reservation is left intact.
  assert.match(formPaymentSource, /resource_missing/);
  // No release call is co-located with resource_missing handling: scan every
  // resource_missing occurrence and assert none is followed (within the same
  // handler window) by a release call before the next return.
  const idxs = [];
  let from = 0;
  for (;;) {
    const i = formPaymentSource.indexOf('resource_missing', from);
    if (i < 0) break;
    idxs.push(i);
    from = i + 1;
  }
  assert.ok(idxs.length > 0, 'resource_missing handling is present');
  for (const i of idxs) {
    const window = formPaymentSource.slice(i, i + 400);
    assert.doesNotMatch(window, /releaseExpiredFormMonthlyCardCheckout/,
      'resource_missing must not lead into a release');
  }
});
