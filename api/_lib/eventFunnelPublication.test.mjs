import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFunnelPublicationSnapshot } from './eventFunnelPublication.js';
import { createEventFunnelAdminHandler } from './eventFunnelAdmin.js';
const tenant='00000000-0000-4000-8000-000000000001', id='00000000-0000-4000-8000-000000000002',
  event='00000000-0000-4000-8000-000000000003', version='00000000-0000-4000-8000-000000000004';
const graph={version:1,tenantId:tenant,entry:'source',reservationSeconds:900,invoiceMode:'per_event',nodes:[
  {id:'source',type:'source',event:{id:event,kind:'simple',tenantId:tenant},ticketIds:['standard'],requires:[],accept:'checkout'},
  {id:'checkout',type:'checkout'},
]};
function fixture({ readiness={version:1,activationVersion:1,purchasing:true}, revision=1, error=null,
  snapshotFailure=false, missing=false, context={isAuthenticated:true,tenantId:tenant,tenantUserId:id},
  hasAdminAccess=async()=>true }={}) {
  const calls=[];
  const db={
    async rpc(name,args) {
      calls.push([name,args]);
      if(name==='event_funnel_consume_limit')return {data:true};
      if(name==='event_funnel_readiness')return {data:readiness};
      assert.equal(name,'event_funnel_publish');
      return {data:{published:true,versionId:version,revision:1},error};
    },
    from(table) {
      const q={select(){return this;},eq(k,v){calls.push(['filter',table,k,v]);return this;},
        async maybeSingle(){return {data:table==='event_funnel_definition'
          ?missing?null:{id,revision,graph}
          :{id:event,start_date:'2099-01-01',pricing_config:{ticket_classes:[{id:'standard'}]}}};}};
      return q;
    },
  };
  const handler=createEventFunnelAdminHandler({db,getContext:async()=>context,hasAdminAccess,hasFeatureAccess:async()=>true,
    loadPublicationSnapshot:async input=>{
      calls.push(['snapshot',input]);if(snapshotFailure)throw Error('unavailable');return {version:1,serverOwned:true};
    }});
  return {calls,async invoke(body={action:'publish',id,expectedRevision:1}) {
    const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handler({method:'POST',headers:{host:'example.test','content-type':'application/json'},body},res);return res;
  }};
}
test('publication uses the saved graph, verified actor and server-owned commercial evidence',async()=>{
  const f=fixture(),res=await f.invoke({action:'publish',id,expectedRevision:1,graph:{forged:true},
    commercial:{forged:true},tenantId:'foreign',actor:'forged'});
  assert.equal(res.code,200);assert.equal(res.body.published_version_id,version);
  assert.deepEqual(f.calls.find(c=>c[0]==='event_funnel_publish')[1],{
    p_tenant:tenant,p_definition:id,p_expected_revision:1,p_actor:`user:${id}`,
    p_commercial:{version:1,serverOwned:true}});
  assert.equal(f.calls.find(c=>c[0]==='snapshot')[1].graph,graph);
  assert.ok(f.calls.some(c=>c[1]==='event_funnel_definition'&&c[2]==='tenant_id'&&c[3]===tenant));
});
test('disabled, legacy or unknown activation contracts cannot publish',async()=>{
  for(const readiness of [{version:1,purchasing:true},{version:2,activationVersion:1,purchasing:true},
    {version:1,activationVersion:1,purchasing:false},null]) {
    const f=fixture({readiness});assert.equal((await f.invoke()).code,409);
    assert.ok(!f.calls.some(c=>c[0]==='event_funnel_publish'||c[0]==='snapshot'));
  }
});
test('stale revisions, missing definitions, missing pricing and database conflicts fail closed',async()=>{
  for(const [options,status] of [[{revision:2},409],[{missing:true},404],[{snapshotFailure:true},500],
    [{error:{code:'PT409'}},409],[{error:{code:'PT404'}},404],[{error:{code:'PGRST202'}},503]]) {
    const f=fixture(options);assert.equal((await f.invoke()).code,status);
  }
});
test('publication keeps authentication, tenant and administrator boundaries',async()=>{
  for(const [options,status] of [[{context:null},401],[{context:{tenantMismatch:true}},409],
    [{hasAdminAccess:async()=>false},403]]) {
    const f=fixture(options);assert.equal((await f.invoke()).code,status);
    assert.ok(!f.calls.some(c=>c[0]==='event_funnel_publish'));
  }
});
test('commercial publication captures actual catalogue values without customer or provider secrets',async()=>{
  const ticket={id:'standard',name:'Admission',price:25,currency:'GBP'};
  const result=await buildFunnelPublicationSnapshot({db:{},tenantId:tenant,graph,
    references:new Map([[`simple:${event}`,{event:{id:event,title:'Conference'},tickets:[ticket]}]]),
    loadAuthority:async()=>({accounting:{name:'none'},accountingSettings:{},stripe:null,funding:{}})});
  assert.equal(result.version,1);
  assert.equal(result.offers[0].tickets[0].unitMinor,2500);
  assert.equal(result.offers[0].tickets[0].ticketName,'Admission');
  assert.ok(!JSON.stringify(result).includes('secret_key'));
  await assert.rejects(buildFunnelPublicationSnapshot({db:{},tenantId:tenant,graph,references:new Map(),
    loadAuthority:async()=>({})}),/no longer available/);
});
test('publication cannot advertise membership offers while their application rollout is off',async()=>{
  let loaded=false;
  await assert.rejects(buildFunnelPublicationSnapshot({db:{},tenantId:tenant,
    graph:{nodes:[{type:'membership'}]},references:new Map(),membershipEnabled:()=>false,
    loadAuthority:async()=>{loaded=true;return {};}}),/Membership offers are not enabled/);
  assert.equal(loaded,false);
});
