import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createFunnelStripeProvider} from './eventFunnelStripe.js';
const frozen={mode:'test',accountFingerprint:createHash('sha256').update('fixture-only-secret').digest('hex')};
async function fixture(pages) {
  const calls=[];
  class Client {
    charges={retrieve:async(...args)=>{calls.push(['charge',...args]);return {id:'ch'};}};
    refunds={list:async(...args)=>{calls.push(['list',...args]);return pages.shift();},
      create:async(...args)=>{calls.push(['create',...args]);return {id:'re'};}};
  }
  const provider=await createFunnelStripeProvider({tenantId:'tenant',StripeClient:Client,deadlineAt:Date.now()+30000,
    loadCredentials:async()=>({secret_key:'fixture-only-secret',publishable_key:'fixture-public',mode:'test',is_enabled:false})})(frozen);
  return {provider,calls};
}
test('refund recovery keeps original account and reads every provider page',async()=>{
  const {provider,calls}=await fixture([{data:[{id:'first'}],has_more:true},{data:[{id:'last'}],has_more:false}]);
  assert.equal(provider.canCreate,false);assert.deepEqual(await provider.authority(),frozen);
  assert.deepEqual(await provider.listAllRefunds('ch'),{complete:true,refunds:[{id:'first'},{id:'last'}]});
  assert.equal(calls[1][1].starting_after,'first');
  await provider.createRefund({charge:'ch',amount:100},{idempotencyKey:'original'});
  assert.equal(calls[2][2].idempotencyKey,'original');assert.equal(calls[2][2].maxNetworkRetries,0);
});
test('a broken provider cursor is not treated as complete refund history',async()=>{
  const {provider}=await fixture([{data:[],has_more:true}]);
  assert.deepEqual(await provider.listAllRefunds('ch'),{complete:false,refunds:[]});
});
