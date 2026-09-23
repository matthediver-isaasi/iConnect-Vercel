import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler as dataHandler } from './[id]/data.js';
import { createHandler as refreshHandler } from './[id]/refresh.js';
import { createHandler as cronHandler } from '../../cron/refresh-dashboard-widgets.js';
import { cacheResponse } from '../_lib/resultCache.js';

function response() {
  return { statusCode:200,headers:{},setHeader(k,v){ this.headers[k]=v; },
    status(code){ this.statusCode=code;return this; },json(body){ this.body=body;return this; } };
}
const actor = { memberId:'owner',tenantId:'tenant',permissions:{ view:true } };
const widget = { id:'widget',tenant_id:'tenant',scope:'shared',owner_member_id:null,
  config:{ source:'organization' },widget_type:'bar' };
function deps(overrides = {}) {
  const query = { select(){return this;},eq(){return this;},is(){return this;},
    single:async()=>({ data:widget }) };
  return { supabase:{from:()=>query},getDashboardActor:async()=>actor,
    readWidgetCache:async()=>({data:{rows:[{value:9}]},cache:{status:'current'}}),...overrides };
}

test('data and refresh reauthorize before cache access; Canvas personal and foreign rows fail closed',async()=>{
  for (const factory of [dataHandler,refreshHandler]) {
    for (const currentActor of [null,{...actor,permissions:{view:false}}]) {
      const res=response();
      await factory(deps({getDashboardActor:async()=>currentActor,readWidgetCache:()=>assert.fail('cache accessed')}))(
        {method:'POST',query:{id:'widget'}},res);
      assert.equal(res.statusCode,currentActor?403:401);
      assert.equal(res.headers['Cache-Control'],'private, no-store');
    }
    for (const changed of [{...widget,tenant_id:'foreign'},
      {...widget,scope:'personal',owner_member_id:'owner'},
      {...widget,scope:'personal',owner_member_id:'other'}]) {
      const db={from:()=>({select(){return this;},eq(){return this;},single:async()=>({data:changed})})};
      const res=response();
      await factory(deps({supabase:db,readWidgetCache:()=>assert.fail('cache accessed')}))(
        {method:'POST',query:{id:'widget',embed:'canvas'}},res);
      assert.equal(res.statusCode,404);
    }
  }
});
test('view permission suffices for refresh, errors explicit, unsupported verbs denied',async()=>{
  let options;
  const handler=refreshHandler(deps({readWidgetCache:async(_db,_w,_a,opts)=>{
    options=opts;return {data:null,cache:{status:'pending',pending:true}};
  }}));
  const res=response();
  await handler({method:'POST',query:{id:'widget'}},res);
  assert.equal(res.statusCode,200);
  assert.equal(options.refresh,true);
  const method=response();
  await handler({method:'GET',query:{id:'widget'}},method);
  assert.equal(method.statusCode,405);
  for(const [message,code] of [['Refresh limit reached',429],['Widget changed',409],['database missing',503]]){
    const failure=response();
    await handlerForError(message)({method:'POST',query:{id:'widget'}},failure);
    assert.equal(failure.statusCode,code);
  }
  function handlerForError(message){return refreshHandler(deps({readWidgetCache:async()=>{throw Error(message);}}));}
  const denied=response();
  await dataHandler(deps({getDashboardActor:async()=>{throw Error('role lookup failed');},
    readWidgetCache:()=>assert.fail('cache accessed')}))({method:'GET',query:{id:'widget'}},denied);
  assert.equal(denied.statusCode,503);
});
test('cron requires configured secret even when no environment secret exists',async()=>{
  for(const [secret,authorization,expected] of [[undefined,undefined,401],['secret','Bearer wrong',401],
    ['secret','Bearer secret',200]]){
    const res=response();
    await cronHandler({secret,supabase:{},runCacheScheduler:async()=>({attempted:0})})(
      {method:'GET',headers:{authorization}},res);
    assert.equal(res.statusCode,expected);
    assert.equal(res.headers['Cache-Control'],'private, no-store');
  }
});
test('status metadata never substitutes zero for missing success or hides a failed refresh',()=>{
  const now=Date.now();
  assert.equal(cacheResponse({due_at:new Date(now).toISOString()},now).data,null);
  const result={rows:[{value:23}]};
  const out=cacheResponse({result,updated_at:new Date(now-16*60000).toISOString(),
    due_at:new Date(now+60000).toISOString(),error:'Failed'},now);
  assert.deepEqual(out.data,result);
  assert.equal(out.cache.status,'failed');
  assert.equal(out.cache.pending,false);
  assert.equal(out.cache.retryAfterSeconds,60);
});