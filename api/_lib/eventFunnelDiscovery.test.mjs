import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeEventFunnelDiscovery,isDirectEventLookup } from './eventFunnelDiscovery.js';
test('direct identifiers and slugs retain standalone access, not discovery searches',()=>{
  assert.equal(isDirectEventLookup({id:'00000000-0000-4000-8000-000000000001'}),true);
  assert.equal(isDirectEventLookup({slug:'optional-parking'}),true);
  for(const filter of [null,{}, {id:{$in:['id']}},{slug:{$contains:'parking'}},{slug:''}]) {
    assert.equal(isDirectEventLookup(filter),false);
  }
});
test('discovery adds a database predicate without executing an async query builder',async()=>{
  const filters=[];let executed=0;
  const query={eq(...args){filters.push(args);return this;},then(){executed++;}};
  const result=await scopeEventFunnelDiscovery({db:{rpc:async()=>({data:true})},query});
  assert.equal(result.query,query);assert.equal(executed,0);
  assert.deepEqual(filters,[['event_funnel_discoverable',true]]);
});
test('admin discovery is unchanged while unknown failures never turn into an empty or broadened list',async()=>{
  const query={};let calls=0;
  const db={rpc:async()=>{calls++;return {error:{code:'timeout'}};}};
  assert.equal((await scopeEventFunnelDiscovery({db,query,isAdministrator:true})).query,query);
  assert.equal(calls,0);
  await assert.rejects(scopeEventFunnelDiscovery({db,query}));
  assert.equal((await scopeEventFunnelDiscovery({db:{rpc:async()=>({error:{code:'PGRST202'}})},query})).query,query);
});
