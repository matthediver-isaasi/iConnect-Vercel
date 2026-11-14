import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './awards.js';
const response=()=>({statusCode:200,setHeader(){},status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}});
test('awards worker fails closed before scheduling when cron authorization is wrong',async()=>{
  const res=response();let calls=0;
  await handler({method:'GET',headers:{authorization:'Bearer wrong'}},res,{
    cronSecret:'isolated-cron-test',supabase:{rpc:async()=>{calls++;throw new Error('must not run');}},
  });
  assert.equal(res.statusCode,401);assert.equal(calls,0);
});
test('awards worker queues configured events before claiming sends',async()=>{
  const calls=[],res=response();
  await handler({method:'GET',headers:{authorization:'Bearer isolated-cron-test'}},res,{
    cronSecret:'isolated-cron-test',supabase:{rpc:async(name)=>{
      calls.push(name);return{data:name==='awards_schedule_automatic_messages'?{queued:0,configurationsScanned:0}:[]};
    }},
  });
  assert.equal(res.statusCode,200);
  assert.deepEqual(calls,['awards_schedule_automatic_messages','awards_claim_deliveries','awards_claim_messages']);
  assert.deepEqual(res.body.outcomes,[]);
});
test('scheduler failures are reported without pretending delivery succeeded',async()=>{
  const res=response();
  await handler({method:'POST',headers:{authorization:'Bearer isolated-cron-test'}},res,{
    cronSecret:'isolated-cron-test',supabase:{rpc:async()=>({error:{message:'Fixture failure'}})},
  });
  assert.equal(res.statusCode,503);assert.equal(res.body.outcomes,undefined);
});
