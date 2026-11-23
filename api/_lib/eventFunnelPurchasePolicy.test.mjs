import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStandaloneEventOffer } from './eventFunnelPurchasePolicy.js';
const scope={tenantId:'tenant',eventId:'event',eventKind:'simple',ticketIds:['A']};
test('standalone checks use server scope and reject same-checkout-only offers',async()=>{
  const calls=[];
  const db={rpc:async(name,args)=>{calls.push({name,args});return {data:false};}};
  await assert.rejects(assertStandaloneEventOffer({...scope,db}),{code:'FUNNEL_PREREQUISITE_REQUIRED',statusCode:403});
  assert.deepEqual(calls[0].args,{p_tenant:'tenant',p_kind:'simple',p_event:'event',p_tickets:['A']});
  await assertStandaloneEventOffer({...scope,db:{rpc:async()=>({data:true})}});
});
test('an installed or activated policy cannot disappear into legacy fallback',async()=>{
  for(const data of [{version:1,purchasing:true},{version:1,purchasing:false,purchasePolicyInstalled:true},null]) {
    const db={rpc:async name=>name==='event_funnel_readiness'?{data}:{error:{code:'PGRST202'}}};
    await assert.rejects(assertStandaloneEventOffer({...scope,db}),{code:'EVENT_OFFER_POLICY_UNAVAILABLE'});
  }
  await assertStandaloneEventOffer({...scope,db:{rpc:async()=>({error:{code:'PGRST202'}})}});
  await assert.rejects(assertStandaloneEventOffer({...scope,db:{rpc:async()=>({error:{code:'timeout'}})}}),{statusCode:503});
});
