import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycleCron } from './member-lifecycle.js';
const response=()=>({code:200,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
test('cron is fail-closed without authentication or installed runtime',async()=>{
  for(const [secret,authorization,ready,expected] of [[null,undefined,true,503],['fixture',undefined,true,401],['fixture','Bearer fixture',false,503]]){
    const res=response();
    await createLifecycleCron({secret:()=>secret,ready:async()=>ready,process:async()=>assert.fail('must not process')})
      ({method:'GET',headers:{authorization}},res);
    assert.equal(res.code,expected);
  }
});
test('authenticated cron runs bounded processing and separate durable deliveries',async()=>{
  const calls=[];const res=response();
  await createLifecycleCron({secret:()=> 'fixture',ready:async()=>true,
    process:async()=>{calls.push('processing');return{processed:2};},
    operations:async()=>{calls.push('outbox');return{processed:1};},
    notice:async()=>{calls.push('notice');return{processed:1};}})
    ({method:'POST',headers:{authorization:'Bearer fixture'}},res);
  assert.deepEqual(calls,['processing','outbox','notice']);
  assert.deepEqual(res.body,{processed:2,deliveries:1,notifications:1});
});
