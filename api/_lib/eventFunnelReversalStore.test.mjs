import test from 'node:test';
import assert from 'node:assert/strict';
import {createFunnelCardReversalStore} from './eventFunnelReversalStore.js';
test('store pins the full operation scope and rejects false completion receipts',async()=>{
  const calls=[];let answer={data:true};
  const store=createFunnelCardReversalStore({tenantId:'tenant',orderId:'order',operationId:'op',
    db:{rpc:async(name,args)=>{calls.push({name,args});return answer;}}});
  assert.equal(await store.begin('op'),true);
  assert.deepEqual(calls[0].args,{p_tenant:'tenant',p_order:'order',p_id:'op',p_action:'begin',p_receipt:null});
  await assert.rejects(store.begin('another'),/identity/);assert.equal(calls.length,1);
  answer={data:false};assert.equal(await store.begin('op'),false);
  await assert.rejects(store.complete('op',{}),/conflicts/);
  for(const value of [{data:null},{error:{code:'PGRST202'}},{data:true,error:{code:'42501'}}]) {
    answer=value;await assert.rejects(store.complete('op',{}),/persisted/);
  }
});
