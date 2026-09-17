import test from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotFormMembershipPayment, saveFormMembershipPaymentQuote,
  loadFormMembershipPaymentQuote, historyFromFormPaymentSnapshot,
  formPaymentActivationFields,
  createReservedFormMembershipIntent,
} from './formMembershipPaymentQuote.js';
import { quoteFromSimulationResult } from './membershipQuote.js';
import { commitmentFromQuote } from './rollingMembershipCommitment.js';

function simulation(billingPeriod = 'annual') {
  return {
    success: true,
    config: { id: 'structure-a', start_mode: 'immediate', billing_period: billingPeriod, flat_cost: 240, currency: 'GBP' },
    membershipYear: { label: '2026/2027', start: '2026-09-15', end: '2027-09-14' },
    annualCost: 240, finalCost: 240, vatAmount: 48, totalWithVat: 288,
    currency: 'GBP', billingPeriod, tierLabel: 'Standard',
  };
}

for (const [period, renewal] of [['annual', '2027-09-15'], ['quarterly', '2026-12-15'], ['monthly', '2026-10-15']]) {
  test(`${period} upfront payment persists the Pricing-tab duration`, () => {
    const original = simulation(period);
    const saved = snapshotFormMembershipPayment(original);
    original.config.flat_cost = 300;
    original.membershipYear.start = '2027-01-01';
    const history = historyFromFormPaymentSnapshot(JSON.parse(JSON.stringify(saved)));
    assert.equal(history.membership_renewal_date, renewal);
    assert.equal(history.term_start_date, '2026-09-15');
    assert.equal(history.membership_year, 'rolling:2026-09-15');
    assert.equal(history.commitment_snapshot.config.flat_cost, 240);
    assert.equal(history.commitment_snapshot.payment_method, 'stripe');
    assert.equal(history.commitment_snapshot.payment_frequency, 'upfront');
    assert.equal(history.total_with_vat, 288);
  });
}

test('conditional form quote retains the same canonical commitment through finalization', () => {
  const quote = quoteFromSimulationResult(simulation('quarterly'), 'member');
  const savedQuote = JSON.parse(JSON.stringify(quote));
  const fields = commitmentFromQuote(savedQuote);
  assert.equal(quote.membership_year, fields.term_key);
  assert.equal(fields.term_duration_months, 3);
  assert.equal(fields.membership_renewal_date, '2026-12-15');
});

test('add-on prices and VAT are frozen with the payment and reconstructed exactly', () => {
  const addons = [{ line_total: 10, vat_rate: { effectiveRate: 20 } }];
  const snapshot = snapshotFormMembershipPayment(simulation(), addons);
  addons[0].line_total = 500;
  const history = historyFromFormPaymentSnapshot(snapshot);
  assert.equal(history.final_cost, 250);
  assert.equal(history.vat_amount, 50);
  assert.equal(history.total_with_vat, 300);
  assert.equal(history.commitment_snapshot.amounts.total_with_vat, 300);
});

test('renewal retains original anchor and predecessor when a payment callback is delayed', () => {
  const sim = simulation('monthly');
  sim.membershipYear.start = '2026-02-28';
  sim.previousTerm = { id: 'prior', term_key: 'rolling:2026-01-31', term_duration_months: 1, term_start_date: '2026-01-31', term_end_date: '2026-02-27', membership_renewal_date: '2026-02-28', term_anchor_date: '2026-01-31' };
  const history = historyFromFormPaymentSnapshot(snapshotFormMembershipPayment(sim));
  assert.equal(history.term_start_date, '2026-02-28');
  assert.equal(history.membership_renewal_date, '2026-03-31');
  assert.equal(history.previous_term_id, 'prior');
});

function database(result) {
  const filters = [];
  let inserted;
  const chain = {
    insert(row) { inserted = row; return this; },
    select() { return this; },
    eq(...args) { filters.push(args); return this; },
    async single() { return result; },
    async maybeSingle() { return result; },
  };
  return { async rpc() { return result; }, from(table) { assert.equal(table, 'membership_payment_quote'); return chain; }, filters, get inserted() { return inserted; } };
}

test('only a durably stored quote can be used to expose a chargeable intent', async () => {
  const db = database({ error: { message: 'write failed' } });
  await assert.rejects(saveFormMembershipPaymentQuote(db, {
    tenantId: 'tenant', memberId: 'member', snapshot: snapshotFormMembershipPayment(simulation()),
  }), /Could not save membership payment terms/);
});

test('confirmation loads tenant/member scoped quote and rejects entity substitution', async () => {
  const quote = snapshotFormMembershipPayment(simulation());
  const pi = { metadata: { membership_quote_id: 'quote', tenant_id: 'tenant', member_id: 'member', membership_year: quote.simResult.membershipYear.label } };
  const db = database({ data: { id: 'quote', member_id: 'member', organization_id: null, quote } });
  assert.equal((await loadFormMembershipPaymentQuote(db, pi)).simResult, quote.simResult);
  assert.deepEqual(db.filters, [['id', 'quote'], ['tenant_id', 'tenant'], ['member_id', 'member']]);
  await assert.rejects(loadFormMembershipPaymentQuote(db, { metadata: { ...pi.metadata, organization_id: 'foreign' } }), /identity/);
});

test('concurrent charge preparation adopts one reserved quote and one provider idempotency key', async () => {
  let reservation;
  const db = {
    async rpc(name, params) {
      if (name === 'reserve_form_membership_payment_quote') {
        reservation ||= { id: 'reserved', tenant_id: 'tenant', created_at: '2026-09-15T00:00:00Z', quote: params.p_quote };
        return { data: reservation };
      }
      assert.equal(name, 'bind_form_membership_payment_quote');
      assert.equal(params.p_quote_id, 'reserved');
      assert.equal(params.p_payment_intent_id, 'pi_one');
      return { data: true };
    },
  };
  const snapshot = snapshotFormMembershipPayment(simulation());
  snapshot.paymentIntentParams = { amount: 28800, currency: 'gbp', metadata: { tenant_id: 'tenant', member_id: 'member' } };
  const changed = structuredClone(snapshot);
  changed.paymentIntentParams.amount = 99900;
  const [first, second] = await Promise.all([snapshot, changed].map(value =>
    saveFormMembershipPaymentQuote(db, { tenantId: 'tenant', memberId: 'member', snapshot: value })));
  const keys = [];
  const stripe = { paymentIntents: { async create(params, options) {
    keys.push(options.idempotencyKey);
    assert.equal(params.amount, 28800);
    assert.equal(params.metadata.membership_quote_id, 'reserved');
    return { id: 'pi_one' };
  } } };
  const results = await Promise.all([first, second].map(value => createReservedFormMembershipIntent(db, stripe, value, '2026-09-15')));
  assert.deepEqual(keys, ['membership-quote:reserved', 'membership-quote:reserved']);
  assert.equal(results[0].id, results[1].id);
});

test('provider idempotency expiration does not create another intent', async () => {
  const reservation = { id: 'old', created_at: '2026-09-15T00:00:00Z', quote: {} };
  await assert.rejects(createReservedFormMembershipIntent({}, {}, reservation, '2026-09-17'), /requires review/);
});

test('an unbound intent is never exposed when durable binding fails', async () => {
  const reservation = {
    id: 'q1', tenant_id: 'tenant', created_at: '2026-09-15T00:00:00Z',
    quote: { paymentIntentParams: { amount: 24000, metadata: {} } },
  };
  const db = database({ error: { message: 'database unavailable' } });
  const stripe = { paymentIntents: { async create() { return { id: 'pi_reserved' }; } } };
  await assert.rejects(createReservedFormMembershipIntent(db, stripe, reservation, '2026-09-15'), /Could not bind/);
});

test('confirmed payment retains original organisation despite current association/client year changes', async () => {
  const quote = snapshotFormMembershipPayment(simulation());
  const pi = { id: 'pi_original', metadata: { membership_quote_id: 'q1', tenant_id: 'tenant', member_id: 'payer', organization_id: 'original-org', membership_year: 'rolling:2026-09-15' } };
  const db = database({ data: { id: 'q1', tenant_id: 'tenant', member_id: 'payer', organization_id: 'original-org', stripe_payment_intent_id: pi.id, quote } });
  const saved = await loadFormMembershipPaymentQuote(db, pi);
  assert.equal(saved.organizationId, 'original-org');
  assert.equal(saved.simResult.membershipYear.label, 'rolling:2026-09-15');
  assert.equal(historyFromFormPaymentSnapshot(saved).membership_payment_quote_id, 'q1');
  await assert.rejects(loadFormMembershipPaymentQuote(db, { ...pi, id: 'pi_other' }), /another PaymentIntent/);
});

test('new rolling payments cannot fall back to a fresh simulation when quote metadata is missing', async () => {
  await assert.rejects(loadFormMembershipPaymentQuote({}, { metadata: { membership_quote_version: '1' } }), /authoritative/);
  await assert.rejects(loadFormMembershipPaymentQuote({}, { metadata: { membership_year: 'rolling:2026-09-15' } }), /authoritative/);
});

test('fixed-cycle behavior does not acquire rolling commitment fields', () => {
  const sim = simulation();
  sim.config.start_mode = 'fixed_date';
  const saved = snapshotFormMembershipPayment(sim);
  assert.equal(saved.simResult.commitment, undefined);
  assert.equal(saved.simResult.membershipYear.label, '2026/2027');
});

test('accepted quote is not active history; payment before agreed commencement stays scheduled', () => {
  const snapshot = snapshotFormMembershipPayment(simulation());
  assert.equal(snapshot.simResult.status, undefined);
  assert.deepEqual(formPaymentActivationFields(snapshot.simResult.commitment, '2026-09-14'), {
    status: 'scheduled', scheduled_activation_date: '2026-09-15',
  });
  assert.deepEqual(formPaymentActivationFields(snapshot.simResult.commitment, '2026-09-15'), { status: 'active' });
  assert.equal(snapshot.simResult.commitment.term_start_date, '2026-09-15');
});