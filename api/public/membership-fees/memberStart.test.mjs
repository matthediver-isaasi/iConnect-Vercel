import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicMembershipFeeHandler } from './[token].js';
import { buildStartQuote } from '../../_lib/memberStartQuote.js';
import { processStripeCardPlanEvent, ensureCardPlanForCheckout } from '../../_lib/stripeMonthlyCard.js';
import { processGocardlessEvent } from '../../_lib/gocardlessWebhookProcessor.js';
import { completeReminderFeeAccounting } from '../../_lib/reminderFeeAccounting.js';
import { resolveDynamicCollectionPrice } from '../../_lib/directDebitDynamicPipeline.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const today = new Date().toISOString().slice(0, 10);
function fixture(mode, dynamic = false, startMode = 'immediate') {
  const config = { id: id(2), tenant_id: id(3), structure_scope_type: 'member', is_active: true, billing_period: 'annual',
    start_mode: startMode, effective_from: '2020-01-01', currency: 'GBP', pricing_model: 'flat', flat_cost: 100,
    online_card_payment: true, card_monthly_enabled: true, dd_enabled: true, dd_auto_renew: false,
    dd_monthly_amount: 12, dd_instalment_count: 10, dd_activation_rule: 'first_payment',
    dd_policy_version: 1, dd_collection_end_policy: 'stop', dd_pricing_policy: dynamic ? 'dynamic' : 'fixed',
    dd_invoicing_mode: dynamic ? 'per_instalment' : 'annual' };
  const request = { memberId: id(1), configId: config.id, startDate: today, paymentMode: mode, reason: 'Explicit purchase' };
  const quote = buildStartQuote({ request, config, today });
  quote.accounting = { organizationName: 'Original purchaser', invoicingEmail: 'original@example.test',
    invoicingAddress: { address_line_1: 'Saved purchase address' }, nominalCode: 'MEM' };
  const token = { id: id(6), token: 'member-authority-token', tenant_id: id(3), member_id: id(1), history_record_id: id(4),
    membership_year: quote.membershipYear, final_cost: quote.finalCost, currency: 'GBP', tier_label: quote.tierLabel,
    status: 'pending', expires_at: '2099-01-01T00:00:00Z', cost_breakdown: {
      totalWithVat: quote.totalWithVat, vatAmount: quote.vatAmount, annualCost: quote.annualCost,
      memberStart: { version: 1, requestId: id(5), tenantId: id(3), memberId: id(1), recordId: id(4), quote },
    } };
  const history = { ...(quote.commitment.term_key ? quote.commitment : {}), id: id(4), tenant_id: id(3), member_id: id(1), config_id: config.id,
    membership_year: quote.membershipYear, term_start_date: quote.termStart, term_end_date: quote.termEnd,
    annual_cost: quote.annualCost, final_cost: quote.finalCost, vat_amount: quote.vatAmount, total_with_vat: quote.totalWithVat,
    currency: 'GBP', payment_status: 'unpaid', status: 'pending_payment_setup',
    payment_method: mode === 'stripe_upfront' ? 'stripe' : mode === 'stripe_monthly' ? 'card_monthly' : 'direct_debit' };
  const state = { membership_fee_token: [token], member_membership_history: [history],
    member: [{ id: id(1), tenant_id: id(3), first_name: 'Changed', email: 'changed@example.test' }] };
  let sequence = 50;
  const value = (row, key) => key.replaceAll('->>', '.').replaceAll('->', '.').split('.').reduce((v, k) => v?.[k], row);
  const db = { state, async rpc(name, args) {
    assert.equal(name, 'attach_member_start_agreement');
    assert.equal(args.p_start_id, id(5));
    history.billing_agreement_id = args.p_agreement_id;
    return { data: structuredClone(history), error: null };
  }, from(table) {
    state[table] ||= [];
    const filters = [];
    let update, insert, cached;
    const execute = () => {
      if (cached) return cached;
      let rows = state[table].filter(row => filters.every(f => f(row)));
      if (insert) {
        rows = (Array.isArray(insert) ? insert : [insert]).map(v => ({ id: id(sequence++), ...structuredClone(v) }));
        state[table].push(...rows);
      }
      if (update) rows.forEach(row => Object.assign(row, structuredClone(update)));
      return cached = { data: structuredClone(rows), error: null };
    };
    const chain = {
      select() { return chain; }, order() { return chain; }, limit() { return chain; }, range() { return chain; },
      eq(k, v) { filters.push(r => value(r, k) === v); return chain; },
      neq(k, v) { filters.push(r => value(r, k) !== v); return chain; },
      is(k, v) { filters.push(r => v == null ? value(r, k) == null : value(r, k) === v); return chain; },
      in(k, v) { filters.push(r => v.includes(value(r, k))); return chain; },
      not(k, op, v) { filters.push(r => op === 'is' ? value(r, k) != v : value(r, k) !== v); return chain; },
      or() { return chain; }, filter() { return chain; },
      update(v) { update = v; return chain; }, insert(v) { insert = v; return chain; },
      upsert(v) { insert = v; return chain; },
      async maybeSingle() { const r = execute(); return { data: r.data[0] || null, error: null }; },
      async single() { return chain.maybeSingle(); },
      then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
    };
    return chain;
  } };
  return { db, token, history, quote };
}
const response = () => ({ code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
  status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
async function call(handler, action, body = {}) {
  const res = response();
  await handler({ method: 'POST', query: { token: 'member-authority-token' }, headers: { host: 'tenant.example.test' }, body: { action, ...body } }, res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  return res.body;
}
function providers(f) {
  const calls = { intents: [], checkouts: [], billingRequests: [], flows: [], subscriptions: [] };
  let intent;
  const stripe = {
    customers: { list: async () => ({ data: [] }), create: async () => ({ id: 'cus_start' }) },
    paymentIntents: { create: async (args, options) => {
      calls.intents.push({ args, options });
      intent = { id: 'pi_start', client_secret: 'test-secret', status: 'succeeded', ...args };
      return intent;
    } },
    checkout: { sessions: { create: async (args, options) => {
      calls.checkouts.push({ args, options }); return { id: 'cs_start', url: 'https://checkout.stripe.test/start' };
    } } },
  };
  const gc = {
    createBillingRequest: async args => { calls.billingRequests.push(args); return { id: 'BR_START' }; },
    createBillingRequestFlow: async args => { calls.flows.push(args); return { id: 'BRF_START', authorisation_url: 'https://pay.gocardless.test/start' }; },
    getMandate: async () => ({ id: 'MD_START', status: 'active', next_possible_charge_date: today }),
    createSubscription: async args => { calls.subscriptions.push(args); return { id: 'SB_START' }; },
    getGocardlessEnvironment: () => 'sandbox',
  };
  const deps = { db: f.db, stripe, gc, sendDdLifecycleEmail: async () => ({ sent: false }),
    getStripeCredentials: async () => ({ is_enabled: true, secret_key: 'sk_test_isolated', publishable_key: 'pk_test_isolated' }),
    getGocardlessCredentials: async () => ({ accessToken: 'isolated', environment: 'sandbox' }),
    retrieveTenantPaymentIntent: async () => ({ paymentIntent: intent, stripe }) };
  return { calls, stripe, gc, deps };
}
for (const startMode of ['immediate', 'fixed_date']) test(`real public ${startMode} handler creates one upfront intent and confirms/reconciles the saved purchase and saved invoice address`, async () => {
  const f = fixture('stripe_upfront', false, startMode);
  const p = providers(f);
  let invoices = 0, workflows = 0;
  const provider = { name: 'xero', async createMembershipInvoice(args) {
    invoices++;
    assert.deepEqual(args.invoicingAddress, f.quote.accounting.invoicingAddress);
    assert.equal(args.organizationName, 'Original purchaser');
    assert.equal(args.nominalCode, 'MEM');
    return { invoiceId: 'invoice-start' };
  }, async applyStripePaymentToInvoice() { return { payment_recorded: true }; } };
  p.deps.reconciliation = {
    fireWorkflow: async () => { workflows++; return { fired: true }; },
    completeReminderAccounting: args => completeReminderFeeAccounting(args, {
      getProvider: async () => provider, getProviderByName: () => provider,
      resolveInvoiceAddress: () => assert.fail('must not rematch saved purchase address'),
    }),
  };
  const handler = createPublicMembershipFeeHandler(p.deps);
  const started = await call(handler, 'create_payment');
  assert.equal(started.paymentIntentId, 'pi_start');
  assert.equal(p.calls.intents.length, 1);
  assert.equal(f.history.payment_status, 'unpaid');
  await call(handler, 'create_payment');
  assert.equal(p.calls.intents.length, 1);
  const confirmed = await call(handler, 'confirm_payment', { paymentIntentId: 'pi_start' });
  assert.equal(confirmed.success, true);
  assert.equal(f.history.payment_status, 'paid');
  assert.equal(f.history.config_id, f.quote.configId);
  assert.equal(f.history.term_start_date, f.quote.termStart);
  await call(handler, 'confirm_payment', { paymentIntentId: 'pi_start' });
  assert.equal(invoices, 1);
  assert.equal(workflows, 1);
  assert.equal(f.db.state.member_membership_history.length, 1);
});
for (const mode of ['stripe_upfront', 'stripe_monthly', 'direct_debit']) test(`real public GET exposes only saved ${mode}; competing POSTs fail before provider calls`, async () => {
  const f = fixture(mode);
  const p = providers(f);
  const handler = createPublicMembershipFeeHandler(p.deps);
  const res = response();
  await handler({ method: 'GET', query: { token: f.token.token }, headers: {} }, res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.memberStart.paymentMode, mode);
  assert.equal(res.body.stripeEnabled, mode === 'stripe_upfront');
  assert.equal(res.body.cardMonthlyEnabled, mode === 'stripe_monthly');
  assert.equal(res.body.ddEnabled, mode === 'direct_debit');
  assert.equal(res.body.poAvailable, false);
  const actions = { stripe_upfront: 'create_payment', stripe_monthly: 'start_monthly_card', direct_debit: 'start_direct_debit' };
  for (const other of Object.keys(actions).filter(v => v !== mode)) {
    const rejected = response();
    await handler({ method: 'POST', query: { token: f.token.token }, headers: {}, body: { action: actions[other] } }, rejected);
    assert.equal(rejected.code, 409);
    assert.equal(rejected.body.code, 'member_start_payment_mode_locked');
  }
  assert.equal(p.calls.intents.length + p.calls.checkouts.length + p.calls.billingRequests.length, 0);
});
test('real public monthly-card handler creates Checkout from the saved terms; real invoice callback/replay advances the existing purchase once', async () => {
  const f = fixture('stripe_monthly');
  const p = providers(f);
  const handler = createPublicMembershipFeeHandler(p.deps);
  const started = await call(handler, 'start_monthly_card');
  assert.equal(started.checkoutUrl, 'https://checkout.stripe.test/start');
  assert.equal(p.calls.checkouts[0].args.line_items[0].price_data.unit_amount, 1200);
  assert.equal(Object.hasOwn(p.calls.checkouts[0].args.subscription_data, 'cancel_at'), false);
  await call(handler, 'start_monthly_card');
  assert.equal(p.calls.checkouts.length, 1);
  const agreement = f.db.state.membership_billing_agreements[0];
  assert.deepEqual(agreement.metadata.card.commitment, f.quote.commitment);
  await ensureCardPlanForCheckout({ agreement, session: { subscription: 'sub_start', customer: 'cus_start' }, db: f.db });
  const invoice = { id: 'in_start', subscription: 'sub_start', status: 'paid', amount_paid: 1200, amount_due: 1200,
    amount_remaining: 0, currency: 'gbp', starting_balance: 0, ending_balance: 0,
    lines: { data: [{ id: 'il_start', amount: 1200, metadata: {} }], has_more: false } };
  const event = { id: 'evt_start', type: 'invoice.paid', data: { object: invoice } };
  const result = await processStripeCardPlanEvent(event, { db: f.db, expectedTenantId: id(3) });
  assert.equal(result.handled, true);
  await processStripeCardPlanEvent(event, { db: f.db, expectedTenantId: id(3) });
  assert.equal(f.db.state.membership_payment_plans[0].instalments_paid, 1);
  assert.equal(f.history.payment_status, 'partial');
  assert.equal(f.history.status, 'active');
  assert.equal(f.db.state.member_membership_history.length, 1);
  assert.equal(f.history.term_end_date, f.quote.termEnd);
});
for (const dynamic of [false, true]) test(`real public ${dynamic ? 'dynamic' : 'fixed'} DD handler starts only mandate consent, resumes it without another provider flow`, async () => {
  const f = fixture('direct_debit', dynamic);
  const p = providers(f);
  const handler = createPublicMembershipFeeHandler(p.deps);
  const started = await call(handler, 'start_direct_debit');
  assert.equal(started.authorisationUrl, 'https://pay.gocardless.test/start');
  assert.equal(p.calls.billingRequests.length, 1);
  assert.equal(p.calls.subscriptions.length, 0);
  assert.equal(p.calls.billingRequests[0].paymentAmountMinor, undefined);
  await call(handler, 'start_direct_debit');
  assert.equal(p.calls.billingRequests.length, 1);
  assert.equal(p.calls.flows.length, 1);
  const agreement = f.db.state.membership_billing_agreements[0];
  assert.deepEqual(agreement.metadata.dd.commitment, f.quote.commitment);
  assert.equal(f.history.billing_agreement_id, agreement.id);
  assert.equal(f.history.payment_status, 'unpaid');
  if (dynamic) {
    assert.equal(f.history.total_with_vat, null);
    assert.equal(agreement.metadata.dd.collection_policy.pricing_policy, 'dynamic');
    const later = await resolveDynamicCollectionPrice(agreement, today, {
      configRows: [{ ...f.quote.targetSnapshot.config, dd_monthly_amount: 19 }], bandRows: [], vatRows: [],
    });
    assert.equal(later.monthly_amount_minor, 1900);
    assert.equal(agreement.metadata.dd.monthly_amount, 12);
    assert.equal(f.history.total_with_vat, null);
  } else {
    agreement.gocardless_mandate_id = 'MD_START';
    agreement.status = 'mandate_pending';
    // Callback email suppression is test-only; provider processing still runs.
    f.db.state.member[0].email = null;
    const event = { id: 'EV_START', resource_type: 'mandates', action: 'active', links: { mandate: 'MD_START' } };
    const callback = await processGocardlessEvent(event, { db: f.db, gc: p.gc });
    assert.equal(callback.handled, true);
    await processGocardlessEvent(event, { db: f.db, gc: p.gc });
    assert.equal(p.calls.subscriptions.length, 1);
    assert.equal(f.db.state.membership_payment_plans.length, 1);
    assert.equal(f.history.payment_status, 'unpaid');
    assert.equal(f.history.status, 'pending_payment_setup');
  }
  assert.equal(f.db.state.member_membership_history.length, 1);
});
