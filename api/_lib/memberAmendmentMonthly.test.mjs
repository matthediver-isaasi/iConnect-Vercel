import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemberAmendmentMonthlyService, monthlyAmendmentFingerprint,
} from './memberAmendmentMonthly.js';
import { allStripeInvoices, allGoCardlessPayments } from './memberAmendmentMonthlyProviders.js';

const epoch = date => Date.parse(`${date}T10:00:00Z`) / 1000;
const copy = value => structuredClone(value);
function fixture(provider = 'stripe', basis = 'annual_instalments') {
  const terms = { kind: provider === 'stripe' ? 'monthly_card' : 'monthly_direct_debit',
    accepted_at: '2026-01-01T09:00:00Z', monthly_amount_minor: 1000,
    currency: 'GBP', commitment: { term_key: 'term-original' }, instalment_count: 3 };
  const input = {
    tenantId: 'tenant-a', memberId: 'member-a', amendmentId: 'amendment-123',
    effectiveDate: '2026-02-01',
    purchase: { id: 'purchase-a', tenant_id: 'tenant-a', member_id: 'member-a',
      billing_agreement_id: 'agreement-a', status: 'active' },
    agreement: { id: 'agreement-a', tenant_id: 'tenant-a', member_id: 'member-a',
      agreement_type: 'member', status: 'active', provider, environment: provider === 'stripe' ? 'test' : 'sandbox',
      stripe_subscription_id: 'sub-a', stripe_customer_id: 'payer-a',
      gocardless_mandate_id: 'mandate-a', metadata: { [provider === 'stripe' ? 'card' : 'dd']: terms } },
    plan: { id: 'plan-a', tenant_id: 'tenant-a', member_id: 'member-a',
      billing_agreement_id: 'agreement-a', status: 'active', provider,
      environment: provider === 'stripe' ? 'test' : 'sandbox', currency: 'GBP',
      stripe_subscription_id: 'sub-a', stripe_customer_id: 'payer-a',
      gocardless_subscription_id: 'gc-sub-a', gocardless_mandate_id: 'mandate-a' },
    authority: { tenantId: 'tenant-a', memberId: 'member-a', purchaseId: 'purchase-a',
      agreementId: 'agreement-a', planId: 'plan-a', provider,
      environment: provider === 'stripe' ? 'test' : 'sandbox', payerId: 'payer-a',
      termKey: 'term-original', termsHash: monthlyAmendmentFingerprint(terms),
      pricingBasis: basis, currency: 'GBP', finiteEnd: epoch('2026-04-01'),
      collectionDates: ['2026-01-01', '2026-02-01', '2026-03-01'] },
    target: { currency: 'GBP', termTotalMinor: 4000, amountMinor: 1500, stripePriceId: 'price-new' },
  };
  const state = {
    sub: { id: 'sub-a', customer: 'payer-a', livemode: false, status: 'active',
      metadata: { kind: 'monthly_card', tenant_id: 'tenant-a', member_id: 'member-a' },
      schedule: 'schedule-a', billing_cycle_anchor: epoch('2026-01-01'),
      items: { data: [{ price: 'price-old', quantity: 1 }] } },
    schedule: { id: 'schedule-a', status: 'active', subscription: 'sub-a', customer: 'payer-a',
      livemode: false, metadata: { kind: 'monthly_card', agreement_id: 'agreement-a', retained: 'yes' },
      end_behavior: 'cancel', current_phase: { start_date: epoch('2026-01-01'), end_date: epoch('2026-04-01') },
      phases: [{ start_date: epoch('2026-01-01'), end_date: epoch('2026-04-01'),
        items: [{ price: 'price-old', quantity: 1 }], proration_behavior: 'none' }] },
    invoices: [{ id: 'in-jan', status: 'paid', amount_remaining: 0, customer: 'payer-a',
      currency: 'gbp', total: 1000, amount_paid: 1000,
      lines: { data: [{ amount: 1000, period: { start: epoch('2026-01-01') } }], has_more: false } }],
    gcSub: { id: 'gc-sub-a', status: 'active', amount: 1000, currency: 'GBP',
      interval_unit: 'monthly', interval: 1, count: 3, links: { mandate: 'mandate-a' },
      metadata: { tenant_id: 'tenant-a', agreement_id: 'agreement-a', plan_id: 'plan-a' },
      upcoming_payments: [{ charge_date: '2026-02-01', amount: 1000 }, { charge_date: '2026-03-01', amount: 1000 }] },
    mandate: { id: 'mandate-a', status: 'active', links: { customer: 'payer-a' },
      next_possible_charge_date: '2026-01-22' },
    payments: [{ id: 'payment-jan', status: 'paid_out', currency: 'GBP', amount: 1000,
      charge_date: '2026-01-01', links: { mandate: 'mandate-a', subscription: 'gc-sub-a' } }],
    writes: [], timeout: false,
  };
  const stripe = {
    subscriptions: { retrieve: async () => copy(state.sub) },
    customers: { retrieve: async () => ({ id: 'payer-a', metadata: { tenant_id: 'tenant-a', member_id: 'member-a' } }) },
    subscriptionSchedules: {
      retrieve: async () => copy(state.schedule),
      update: async (id, params, options) => {
        state.writes.push({ id, params: copy(params), options });
        state.schedule = { ...state.schedule, ...copy(params) };
        if (state.timeout) throw new Error('socket timeout after provider accepted');
        return copy(state.schedule);
      },
    },
    invoices: { list: async () => ({ data: copy(state.invoices), has_more: false }) },
    invoicePayments: { list: async () => ({ data: [{ id: 'ip-a', amount_paid: 1000,
      payment: { type: 'payment_intent', payment_intent: 'pi-a' } }], has_more: false }) },
    paymentIntents: { retrieve: async () => ({ id: 'pi-a', status: 'succeeded', customer: 'payer-a',
      livemode: false, currency: 'gbp', amount: 1000, latest_charge: 'ch-a' }) },
    charges: { retrieve: async () => ({ id: 'ch-a', paid: true, captured: true, refunded: false,
      amount_refunded: 0, disputed: false, customer: 'payer-a', livemode: false, currency: 'gbp', amount: 1000 }) },
    prices: { retrieve: async id => ({ id, active: true, livemode: false, currency: 'gbp',
      unit_amount: id === 'price-old' ? 1000 : 1500, type: 'recurring', billing_scheme: 'per_unit',
      recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } }) },
  };
  const gc = {
    getGocardlessEnvironment: () => 'sandbox',
    getMandate: async () => copy(state.mandate), getSubscription: async () => copy(state.gcSub),
    listPaymentsPage: async () => ({ payments: copy(state.payments), after: null }),
    updateSubscriptionAmount: async (id, params) => {
      state.writes.push({ id, params: copy(params) });
      state.gcSub.amount = params.amountMinor;
      state.gcSub.upcoming_payments.forEach(p => { p.amount = params.amountMinor; });
      if (state.timeout) throw new Error('socket timeout after provider accepted');
      return copy(state.gcSub);
    },
  };
  const service = createMemberAmendmentMonthlyService({
    getStripe: async () => stripe, getGc: async () => gc, now: () => new Date('2026-01-15T12:00:00Z'),
  });
  return { input, state, stripe, gc, service };
}
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test('annual card quote retains paid invoice and splits finite schedule without proration/cancellation', async () => {
  const { input, state, service } = fixture();
  const original = copy(input);
  const prepared = await service.prepare(input);
  assert.equal(state.writes.length, 0);
  assert.equal(prepared.quote.retainedMinor, 1000);
  assert.equal(prepared.quote.amountMinor, 1500);
  assert.equal(prepared.quote.prospectiveTotalMinor, 3000);
  assert.equal(prepared.mutation.params.end_behavior, 'cancel');
  assert.equal(prepared.mutation.params.phases[0].start_date, epoch('2026-01-01'));
  assert.equal(prepared.mutation.params.phases[0].items[0].price, 'price-old');
  assert.equal(prepared.mutation.params.phases[1].end_date, epoch('2026-04-01'));
  assert.equal(prepared.mutation.params.phases[1].start_date, epoch('2026-02-01'));
  assert.ok(prepared.mutation.params.phases.every(p => p.proration_behavior === 'none'));
  const result = await service.apply(JSON.parse(JSON.stringify(prepared)));
  assert.equal(result.status, 'provider_applied');
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].options.idempotencyKey, prepared.idempotencyKey);
  assert.deepEqual(input, original, 'purchase and consent are never rewritten');
  assert.equal((await service.apply(prepared)).replayed, true);
  assert.equal(state.writes.length, 1);
});

test('true month-priced card uses prospective price, not annual remainder redistribution', async () => {
  const { input, service } = fixture('stripe', 'monthly_price');
  input.target.termTotalMinor = 999999;
  assert.equal((await service.quote(input)).amountMinor, 1500);
});

test('fixed DD is a real amount-only provider operation preserving count and historical payments', async () => {
  const { input, state, service } = fixture('gocardless');
  const prepared = await service.prepare(input);
  const before = copy(state.payments);
  assert.equal(prepared.mutation.kind, 'gc_amount');
  assert.equal((await service.apply(prepared)).status, 'provider_applied');
  assert.deepEqual(Object.keys(state.writes[0].params).sort(), ['amountMinor', 'idempotencyKey']);
  assert.equal(state.gcSub.count, 3);
  assert.deepEqual(state.payments, before);
  assert.equal((await service.apply(prepared)).replayed, true);
  assert.equal(state.writes.length, 1);
});

for (const provider of ['stripe', 'gocardless']) {
  test(`${provider}: accepted-then-timeout is uncertain and read-only reconciliation recovers`, async () => {
    const { input, state, service } = fixture(provider);
    const prepared = await service.prepare(input);
    state.timeout = true;
    assert.equal((await service.apply(prepared)).status, 'uncertain');
    assert.equal(state.writes.length, 1);
    assert.equal((await service.reconcile(prepared)).status, 'provider_applied');
    assert.equal(state.writes.length, 1);
  });
  test(`${provider}: provider state drift after preparation prevents writes`, async () => {
    const { input, state, service } = fixture(provider);
    const prepared = await service.prepare(input);
    if (provider === 'stripe') state.schedule.metadata.external_change = 'changed';
    else state.gcSub.count = 4;
    await rejects(service.apply(prepared), 'provider_state_changed');
    assert.equal(state.writes.length, 0);
  });
  test(`${provider}: annual obligations cannot be replaced by a monthly amount alone`, async () => {
    const { input, service } = fixture(provider);
    delete input.target.termTotalMinor;
    await rejects(service.prepare(input), 'annual_obligation_required');
  });
  test(`${provider}: submitted/generated effective collection is immutable even if not settled`, async () => {
    const { input, state, service } = fixture(provider);
    if (provider === 'stripe') {
      state.invoices.push({ ...copy(state.invoices[0]), id: 'in-feb', status: 'open' });
      await rejects(service.prepare(input), 'unresolved_invoice');
    } else {
      state.payments.push({ ...copy(state.payments[0]), id: 'payment-feb', status: 'submitted', charge_date: '2026-02-01' });
      await rejects(service.prepare(input), 'submitted_payment');
    }
    assert.equal(state.writes.length, 0);
  });
  test(`${provider}: tenant/member/mode authority mismatch fails before provider writes`, async () => {
    const { input, state, service } = fixture(provider);
    input.authority.memberId = 'other-member';
    await rejects(service.prepare(input), 'ownership_mismatch');
    assert.equal(state.writes.length, 0);
  });
  test(`${provider}: tampered persisted operation cannot be executed`, async () => {
    const { input, state, service } = fixture(provider);
    const prepared = await service.prepare(input);
    prepared.quote.amountMinor++;
    await rejects(service.apply(prepared), 'prepared_changed');
    assert.equal(state.writes.length, 0);
  });
}

test('fixed DD fails closed outside provider notice window', async () => {
  const { input, state, service } = fixture('gocardless');
  state.mandate.next_possible_charge_date = '2026-02-02';
  await rejects(service.prepare(input), 'gc_notice_or_boundary');
});

test('annual nonuniform remainder requires explicit finance review', async () => {
  const { input, service } = fixture();
  input.target.termTotalMinor = 4001;
  await rejects(service.prepare(input), 'nonuniform_instalments');
});

test('consent snapshot hash is binding and cannot be replaced by current configuration', async () => {
  const { input, service } = fixture();
  input.agreement.metadata.card.monthly_amount_minor = 2000;
  await rejects(service.prepare(input), 'purchase_authority_required');
});

test('Stripe actual provider payer/tenant ownership and live mode are checked', async () => {
  for (const [field, value] of [['customer', 'other-payer'], ['livemode', true]]) {
    const { input, state, service } = fixture();
    state.sub[field] = value;
    await rejects(service.prepare(input), 'stripe_ownership_mismatch');
  }
});

test('Stripe complex existing schedules/settings cannot be silently flattened', async () => {
  const f = fixture();
  f.state.schedule.phases.push(copy(f.state.schedule.phases[0]));
  await rejects(f.service.prepare(f.input), 'unsupported_stripe_schedule');
  const g = fixture();
  g.state.schedule.phases[0].discounts = [{ coupon: 'coupon-a' }];
  await rejects(g.service.prepare(g.input), 'unsupported_stripe_schedule');
  const h = fixture();
  h.state.schedule.phases[0].future_economic_setting = true;
  await rejects(h.service.prepare(h.input), 'unsupported_stripe_schedule');
});

test('no finite deadline extension and no non-anchor date amendment', async () => {
  const { input, service } = fixture();
  input.authority.collectionDates[1] = '2026-02-02';
  input.effectiveDate = '2026-02-02';
  await rejects(service.prepare(input), 'billing_boundary_required');
});

test('dynamic DD inspects real mandate/payments but apply explicitly requires core revision/reservation bridge', async () => {
  const { input, state, service } = fixture('gocardless', 'monthly_price');
  const terms = input.agreement.metadata.dd;
  terms.collection_policy = { version: 1, pricing_policy: 'dynamic', end_policy: 'stop' };
  terms.invoicing_mode = 'per_instalment';
  input.authority.termsHash = monthlyAmendmentFingerprint(terms);
  input.plan.metadata = { collection_mode: 'dynamic' };
  delete input.plan.gocardless_subscription_id;
  delete state.payments[0].links.subscription;
  state.payments[0].metadata = { plan_id: input.plan.id };
  const prepared = await service.prepare(input);
  assert.equal((await service.quote(input)).supported, false);
  await rejects(service.apply(prepared), 'dynamic_revision_required');
  assert.equal(state.writes.length, 0);
});

test('GoCardless mandate belongs to immutable payer, not merely a familiar plan id', async () => {
  const { input, state, service } = fixture('gocardless');
  state.mandate.links.customer = 'different-payer';
  await rejects(service.prepare(input), 'payer_mismatch');
});

test('failed DD payments are not redistributed or cancelled', async () => {
  const { input, state, service } = fixture('gocardless');
  state.payments[0].status = 'failed';
  await rejects(service.prepare(input), 'unresolved_payment');
});

test('Stripe refunded/disputed payment is not mistaken for settled annual authority', async () => {
  const { input, stripe, service } = fixture();
  stripe.charges.retrieve = async () => ({ paid: true, captured: true, refunded: true, amount_refunded: 1000 });
  await rejects(service.prepare(input), 'unresolved_invoice');
});

test('GoCardless amount acceptance without exact upcoming-payment amount confirmation remains uncertain', async () => {
  const { input, gc, state, service } = fixture('gocardless');
  gc.updateSubscriptionAmount = async () => { state.gcSub.amount = 1500; };
  const prepared = await service.prepare(input);
  assert.equal((await service.apply(prepared)).status, 'uncertain');
});

test('read-only pagination exhausts Stripe and GoCardless pages and detects cursor loops', async () => {
  const stripeCalls = [];
  assert.deepEqual(await allStripeInvoices({ invoices: { list: async query => {
    stripeCalls.push(query);
    return query.starting_after ? { data: [{ id: 'last' }], has_more: false }
      : { data: [{ id: 'first' }], has_more: true };
  } } }, 'sub'), [{ id: 'first' }, { id: 'last' }]);
  assert.equal(stripeCalls[1].starting_after, 'first');
  const gcCalls = [];
  assert.deepEqual(await allGoCardlessPayments({ listPaymentsPage: async query => {
    gcCalls.push(query);
    return query.after ? { payments: [{ id: 'last' }], after: null }
      : { payments: [{ id: 'first' }], after: 'cursor' };
  } }, 'mandate'), [{ id: 'first' }, { id: 'last' }]);
  assert.equal(gcCalls[1].after, 'cursor');
  await assert.rejects(allGoCardlessPayments({
    listPaymentsPage: async () => ({ payments: [], after: 'same' }),
  }, 'mandate'), /did not advance/);
  await assert.rejects(allStripeInvoices({ invoices: {
    list: async () => ({ data: [{ id: 'same' }], has_more: true }),
  } }, 'sub'), /did not advance/);
});

test('provider read errors do not fabricate empty payment history', async () => {
  const { input, gc, service } = fixture('gocardless');
  gc.listPaymentsPage = async () => { throw new Error('provider unavailable'); };
  await assert.rejects(service.prepare(input), /provider unavailable/);
});
