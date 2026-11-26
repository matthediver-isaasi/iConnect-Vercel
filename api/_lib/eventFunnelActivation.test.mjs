import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withFunnelWorkerActivation } from './eventFunnelActivation.js';

const sha = 'a'.repeat(40);
function fixture({ runtime = { environment:'production', release:sha }, admission = { data:{ version:1, enabled:true } },
  throws = false } = {}) {
  const calls = [];
  const handle = withFunnelWorkerActivation({
    db:{ async rpc(name,args) { calls.push([name,args]); if(throws) throw Error('provider unavailable'); return admission; } },
    worker:'recovery', getRuntime:()=>runtime, getSecret:()=>'fixture-only',
    handler:async (_req,res)=>{ calls.push(['work']); return res.status(200).json({ worked:true }); },
  });
  return { calls, async invoke({ method='GET', token='Bearer fixture-only' }={}) {
    const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handle({method,headers:{authorization:token}},res);return res;
  } };
}
test('worker authenticates before admission and only accepts supported methods',async()=>{
  const f=fixture();
  assert.equal((await f.invoke({token:''})).code,401);
  assert.equal((await f.invoke({token:'Bearer wrong'})).code,401);
  assert.equal((await f.invoke({method:'DELETE'})).code,405);
  assert.deepEqual(f.calls,[]);
});
test('preview, local and unknown release runtimes never claim production health or do work',async()=>{
  for(const runtime of [{environment:'preview',release:sha},{environment:'development',release:sha},
    {environment:'production',release:''},{}]) {
    const f=fixture({runtime});assert.equal((await f.invoke()).body.status,'disabled');assert.deepEqual(f.calls,[]);
  }
});
test('disabled, missing, malformed or failed admission never invokes provider work',async()=>{
  for(const admission of [{data:{version:1,enabled:false}},{error:{code:'PGRST202'}},{data:{}},
    {data:{version:2,enabled:true}},{data:{version:1,enabled:'true'}}]) {
    const f=fixture({admission});await f.invoke();assert.equal(f.calls.length,1);
  }
  const f=fixture({throws:true});assert.equal((await f.invoke()).code,503);assert.equal(f.calls.length,1);
});
test('matching admitted production workers run independently of new-purchasing readiness',async()=>{
  const f=fixture();
  assert.deepEqual((await f.invoke()).body,{worked:true});
  assert.deepEqual(f.calls,[['event_funnel_worker_admission',{p_worker:'recovery',p_version:1,p_release:sha}],['work']]);
});
test('both recovery schedules use the admission fence, never raw provider handlers',async()=>{
  const config=JSON.parse(await readFile(new URL('../../vercel.json',import.meta.url),'utf8'));
  for(const name of ['recovery','reversals']) {
    assert.ok(config.crons.some(job=>job.path===`/api/cron/event-funnel-${name}`&&job.schedule==='* * * * *'));
    const route=await readFile(new URL(`../cron/event-funnel-${name}.js`,import.meta.url),'utf8');
    assert.match(route,/export default withFunnelWorkerActivation/);
  }
});
