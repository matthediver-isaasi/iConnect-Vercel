import test from 'node:test';
import assert from 'node:assert/strict';
import {pruneFunnelConfirmations} from './eventFunnelConfirmationRetention.js';
test('retention runs one bounded batch and returns only counts',async()=>{
  assert.deepEqual(await pruneFunnelConfirmations({db:{rpc:async(name,args)=>{
    assert.equal(name,'event_funnel_confirmation_prune');assert.deepEqual(args,{p_limit:100});
    return {data:7};
  }}}),{status:'complete',redacted:7});
});
test('invalid or failed retention results cannot claim successful cleanup',async()=>{
  for(const result of [{error:{code:'42501'}},{data:null},{data:'3'},{data:101},{data:-1}]) {
    await assert.rejects(pruneFunnelConfirmations({db:{rpc:async()=>result}}),/requires retry/);
  }
});
