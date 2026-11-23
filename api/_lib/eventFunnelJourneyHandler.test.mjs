import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createEventFunnelJourneyHandler, createFunnelGuestCapability } from './eventFunnelJourneyHandler.js';

const tenant='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000002';
const member='00000000-0000-4000-8000-000000000003',other='00000000-0000-4000-8000-000000000004';
function fixture({ guest=false, viewer={tenantId:tenant,memberId:member}, limit=true, rateError=null, resolveSelection }={}) {
  const capability=createFunnelGuestCapability(id), cookie=capability.cookie.split(';')[0], calls=[];
  const event={id:other,kind:'simple',tenantId:tenant};
  const graph={version:1,tenantId:tenant,entry:'source',reservationSeconds:900,invoiceMode:'per_event',nodes:[
    {id:'source',type:'source',event,ticketIds:['A'],requires:[],accept:'offer'},
    {id:'offer',type:'addon',event,ticketIds:['P'],requires:['source'],accept:'checkout',skip:'checkout'},
    {id:'checkout',type:'checkout'},
  ]};
  let state={
    session:{id,tenant_id:tenant,revision:2,state:'held',expires_at:'2030-01-01T00:15:00Z',
      journey:{version:1,decisions:{},checkoutNow:false}},
    graph,drafts:{source:{name:'Fixture'}},serverNow:'2030-01-01T00:01:00Z',
    holds:[{node_id:'source',ticket_id:'A',event_id:other,event_kind:'simple',quantity:1,places:1,
      price_snapshot:{unitMinor:1000,currency:'GBP'}}],
  };
  const db={rpc:async(name,args)=>{
    calls.push([name,args]);
    if(name==='event_funnel_consume_limit')return {data:limit,error:rateError};
    if(args.p_tenant!==tenant||args.p_id!==id || (guest
      ? args.p_member!==null||args.p_capability_hash!==capability.hash
      : args.p_member!==member||args.p_capability_hash!==null)) return {error:{code:'PT404'}};
    if(name==='event_funnel_read_session')return {data:structuredClone(state)};
    if(name==='event_funnel_save_answers') {
      if(args.p_expected_revision!==state.session.revision)return {error:{code:'PT409'}};
      state.session.revision++;state.drafts[args.p_node]=args.p_answers;
      return {data:state.session};
    }
    if(name==='event_funnel_apply_journey') {
      if(args.p_expected_revision!==state.session.revision)return {error:{code:'PT409'}};
      state.session.revision++;state.session.journey=args.p_journey;
      state.holds=args.p_lines.map(line=>({
        node_id:line.nodeId,ticket_id:line.ticketId,event_id:other,event_kind:'simple',
        quantity:line.quantity,places:line.quantity,price_snapshot:line.priceSnapshot,
      }));
      return {data:structuredClone(state)};
    }
    assert.fail(`Unexpected RPC ${name}`);
  }};
  let viewerCalls=0;
  const handler=createEventFunnelJourneyHandler({
    db,resolveTenant:async()=>({id:tenant}),loadViewer:async()=>{viewerCalls++;return viewer;},resolveSelection,
  });
  const invoke=async(body={action:'read',sessionId:id},headers={},method='POST')=>{
    const res={headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
    await handler({method,body,headers:{host:'example.test','content-type':'application/json',...headers},socket:{remoteAddress:'127.0.0.1'}},res);
    return res;
  };
  return {invoke,calls,cookie,capability,getViewerCalls:()=>viewerCalls};
}
test('guest capability is high-entropy, host-only, HttpOnly and never returned by read',async()=>{
  const h=fixture({guest:true,viewer:null});
  const token=h.cookie.split('=')[1];
  assert.equal(Buffer.from(token,'base64url').length,32);
  assert.equal(h.capability.hash,createHash('sha256').update(token).digest('hex'));
  assert.match(h.capability.cookie,/; Path=\/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax$/);
  assert.equal(h.capability.cookie.includes('Domain='),false);
  const res=await h.invoke(undefined,{cookie:h.cookie});
  assert.equal(res.code,200);
  assert.equal(JSON.stringify(res.body).includes(token),false);
  assert.equal(JSON.stringify(res.body).includes(h.capability.hash),false);
  assert.equal(res.headers['Cache-Control'],'private, no-store, max-age=0');
  assert.equal(res.headers['CDN-Cache-Control'],'no-store');
});
test('guest identity stays guest after sign-in; member identity comes only from the verified viewer',async()=>{
  const guest=fixture({guest:true});
  assert.equal((await guest.invoke(undefined,{cookie:guest.cookie})).code,200);
  assert.equal(guest.getViewerCalls(),0);
  assert.equal(guest.calls[1][1].p_member,null);
  const own=fixture();
  assert.equal((await own.invoke()).code,200);
  assert.equal(own.calls[1][1].p_member,member);
  for(const viewer of [null,{tenantId:other,memberId:member},{tenantId:tenant,memberId:other}]) {
    assert.equal((await fixture({viewer}).invoke()).code,404);
  }
});
test('a guessed ID, wrong cookie, duplicate cookie or missing guest capability cannot read a session',async()=>{
  const h=fixture({guest:true,viewer:null});
  assert.equal((await h.invoke()).code,404);
  assert.equal((await h.invoke(undefined,{cookie:h.cookie+'; '+h.cookie})).code,404);
  assert.equal((await h.invoke(undefined,{cookie:h.cookie.split('=')[0]+'='+ 'a'.repeat(43)})).code,404);
  assert.equal((await h.invoke({action:'read',sessionId:other},{cookie:h.cookie})).code,404);
});
test('cross-origin writes, form posts, GETs and forged identity fields fail before storage',async()=>{
  const h=fixture();
  for(const headers of [{origin:'https://attacker.test'},{'sec-fetch-site':'cross-site'},{'content-type':'text/plain'}]) {
    assert.equal((await h.invoke(undefined,headers)).code,403);
  }
  assert.equal((await h.invoke(undefined,{},'GET')).code,405);
  for(const extra of [{memberId:member},{tenantId:tenant},{capability:'forged'},{price:0},{nextNodeId:'checkout'}]) {
    assert.equal((await h.invoke({action:'read',sessionId:id,...extra})).code,400);
  }
  assert.equal(h.calls.length,0);
});
test('rate limits precede ownership lookup and do not reset when the guessed session changes',async()=>{
  const h=fixture({limit:false});
  const res=await h.invoke();
  assert.equal(res.code,429);assert.equal(res.headers['Retry-After'],'60');assert.equal(h.getViewerCalls(),0);
  await h.invoke({action:'read',sessionId:other});
  assert.equal(h.calls[0][1].p_actor,h.calls[1][1].p_actor);
  assert.equal((await fixture({rateError:{code:'57014'}}).invoke()).code,503);
});
test('answers save only to reachable purchase nodes, using the owned revision',async()=>{
  const h=fixture();
  const res=await h.invoke({action:'answers',sessionId:id,nodeId:'source',expectedRevision:2,answers:{name:'Edited'}});
  assert.equal(res.code,200);assert.equal(res.body.drafts.source.name,'Edited');assert.equal(res.body.session.revision,3);
  assert.equal((await h.invoke({action:'answers',sessionId:id,nodeId:'checkout',expectedRevision:3,answers:{name:'No'}})).code,409);
  assert.equal((await h.invoke({action:'answers',sessionId:id,nodeId:'source',expectedRevision:2,answers:{name:'Stale'}})).code,409);
});
test('unconfigured new selection pricing fails explicitly, but source-only and skip still preserve stock',async()=>{
  const h=fixture();
  const failed=await h.invoke({action:'change',sessionId:id,command:{
    type:'select',nodeId:'offer',tickets:[{id:'P',quantity:1}],expectedRevision:2,
  }});
  assert.equal(failed.code,503);assert.equal(failed.body.code,'COMMERCIAL_ADAPTER_UNAVAILABLE');
  assert.equal(h.calls.some(([name])=>name==='event_funnel_apply_journey'),false);
  const sourceOnly=await h.invoke({action:'change',sessionId:id,command:{type:'source_only',expectedRevision:2}});
  assert.equal(sourceOnly.code,200);
  assert.equal(sourceOnly.body.route.atCheckout,true);
  assert.equal(sourceOnly.body.holds.length,1);
  assert.equal(sourceOnly.body.session.expires_at,'2030-01-01T00:15:00Z');
});
test('resolver errors never leak attendee information or mutate the original reservation',async()=>{
  const h=fixture({resolveSelection:async()=>{throw new Error('Sensitive fixture provider detail');}});
  const res=await h.invoke({action:'change',sessionId:id,command:{
    type:'select',nodeId:'offer',tickets:[{id:'P',quantity:1}],expectedRevision:2,
  }});
  assert.equal(res.code,503);
  assert.equal(JSON.stringify(res.body).includes('Sensitive'),false);
  assert.equal(h.calls.some(([name])=>name==='event_funnel_apply_journey'),false);
});
