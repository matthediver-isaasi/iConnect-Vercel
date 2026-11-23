import test from 'node:test';
import assert from 'node:assert/strict';
import {createFunnelReversalCron} from './eventFunnelReversalCron.js';
function fixture(){
  const calls=[],options={db:{},getSecret:()=> 'fixture-only',run:async input=>{calls.push(input);return {status:'complete'};}};
  const req={method:'GET',headers:{authorization:'Bearer fixture-only'}};
  const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  return {calls,options,req,res,invoke:()=>createFunnelReversalCron(options)(req,res)};
}
test('missing or incorrect cron authorization cannot access recovery',async()=>{
  for(const secret of [undefined,'','wrong']){
    const f=fixture();f.options.getSecret=()=>secret;await f.invoke();
    assert.equal(f.res.code,401);assert.equal(f.calls.length,0);
  }
});
test('a sweep processes at most four operations under one fixed deadline',async()=>{
  const f=fixture();await f.invoke();assert.equal(f.res.code,200);assert.equal(f.calls.length,4);
  assert.equal(f.res.body.complete,4);assert.equal(new Set(f.calls.map(c=>c.deadlineAt)).size,1);
});
test('elapsed budget prevents another operation starting',async()=>{
  const f=fixture();let now=100000;f.options.now=()=>now;
  f.options.run=async()=>{now+=46000;return {status:'retry'};};
  await f.invoke();assert.equal(f.res.body.checked,1);assert.equal(f.res.body.retry,1);
});
test('empty queues stop immediately and failures expose no provider data',async()=>{
  const f=fixture();f.options.run=async()=>({status:'idle'});await f.invoke();assert.equal(f.res.body.checked,0);
  f.options.run=async()=>{throw new Error('PRIVATE PROVIDER ERROR');};await f.invoke();
  assert.equal(f.res.code,503);assert.ok(!JSON.stringify(f.res.body).includes('PRIVATE'));
});
