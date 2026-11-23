import test from 'node:test';
import assert from 'node:assert/strict';
import {createFunnelGuardedLegacyIntent} from './eventFunnelLegacyIntent.js';
const id='00000000-0000-4000-8000-000000000001';
const parameters={amount:1000,currency:'gbp',metadata:{event_id:'event'}};
function fixture() {
  const calls=[];
  const db={rpc:async(name,args)=>{
    calls.push(name);
    if(name==='event_funnel_prepare_legacy_intent')return {data:{id:args.p_id,request_hash:'hash',
      provider_request:{...args.p_parameters,metadata:{...args.p_parameters.metadata,event_funnel_legacy_authority_id:args.p_id}}}};
    if(name==='event_funnel_bind_legacy_intent')return {data:true};
    throw new Error(`Unexpected ${name}`);
  }};
  const stripe={paymentIntents:{create:async(request,options)=>{
    calls.push('stripe-create');assert.match(options.idempotencyKey,/event-access/);
    return {id:'pi_fixture',...request};
  }}};
  return {calls,input:{db,stripe,tenantId:id,eventKind:'simple',eventId:id,ticketIds:['default'],parameters}};
}
test('a pure legacy payment records access before Stripe and binds before exposing its response',async()=>{
  const {calls,input}=fixture();
  const payment=await createFunnelGuardedLegacyIntent(input,{newId:()=>id});
  assert.equal(payment.id,'pi_fixture');
  assert.deepEqual(calls,['event_funnel_prepare_legacy_intent','stripe-create','event_funnel_bind_legacy_intent']);
  assert.equal(parameters.metadata.event_funnel_legacy_authority_id,undefined);
});
test('restricted offers never reach the payment provider',async()=>{
  const {calls,input}=fixture();input.db.rpc=async()=>({error:{code:'PT403'}});
  await assert.rejects(createFunnelGuardedLegacyIntent(input),{statusCode:403});
  assert.deepEqual(calls,[]);
});
test('unknown binding outcomes do not expose a new payment secret',async()=>{
  const {input}=fixture(),rpc=input.db.rpc;
  input.db.rpc=async(name,args)=>name==='event_funnel_bind_legacy_intent'?{error:{code:'timeout'}}:rpc(name,args);
  await assert.rejects(createFunnelGuardedLegacyIntent(input),{statusCode:503});
});
test('missing authorization schema fails closed after activation',async()=>{
  const {input}=fixture();
  input.db.rpc=async(name)=>name==='event_funnel_readiness'?{data:{version:1,purchasing:true}}:{error:{code:'PGRST202'}};
  await assert.rejects(createFunnelGuardedLegacyIntent(input),{statusCode:503});
});
test('a pre-feature installation retains its original standalone provider request',async()=>{
  const {input}=fixture();
  input.db.rpc=async()=>({error:{code:'PGRST202'}});
  input.stripe.paymentIntents.create=async(request,options)=>{
    assert.deepEqual(request,parameters);assert.equal(options,undefined);return {id:'pi_legacy'};
  };
  assert.equal((await createFunnelGuardedLegacyIntent(input)).id,'pi_legacy');
});
