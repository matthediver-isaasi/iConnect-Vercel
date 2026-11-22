import test from 'node:test';
import assert from 'node:assert/strict';
import { operationalMemberQuery,lifecycleVisibilityInstalled,isOperationalLifecycleMember } from './memberLifecycleVisibility.js';
test('operational scoping happens before execution and never awaits a query builder prematurely',async()=>{
  let executed=0;const filters=[];
  const query={not(...args){filters.push(args);return this;},then(resolve){executed++;resolve({data:[]});}};
  const db={rpc:async()=>({data:true})};
  const result=await operationalMemberQuery(db,query);
  assert.equal(executed,0);assert.equal(result.query,query);
  assert.deepEqual(filters,[['lifecycle_state','in','(archived,minimised,deleted)']]);
  await result.query;assert.equal(executed,1);
});
test('only explicit absent migration permits legacy behavior; source failures are not empty lists',async()=>{
  assert.equal(await lifecycleVisibilityInstalled({rpc:async()=>({error:{code:'PGRST202'}})}),false);
  await assert.rejects(lifecycleVisibilityInstalled({rpc:async()=>({error:{code:'42501'}})}));
  for(const lifecycle_state of ['archived','minimised','deleted'])assert.equal(isOperationalLifecycleMember({lifecycle_state}),false);
  assert.equal(isOperationalLifecycleMember({lifecycle_state:'former'}),true);
});
