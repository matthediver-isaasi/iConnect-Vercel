import test from 'node:test';
import assert from 'node:assert/strict';
import {assertLegacyFunnelReversalAllowed} from './eventFunnelReversalBoundary.js';
const scope={tenantId:'tenant',source:'booking',bookingIds:['booking-id']};
test('tenant/source/booking scope is checked before permitting legacy reversal',async()=>{
  const calls=[];
  await assertLegacyFunnelReversalAllowed({...scope,db:{rpc:async(name,args)=>{calls.push([name,args]);return {data:true};}}});
  assert.deepEqual(calls,[['event_funnel_legacy_reversal_allowed',{p_tenant:'tenant',p_source:'booking',p_ids:['booking-id']}]]);
});
test('shared checkouts fail explicitly before legacy side effects',async()=>{
  await assert.rejects(assertLegacyFunnelReversalAllowed({...scope,db:{rpc:async()=>({data:false})}}),{code:'FUNNEL_REVERSAL_REQUIRED'});
});
test('only missing staged schema permits legacy behavior; failures and malformed results deny',async()=>{
  for(const code of ['42883','PGRST202']) {
    await assertLegacyFunnelReversalAllowed({...scope,db:{rpc:async()=>({error:{code}})}});
  }
  for(const result of [{data:null},{data:'true'},{error:{code:'42501'}},{error:{code:'network'}}]) {
    await assert.rejects(assertLegacyFunnelReversalAllowed({...scope,db:{rpc:async()=>result}}),{code:'FUNNEL_REVERSAL_UNAVAILABLE'});
  }
});
test('large batches inspect every booking without sending large URLs',async()=>{
  const calls=[];
  await assert.rejects(assertLegacyFunnelReversalAllowed({...scope,bookingIds:Array.from({length:1001},(_,i)=>`id-${i}`),
    db:{rpc:async(_,args)=>{calls.push(args);return {data:calls.length===1};}}}),{code:'FUNNEL_REVERSAL_REQUIRED'});
  assert.equal(calls[0].p_ids.length,1000);assert.deepEqual(calls[1].p_ids,['id-1000']);
});
