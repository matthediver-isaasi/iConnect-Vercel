import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStartQuote } from './memberStartQuote.js';
import { simulationFromMemberStart, startPaymentOptions, assertMemberStartAction } from './memberStartPayment.js';
import { simulationFromFeeCommitment, reserveRollingFeePayment, reserveRollingMonthlyHistory } from './rollingFeeCommitment.js';
import { buildCardAgreementSnapshot, resolveCardMonthlyOffer } from './stripeMonthlyCard.js';
import { buildAgreementSnapshot, resolveDdOffer } from './gocardlessDirectDebit.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const config = { id: id(2), tenant_id: id(3), structure_scope_type: 'member', is_active: true, billing_period: 'annual',
  start_mode: 'immediate', effective_from: '2025-01-01', currency: 'GBP', pricing_model: 'flat', flat_cost: 100,
  online_card_payment: true, card_monthly_enabled: true, dd_enabled: true, dd_auto_renew: false,
  dd_monthly_amount: 12, dd_instalment_count: 10, dd_activation_rule: 'first_payment' };
function fixture(mode, startMode = 'immediate') {
  const request = { memberId: id(1), configId: id(2), bandId: null, startDate: '2026-03-01', reason: 'Explicit new purchase', paymentMode: mode };
  const q = buildStartQuote({ request, config: { ...config, start_mode: startMode }, today: '2026-03-01' });
  const token = { tenant_id: id(3), member_id: id(1), history_record_id: id(4), membership_year: q.membershipYear,
    final_cost: q.finalCost, currency: q.currency, cost_breakdown: { memberStart: {
      version: 1, requestId: id(5), tenantId: id(3), memberId: id(1), recordId: id(4), quote: q,
    } } };
  return { request, q, token };
}
for (const startMode of ['immediate', 'fixed_date']) {
  for (const mode of ['stripe_upfront', 'stripe_monthly', 'direct_debit']) {
    test(`${startMode}/${mode}: explicit Start authority survives without matching current config`, () => {
      const { q, token } = fixture(mode, startMode);
      const sim = simulationFromFeeCommitment(token);
      assert.equal(sim.config.id, config.id);
      assert.equal(sim.membershipYear.start.toISOString().slice(0, 10), q.termStart);
      assert.equal(sim.membershipYear.end.toISOString().slice(0, 10), q.termEnd);
      assert.deepEqual(sim.existingRecord, { id: id(4) });
      assert.equal(sim.memberStart.paymentMode, mode);
      if (mode !== 'stripe_upfront') {
        assert.equal(q.paymentOffer.monthlyAmount, 12);
        assert.equal(q.paymentOffer.instalmentCount, 10);
        assert.equal(q.totalWithVat, 120);
        const card = mode === 'stripe_monthly';
        const offer = card ? resolveCardMonthlyOffer(sim) : resolveDdOffer(sim);
        const snapshot = card ? buildCardAgreementSnapshot({ offer, simResult: sim }) : buildAgreementSnapshot({ offer, simResult: sim });
        assert.deepEqual(snapshot.commitment, q.commitment);
        assert.equal(snapshot.membership_year, q.membershipYear);
      }
    });
  }
}
test('selected rail is enforced on the server, not merely hidden by the page', () => {
  const actions = ['create_payment', 'confirm_payment', 'start_monthly_card', 'start_direct_debit', 'submit_po'];
  for (const [mode, allowed] of [['stripe_upfront', ['create_payment', 'confirm_payment']], ['stripe_monthly', ['start_monthly_card']], ['direct_debit', ['start_direct_debit']]]) {
    const { token } = fixture(mode);
    for (const action of actions) {
      if (allowed.includes(action)) assert.doesNotThrow(() => assertMemberStartAction(token, action));
      else assert.throws(() => assertMemberStartAction(token, action), { code: 'member_start_payment_mode_locked' });
    }
  }
});
test('invalid or unsupported snapshot versions fail closed instead of rematching', () => {
  const mutations = [
    t => { t.cost_breakdown.memberStart.version = 99; },
    t => { t.cost_breakdown.memberStart.quote.version = 99; },
    t => { t.member_id = id(99); },
    t => { t.history_record_id = id(99); },
    t => { t.cost_breakdown.memberStart.quote.configId = id(99); },
    t => { t.cost_breakdown.memberStart.quote.termEnd = 'not-a-date'; },
    t => { t.cost_breakdown.memberStart.quote.totalWithVat = 999; },
    t => { t.cost_breakdown.memberStart.quote.targetSnapshot.config.tenant_id = id(99); },
  ];
  for (const mutate of mutations) {
    const { token } = fixture('stripe_upfront');
    mutate(token);
    assert.throws(() => simulationFromFeeCommitment(token), /incomplete or inconsistent/);
  }
  assert.equal(simulationFromMemberStart({}), null);
});
test('structure and selected-band options explain disabled modes and never borrow a flat monthly price', () => {
  const available = { stripe: true, directDebit: true, invoice: true };
  const flat = startPaymentOptions(config, null, available);
  assert.equal(flat.filter(p => p.available).length, 4);
  const tiered = { ...config, pricing_model: 'tiered' };
  const band = { annual_cost: 100, dd_monthly_amount: null };
  for (const mode of ['stripe_monthly', 'direct_debit']) {
    assert.match(startPaymentOptions(tiered, band, available).find(p => p.mode === mode).reason, /monthly amount/);
  }
  assert.deepEqual(startPaymentOptions({ ...config, flat_cost: 0, dd_enabled: false, card_monthly_enabled: false }, null, available).filter(p => p.available).map(p => p.mode), ['free']);
  assert.equal(startPaymentOptions(config, null, {}).filter(p => p.available).length, 0);
  const dynamic = { ...config, dd_policy_version: 1, dd_collection_end_policy: 'continue', dd_pricing_policy: 'dynamic', dd_invoicing_mode: 'per_instalment' };
  assert.equal(startPaymentOptions(dynamic, null, available).find(p => p.mode === 'direct_debit').available, true);
});
test('Start monthly reservation attaches to saved history through the narrow RPC, never inserts another term', async () => {
  const { token, q } = fixture('direct_debit');
  const sim = simulationFromFeeCommitment(token);
  let calls = 0;
  const db = { from() { assert.fail('must not insert or rematch'); }, async rpc(name, args) {
    calls++;
    assert.equal(name, 'attach_member_start_agreement');
    assert.deepEqual(args, { p_start_id: id(5), p_agreement_id: id(6) });
    return { data: { id: id(4) }, error: null };
  } };
  assert.deepEqual(await reserveRollingMonthlyHistory(db, { id: id(6) }, { commitment: q.commitment }, sim), { id: id(4) });
  assert.equal(calls, 1);
});
test('Start upfront reservation reads the existing explicit purchase, including fixed-date terms', async () => {
  const { token, q } = fixture('stripe_upfront', 'fixed_date');
  const db = { from(name) {
    assert.equal(name, 'member_membership_history');
    return { select() { return this; }, eq() { return this; }, async maybeSingle() {
      return { data: { id: id(4), tenant_id: token.tenant_id, member_id: token.member_id,
        config_id: q.configId, band_id: q.bandId, annual_cost: q.annualCost, final_cost: q.finalCost,
        vat_amount: q.vatAmount, currency: q.currency, membership_year: q.membershipYear,
        payment_method: 'stripe', payment_status: 'unpaid', term_start_date: q.termStart, term_end_date: q.termEnd, total_with_vat: q.totalWithVat } };
    } };
  } };
  assert.equal((await reserveRollingFeePayment(db, token)).id, id(4));
});
