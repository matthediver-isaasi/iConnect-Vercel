import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFunnelStripeProvider } from './eventFunnelStripe.js';
const fixtureCredential = 'fixture-only-not-a-provider-key';
const frozen = { mode: 'test',accountFingerprint: createHash('sha256').update(fixtureCredential).digest('hex') };
test('the provider uses only the original tenant events account and preserves idempotency',async () => {
  const calls=[];
  class Client {
    constructor(value) {
      assert.equal(value,fixtureCredential);
      this.paymentIntents=Object.fromEntries(['create','retrieve','cancel'].map(method=>[method,async (...args)=>{calls.push([method,...args]);return {id:'pi_fixture'};}]));
    }
  }
  const provider = await createFunnelStripeProvider({tenantId:'tenant',
    loadCredentials:async (tenant,feature)=>{
      assert.equal(tenant,'tenant');assert.equal(feature,'events');
      return {secret_key:fixtureCredential,publishable_key:'fixture-public',mode:'test',is_enabled:false};
    },StripeClient:Client})(frozen);
  assert.equal(provider.canCreate,false);
  await provider.retrieve('pi_fixture');
  await provider.cancel('pi_fixture');
  await provider.create({amount:100},{idempotencyKey:'original'});
  assert.deepEqual(calls[0],['retrieve','pi_fixture',{expand:['latest_charge']}]);
  assert.deepEqual(calls[1],['cancel','pi_fixture',{}, {idempotencyKey:'event-funnel-cancel-pi_fixture'}]);
  assert.deepEqual(calls[2],['create',{amount:100},{idempotencyKey:'original'}]);
  assert.equal(JSON.stringify(provider).includes(fixtureCredential),false);
});
test('a changed key, mode or unavailable configuration cannot construct a provider client',async () => {
  for(const credentials of [null,{secret_key:'different',publishable_key:'fixture',mode:'test'},
    {secret_key:fixtureCredential,publishable_key:'fixture',mode:'live'}]) {
    await assert.rejects(createFunnelStripeProvider({tenantId:'tenant',loadCredentials:async()=>credentials,
      StripeClient:class {constructor(){throw new Error('Must not construct');}}})(frozen),{code:'PAYMENT_ACCOUNT_UNAVAILABLE'});
  }
});
