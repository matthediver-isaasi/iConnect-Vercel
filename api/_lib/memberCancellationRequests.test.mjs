import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberCancellationRequests} from './memberCancellationRequests.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(){
 const context={tenantId:id(1),memberId:id(2),actorId:id(3),actorKind:'admin'};
 let record=null,previews=0,stops=0,reads=0,access=0,state='pending';
 const approved={tenantId:id(1),memberId:id(2),actorId:id(3),reason:'Cancel now',
  timing:'immediate',effectiveDate:'2026-07-01',providerPrepared:{fingerprint:'provider'}};
 const db={from(){
  const filters=[];const q={select(){return q},eq(k,v){filters.push([k,v]);return q},
   async maybeSingle(){return {data:record&&filters.every(([k,v])=>record[k]===v)?record:null}}};
  return q;
 },async rpc(name,args){
  if(name==='begin_member_cancellation'){
   record={id:id(4),tenant_id:id(1),member_id:id(2),actor_id:id(3),
    request_key:args.p_key,fingerprint:args.p_fingerprint,reason:args.p_authority.reason,
    timing:args.p_authority.timing,effective_date:args.p_authority.effectiveDate,
    authority:args.p_authority,access_ended_at:'2026-07-01T00:00:00Z'};
  }else if(name==='apply_member_cancellation_access'){access++;record.access_ended_at='2026-07-01T00:00:00Z';}
  else throw Error(name);
  return {data:record};
 }};
 const service=createMemberCancellationRequests({db,now:()=>new Date('2026-07-01T12:00:00Z'),
  authority:{async preview(){previews++;return {authority:approved,fingerprint:'a'.repeat(64)}}},
  execution:{async execute(){stops++;state='uncertain';throw Error('Lost response')},
   async recover(){reads++;return {state}}},
 });
 const request={key:'cancel-request',fingerprint:'a'.repeat(64),selection:{reason:'Cancel now'},approve:true};
 return {context,service,request,get record(){return record},get counts(){return {previews,stops,reads,access}},
  pending(){state='pending';record.access_ended_at=null;record.timing='end_of_term';},
 };
}
test('lost cancellation response recovers without requoting or repeating its stop',async()=>{
 const f=fixture();
 const first=await f.service.confirm(f.context,f.request);
 assert.ok(first.record.access_ended_at);
 assert.equal(first.provider.state,'requires_reconciliation');
 const replay=await f.service.confirm(f.context,f.request);
 assert.equal(replay.record.id,first.record.id);
 assert.equal(replay.provider.state,'uncertain');
 assert.deepEqual(f.counts,{previews:1,stops:1,reads:1,access:0});
});
test('a due scheduled cancellation applies access and claims its first provider stop',async()=>{
 const f=fixture();await f.service.confirm(f.context,f.request);f.pending();
 const result=await f.service.recover(f.context,id(4));
 assert.ok(result.record.access_ended_at);
 assert.deepEqual(f.counts,{previews:1,stops:2,reads:1,access:1});
 await f.service.recover(f.context,id(4));
 assert.equal(f.counts.stops,2);
});
test('confirmation rejects missing consent, changed previews and foreign ownership',async()=>{
 const f=fixture();
 await assert.rejects(f.service.confirm(f.context,{...f.request,approve:false}),/Explicit approval/);
 await assert.rejects(f.service.confirm(f.context,{...f.request,fingerprint:'b'.repeat(64)}),/changed/);
 await f.service.confirm(f.context,f.request);
 await assert.rejects(f.service.confirm(f.context,{...f.request,selection:{reason:'Different reason'}}),/another approval/);
 await assert.rejects(f.service.recover({...f.context,memberId:id(9)},id(4)),/not found/);
 await assert.rejects(f.service.recover({...f.context,actorKind:'member'},id(4)),/administrator/);
 assert.equal(f.counts.stops,1);
});
