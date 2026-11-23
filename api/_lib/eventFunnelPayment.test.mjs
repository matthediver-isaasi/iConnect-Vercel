import test from 'node:test';
import assert from 'node:assert/strict';
import { createFunnelPaymentService, funnelPaymentRequest, validateFunnelPaymentEvidence } from './eventFunnelPayment.js';

function fixture({ createError = false, finalizeError = false } = {}) {
  const order = { id: 'order', tenant_id: 'tenant', session_id: 'session', state: 'payable',
    payment_method: 'card', payable_minor: 2000, currency: 'GBP', payment_intent_id: null,
    snapshot: { reservationExpiresAt:new Date(Date.now()+600000).toISOString(),
      paymentAuthority: { accountFingerprint: 'account', mode: 'test' }, purchaser: { email: 'buyer@example.test' } } };
  const intents = new Map(), calls = [], releases = [];
  let finalized = false;
  const store = {
    async read() { return structuredClone(order); },
    async preparePayment(id, parameters) {
      calls.push('prepare');
      if (!order.payment_request) { order.payment_request = structuredClone(parameters); order.payment_requested_at = new Date().toISOString(); }
      else assert.deepEqual(order.payment_request, parameters);
      return structuredClone(order);
    },
    async bindPayment(id, intentId) {
      assert.ok(!order.payment_intent_id || order.payment_intent_id === intentId);
      order.payment_intent_id = intentId; return structuredClone(order);
    },
    async markUncertain(id, reason) { order.state = 'payment_uncertain'; calls.push(reason); },
    async recordPayment(id, evidence) { order.verified_payment=structuredClone(evidence); return true; },
    async finalize(id, evidence) {
      calls.push('finalize');
      if (finalizeError) throw new Error('database unavailable');
      if (!finalized) { finalized = true; order.state = 'confirmed'; }
      return { orderId: id, state: 'confirmed', evidence };
    },
    async release(id, evidence) { releases.push(evidence); order.state = 'cancelled'; return { state: 'cancelled' }; },
  };
  const provider = {
    identity: order.snapshot.paymentAuthority, publishableKey: 'fixture',
    async create(parameters, options) {
      calls.push({ create: parameters, key: options.idempotencyKey });
      if (!intents.has(options.idempotencyKey)) intents.set(options.idempotencyKey, {
        ...parameters, id: 'pi_fixture', status: 'requires_payment_method', amount_received: 0, livemode: false, client_secret: 'fixture-only',
      });
      if (createError) { createError = false; throw new Error('lost response after provider created intent'); }
      return structuredClone(intents.get(options.idempotencyKey));
    },
    async retrieve() { calls.push('retrieve'); return structuredClone([...intents.values()][0]); },
    async cancel() { [...intents.values()][0].status = 'canceled'; },
  };
  return { order, calls, releases, provider, intents, store,
    service: createFunnelPaymentService({ store, providerFor: async () => provider }) };
}

test('captured charge evidence retains the real payment date without depending registration on accounting readiness',async()=>{
  const f=fixture();await f.service.ensurePayment(f.order);
  const intent={...[...f.intents.values()][0],status:'succeeded',amount_received:2000,
    capture_method:'automatic',created:100,
    latest_charge:{id:'ch_original',payment_intent:f.order.payment_intent_id,status:'succeeded',livemode:false,
      paid:true,captured:true,refunded:false,amount_refunded:0,amount_captured:2000,amount:2000,currency:'gbp',created:200}};
  const evidence=validateFunnelPaymentEvidence(f.order,intent);
  assert.equal(evidence.capturedCharge.paidAt,new Date(200000).toISOString());
  for(const change of [{capture_method:'manual'},{latest_charge:'ch_original'},
    {latest_charge:{...intent.latest_charge,payment_intent:'pi_other'}},
    {latest_charge:{...intent.latest_charge,amount_refunded:1}}]) {
    const result=validateFunnelPaymentEvidence(f.order,{...intent,...change});
    assert.equal(result.status,'succeeded');
    assert.equal(result.capturedCharge,undefined);
  }
});
test('persist-before-create and retries use the identical aggregate intent request/key', async () => {
  const f = fixture({ createError: true });
  await assert.rejects(f.service.ensurePayment(f.order), { code: 'PAYMENT_UNCERTAIN' });
  assert.equal(f.releases.length, 0);
  await f.service.ensurePayment(f.order);
  assert.equal(f.calls[0], 'prepare');
  const creates = f.calls.filter(call => call.create);
  assert.deepEqual(creates[0], creates[1]);
  assert.equal(f.intents.size, 1);
  assert.equal(f.order.payment_intent_id, 'pi_fixture');
});
test('paid commit failure retains the original payment and never releases or charges again', async () => {
  const f = fixture({ finalizeError: true });
  await f.service.ensurePayment(f.order);
  Object.assign([...f.intents.values()][0], { status: 'succeeded', amount_received: 2000 });
  await assert.rejects(f.service.reconcile(f.order), /database unavailable/);
  assert.equal(f.order.verified_payment.amountReceived,2000);
  f.provider.retrieve=async()=>{throw new Error('provider offline');};
  assert.deepEqual(await f.service.ensurePayment(f.order),{orderId:'order',state:'succeeded'});
  await assert.rejects(f.service.reconcile(f.order), /database unavailable/);
  await assert.rejects(f.service.cancel(f.order), /database unavailable/);
  assert.equal(f.calls.filter(call => call.create).length, 1);
  assert.equal(f.releases.length, 0);
});
test('expiry cannot authorize a second provider create beyond its idempotency replay window', async () => {
  const f = fixture();
  f.order.payment_request = funnelPaymentRequest(f.order);
  f.order.payment_requested_at = '2000-01-01T00:00:00Z';
  await assert.rejects(f.service.ensurePayment(f.order), { code: 'PAYMENT_RECONCILIATION_REQUIRED' });
  assert.equal(f.calls.filter(call => call.create).length, 0);
  assert.equal(f.releases.length, 0);
});
test('wrong account, amount, currency, ownership and provider mode cannot finalize', async () => {
  const f = fixture();
  await f.service.ensurePayment(f.order);
  const intent = [...f.intents.values()][0];
  for (const change of [{ amount: 1 }, { currency: 'eur' }, { livemode: true },
    { metadata: { ...intent.metadata, event_funnel_order_id: 'other' } },
    { status: 'succeeded', amount_received: 1 }]) {
    assert.throws(() => validateFunnelPaymentEvidence(f.order, { ...intent, ...change }));
  }
  f.provider.identity = { accountFingerprint: 'different', mode: 'test' };
  await assert.rejects(f.service.ensurePayment(f.order), { code: 'PAYMENT_ACCOUNT_UNAVAILABLE' });
});
test('cancel verifies provider terminal state and success wins a cancellation race', async () => {
  const f = fixture();
  await f.service.ensurePayment(f.order);
  f.provider.cancel = async () => Object.assign([...f.intents.values()][0], { status: 'succeeded', amount_received: 2000 });
  assert.equal((await f.service.cancel(f.order)).state, 'confirmed');
  assert.equal(f.releases.length, 0);
  const cancelled = fixture();
  await cancelled.service.ensurePayment(cancelled.order);
  assert.equal((await cancelled.service.cancel(cancelled.order)).state, 'cancelled');
  assert.deepEqual(cancelled.releases, [{ paymentIntentId: 'pi_fixture', outcome: 'cancelled' }]);
});
test('uncertain creation cannot be cancelled by discarding stock; non-card confirmation needs acceptance', async () => {
  const f = fixture({ createError: true });
  await assert.rejects(f.service.ensurePayment(f.order));
  await assert.rejects(f.service.cancel(f.order), { code: 'PAYMENT_UNCERTAIN' });
  assert.equal(f.releases.length, 0);
  f.order.payment_method = 'account';
  await assert.rejects(f.service.reconcile(f.order), { code: 'SUBMISSION_REQUIRED' });
  f.order.snapshot.submissionAccepted = true;
  assert.equal((await f.service.reconcile(f.order)).state, 'confirmed');
});
test('an expired unstarted checkout cannot create a payment and recovery safely releases it',async()=>{
  const f=fixture();
  f.order.snapshot.reservationExpiresAt=new Date(0).toISOString();
  await assert.rejects(f.service.ensurePayment(f.order),{code:'PAYMENT_TIMER_EXPIRED'});
  assert.equal(f.calls.length,0);
  assert.equal((await f.service.reconcile(f.order)).state,'cancelled');
  assert.deepEqual(f.releases,[{outcome:'not_started'}]);
});
test('new disabled payments are refused before recording a provider request',async()=>{
  const f=fixture();f.provider.canCreate=false;
  await assert.rejects(f.service.ensurePayment(f.order),{code:'PAYMENT_ACCOUNT_UNAVAILABLE'});
  assert.equal(f.order.payment_requested_at,undefined);
  assert.deepEqual(funnelPaymentRequest(f.order).payment_method_types,['card']);
});
