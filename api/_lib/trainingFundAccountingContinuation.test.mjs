import test from 'node:test';
import assert from 'node:assert/strict';
import { continueTrainingFundOperation, findTrainingFundOperation, trainingFundQueueEnabled } from './trainingFundAccountingContinuation.js';

const operation = {
  tenant_id: 'tenant', member_id: 'member', purchase_id: 'purchase', organization_id: 'org',
  payment_method: 'card', amount: 42.50,
  authority: { provider: 'xero', connectionId: 'connection', companyId: 'company',
    invoice: { frozen: true }, receiptEmail: 'buyer@example.test' },
};
const ready = { accounting_pending: false, invoiceNumber: 'INV-1' };
function fixture({ lostBind = false, started = new Date().toISOString(), intentId = null } = {}) {
  const calls = [];
  let storedId = intentId;
  const intents = new Map();
  const stripe = { accounts: { retrieve: async () => ({ id: 'acct_test' }) }, paymentIntents: {
    async create(payload, options) {
      calls.push(['create', payload, options]);
      if (!intents.has(options.idempotencyKey)) intents.set(options.idempotencyKey, { id: 'pi_one', client_secret: 'test-secret' });
      return intents.get(options.idempotencyKey);
    },
    async retrieve(id) { calls.push(['retrieve', id]); return { id, client_secret: 'test-secret' }; },
  } };
  return { calls, intents, args: { operation, getStripe: async () => stripe, getPublishableKey: async () => 'pk_test',
    db: { async rpc(name, params) {
      calls.push([name, params]);
      if (name === 'start_training_fund_card_setup') return { data: { status: 'pending', started_at: started, intent_id: storedId } };
      if (name === 'bind_training_fund_card_setup') {
        if (lostBind) { lostBind = false; return { error: new Error('lost linkage response') }; }
        storedId = params.p_intent;
        return { data: { bound: true } };
      }
      throw new Error(`Unexpected RPC ${name}`);
    } },
  } };
}
test('adoption requires both rollout controls AND explicit continuation verification', () => {
  const old = { ...process.env };
  try {
    process.env.ACCOUNTING_REQUEST_QUEUE_ENABLED = 'true';
    process.env.ACCOUNTING_REQUEST_QUEUE_SOURCES = 'training_fund_purchase';
    delete process.env.ACCOUNTING_TRAINING_FUND_CONTINUATION_VERIFIED;
    assert.equal(trainingFundQueueEnabled(), false);
    process.env.ACCOUNTING_TRAINING_FUND_CONTINUATION_VERIFIED = 'true';
    assert.equal(trainingFundQueueEnabled(), true);
  } finally {
    for (const key of ['ACCOUNTING_REQUEST_QUEUE_ENABLED','ACCOUNTING_REQUEST_QUEUE_SOURCES','ACCOUNTING_TRAINING_FUND_CONTINUATION_VERIFIED']) {
      if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
    }
  }
});
for (const method of ['invoice', 'card']) {
  for (const state of ['retry', 'unknown', 'running', 'review']) {
    test(`${method}: throttle/uncertain invoice (${state}) never starts payment or credits`, async () => {
      const f = fixture();
      const result = await continueTrainingFundOperation({ ...f.args, operation: { ...operation, payment_method: method } },
        { resume: async () => ({ accounting_pending: true, accounting_state: state }) });
      assert.equal(result.queued, true);
      assert.equal(result.purchaseId, 'purchase');
      assert.deepEqual(f.calls, []);
    });
  }
}
test('invoice completion returns invoice without payment or credit calls', async () => {
  const f = fixture();
  const result = await continueTrainingFundOperation({ ...f.args, operation: { ...operation, payment_method: 'invoice' } },
    { resume: async () => ready });
  assert.equal(result.invoiceNumber, 'INV-1');
  assert.deepEqual(f.calls, []);
});
test('lost Stripe linkage response and duplicate retry reuse exactly one intent and frozen parameters', async () => {
  const f = fixture({ lostBind: true });
  await assert.rejects(continueTrainingFundOperation(f.args, { resume: async () => ready }), /lost linkage/);
  const result = await continueTrainingFundOperation(f.args, { resume: async () => ready });
  assert.equal(result.paymentIntentId, 'pi_one');
  assert.equal(f.intents.size, 1);
  const creates = f.calls.filter(c => c[0] === 'create');
  assert.deepEqual(creates[0], creates[1]);
  assert.equal(creates[0][1].amount, 4250);
  await continueTrainingFundOperation(f.args, { resume: async () => ready });
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 2);
  assert.equal(f.calls.at(-1)[0], 'retrieve');
});
test('concurrent card continuations share a Stripe idempotency identity', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    continueTrainingFundOperation(f.args, { resume: async () => ready })));
  assert.equal(new Set(results.map(r => r.paymentIntentId)).size, 1);
  assert.equal(f.intents.size, 1);
});
test('expired uncertain Stripe setup is held for review without a create', async () => {
  const f = fixture({ started: new Date(Date.now() - 24 * 3600000).toISOString() });
  const result = await continueTrainingFundOperation(f.args, { resume: async () => ready });
  assert.equal(result.accountingState, 'review');
  assert.equal(f.intents.size, 0);
});
test('known Stripe IDs remain retrievable after key expiry', async () => {
  const f = fixture({ started: '2020-01-01', intentId: 'pi_saved' });
  const result = await continueTrainingFundOperation(f.args, { resume: async () => ready });
  assert.equal(result.paymentIntentId, 'pi_saved');
  assert.equal(f.intents.size, 0);
});
test('resume uses saved ownership; query failures do not select a legacy writer', async () => {
  const db = { from() { return this; }, select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: operation }; } };
  assert.equal(await findTrainingFundOperation({ db, requestKey: 'key' }), operation);
  db.maybeSingle = async () => ({ error: new Error('permission denied') });
  await assert.rejects(findTrainingFundOperation({ db, requestKey: 'key' }), /permission denied/);
});
