import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('./member-content-reindex.js',import.meta.url),'utf8');
const ui = await readFile(new URL('../../client/src/pages/platform/HelpArticlesEditor.jsx',import.meta.url),'utf8');
const TENANT='fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const RUN='10000000-0000-4000-8000-000000000001';
const OWNER='20000000-0000-4000-8000-000000000001';
const PAGE='30000000-0000-4000-8000-000000000001';
const clone=value=>JSON.parse(JSON.stringify(value));

function fixture(options={}) {
  const calls={acquire:[],renew:[],index:[],complete:[]};
  let savedScope;
  const db={from(table){
    assert.equal(table,'tenant');
    return {select(){return this;},eq(key,value){assert.equal(key,'id');assert.equal(value,TENANT);return this;},
      async maybeSingle(){return {data:options.tenantMissing?null:{id:TENANT},error:options.tenantError||null};}};
  }};
  const scope={tenantId:TENANT,contentType:'iedit_page',maxEmbeddingChunks:50,platformOwnerId:OWNER};
  const context=vm.createContext({
    console,Date,
    supabase:db,
    getSessionPlatformOwner:async()=>options.unauthorized?null:{id:options.ownerId||OWNER},
    getDefaultOpenAIClient:()=>options.noProvider?null:{},
    readReindexStatus:async()=>options.status||{ok:true,runId:RUN,scope:savedScope||scope},
    acquireReindexRun:async arg=>{
      calls.acquire.push(clone(arg.scope));savedScope=arg.scope;
      return options.acquire||{acquired:true,runId:RUN};
    },
    renewReindexRun:async arg=>{calls.renew.push(clone(arg));return options.renew||{owns:true};},
    completeReindexRun:async arg=>{calls.complete.push(clone(arg));},
    reindexAllMemberContent:async arg=>{
      calls.index.push(clone(arg));
      if(options.fatal)throw new Error('fixture failed');
      return options.results||{items:1,chunks:33,embedded:33,reused:0,errors:0,done:true,
        details:[{sourceId:PAGE,contentType:'iedit_page',coverage:[{code:'renderer_projection',detail:'Board names'}]}]};
    },
  });
  const code=source.replace(/^import[\s\S]*?;\n/gm,'').replace('export default async function handler','async function handler');
  vm.runInContext(`${code}\nthis.handler=handler;`,context);
  const invoke=async(body={},method='POST')=>{
    const res={statusCode:200,status(code){this.statusCode=code;return this;},json(data){this.body=clone(data);return this;}};
    await context.handler({method,body},res);return res;
  };
  return {calls,invoke};
}

test('platform session required before any operation or spending',async()=>{
  const f=fixture({unauthorized:true});
  assert.equal((await f.invoke()).statusCode,403);
  assert.equal(f.calls.index.length,0);
  assert.equal(f.calls.acquire.length,0);
});

test('scoped iEdit 50-chunk rebuild forwards scope and coverage; default stays 20',async()=>{
  const f=fixture();
  const res=await f.invoke({tenantId:TENANT,contentType:'iedit_page',maxEmbeddingChunks:50});
  assert.equal(res.statusCode,200);
  assert.equal(f.calls.index[0].tenantId,TENANT);
  assert.equal(f.calls.index[0].contentType,'iedit_page');
  assert.equal(f.calls.index[0].maxEmbeddingChunks,50);
  assert.equal(f.calls.acquire[0].platformOwnerId,OWNER);
  assert.equal(f.calls.complete[0].completed,false,'scoped work must not mark global completion');
  assert.equal(res.body.details[0].coverage[0].detail,'Board names');
  const defaults=fixture();await defaults.invoke();
  assert.equal(defaults.calls.index[0].maxEmbeddingChunks,20);
  assert.equal(defaults.calls.index[0].tenantId,null);
  assert.equal(defaults.calls.complete[0].completed,true);
});

test('continuation inherits persisted tenant/type/allowance and cannot widen or shrink them',async()=>{
  const f=fixture();
  const cursor={type:'iedit_page',lastId:PAGE};
  const res=await f.invoke({runId:RUN,cursor});
  assert.equal(res.statusCode,200);
  assert.equal(f.calls.index[0].maxEmbeddingChunks,50);
  assert.equal(f.calls.index[0].tenantId,TENANT);
  assert.equal(f.calls.renew[0].scope.contentType,'iedit_page');
  assert.deepEqual(f.calls.index[0].cursor,cursor);
  for(const changes of [{tenantId:null},{contentType:null},{contentType:'resource'},{maxEmbeddingChunks:100},{maxEmbeddingChunks:20}]) {
    const denied=fixture();
    assert.equal((await denied.invoke({runId:RUN,...changes})).statusCode,409);
    assert.equal(denied.calls.index.length,0);
    assert.equal(denied.calls.renew.length,0);
  }
});

test('continuation authority rejects other owners, old unscoped runs, missing marker and degraded RPCs',async()=>{
  for(const options of [
    {ownerId:PAGE},
    {status:{ok:true,runId:RUN,scope:{tenantId:null,contentType:null}}},
    {status:{ok:false,error:'unavailable'}},
    {status:{ok:true,runId:PAGE,scope:{}}},
    {renew:{owns:true,degraded:true}},
  ]) {
    const f=fixture(options);
    assert.ok((await f.invoke({runId:RUN})).statusCode>=400);
    assert.equal(f.calls.index.length,0);
  }
  const f=fixture({acquire:{acquired:true,runId:RUN,degraded:true}});
  assert.equal((await f.invoke()).statusCode,503);
  assert.equal(f.calls.index.length,0);
});

test('invalid tenants/types/budgets/cursors are rejected before ownership or spending',async()=>{
  for(const body of [
    {tenantId:'not-a-uuid'},{contentType:'ai_static'},{maxEmbeddingChunks:101},
    {maxEmbeddingChunks:-1},{maxEmbeddingChunks:1.5},{maxEmbeddingChunks:'50'},
    {maxEmbeddingChunks:null},{runId:'bad'},{cursor:[]},{cursor:{}},
    {contentType:'iedit_page',cursor:{type:'canvas_page',lastId:null}},
    {cursor:{type:'iedit_page',lastId:'bad'}},
  ]) {
    const f=fixture();
    assert.equal((await f.invoke(body)).statusCode,400,JSON.stringify(body));
    assert.equal(f.calls.index.length,0);
    assert.equal(f.calls.acquire.length,0);
  }
  for(const [options,status] of [[{tenantMissing:true},404],[{tenantError:{message:'offline'}},503]]) {
    const f=fixture(options);
    assert.equal((await f.invoke({tenantId:TENANT})).statusCode,status);
    assert.equal(f.calls.index.length,0);
  }
});

test('embedding pause releases authority, retains cursor, and requires a new explicit allowance',async()=>{
  const cursor={type:'iedit_page',lastId:PAGE};
  const f=fixture({results:{errors:1,done:false,nextCursor:cursor,stopReason:'embedding_budget',
    errorCode:'MEMBER_CONTENT_EMBEDDING_BUDGET',details:[{sourceId:PAGE,error:'33 chunks required'}]}});
  const res=await f.invoke({tenantId:TENANT,contentType:'iedit_page'});
  assert.equal(res.body.paused,true);
  assert.equal(res.body.done,false);
  assert.deepEqual(res.body.nextCursor,cursor);
  assert.equal(f.calls.index.length,1);
  assert.equal(f.calls.complete[0].completed,false);
  assert.equal(res.body.scope.maxEmbeddingChunks,20);
  // Explicit resume is a new operation; its reviewed allowance can differ.
  const resumed=fixture();
  await resumed.invoke({tenantId:TENANT,contentType:'iedit_page',maxEmbeddingChunks:100,cursor});
  assert.equal(resumed.calls.index[0].maxEmbeddingChunks,100);
  assert.equal(resumed.calls.acquire.length,1);
});

test('deadline continuation retains ownership; fatal error releases without completion',async()=>{
  const partial=fixture({results:{errors:0,done:false,nextCursor:{type:'iedit_page',lastId:PAGE}}});
  const res=await partial.invoke({tenantId:TENANT,contentType:'iedit_page'});
  assert.equal(res.body.paused,false);
  assert.equal(partial.calls.complete.length,0);
  const fatal=fixture({fatal:true});
  assert.equal((await fatal.invoke()).statusCode,500);
  assert.equal(fatal.calls.complete.length,1);
  assert.notEqual(fatal.calls.complete[0].completed,true);
});

test('durably checkpointed batches continue under the same approved per-slice allowance', async () => {
  const cursor = { type: 'iedit_page', lastId: null };
  const f = fixture({ results: { items: 0, chunks: 0, embedded: 100, reused: 0,
    errors: 0, done: false, nextCursor: cursor, stopReason: 'embedding_progress' } });
  const result = await f.invoke({ tenantId: TENANT, contentType: 'iedit_page', maxEmbeddingChunks: 100 });
  assert.equal(result.body.paused, false);
  assert.equal(result.body.done, false);
  assert.deepEqual(result.body.nextCursor, cursor);
  assert.equal(f.calls.complete.length, 0);
});

test('UI explicitly stops budget loops, offers bounded GFI scope and displays source coverage/errors',()=>{
  assert.match(ui,/setMemberReindexTenant\('fd82da65-aab7-4a5c-85b8-b2febeb2003d'\)/);
  assert.match(ui,/max="100"/);
  assert.match(ui,/JSON\.stringify\(\{ runId, cursor, \.\.\.scope \}\)/);
  assert.match(ui,/if \(data\.paused \|\| data\.stopReason === 'embedding_budget'\)[\s\S]*?return;/);
  assert.match(ui,/button-resume-member-reindex/);
  assert.match(ui,/member-reindex-coverage/);
  assert.match(ui,/detail\.error/);
  assert.match(ui,/detail\.coverage\.map/);
});
