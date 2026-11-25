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
function statusDb(rows,{failTable}={}){
 return {from(table){
  const filters=[];const q={select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},
   lte(k,v){filters.push(r=>r[k]<=v);return q},gt(k,v){filters.push(r=>r[k]>v);return q},
   order(){return q},limit(){return q},
   async maybeSingle(){const d=(rows[table]||[]).filter(r=>filters.every(f=>f(r)));return failTable===table?{error:{code:'x'}}:{data:d[0]||null,error:null}},
   then(resolve){const d=(rows[table]||[]).filter(r=>filters.every(f=>f(r)));return Promise.resolve(failTable===table?{data:null,error:{code:'x'}}:{data:d,error:null}).then(resolve)}};
  return q;
 },async rpc(){throw Error('status must not write')}};
}
const statusContext={tenantId:id(1),memberId:id(2),actorId:id(3),actorKind:'admin'};
const history=(extra={})=>({id:id(7),tenant_id:id(1),member_id:id(2),status:'active',term_start_date:'2026-01-01',
 membership_renewal_date:'2027-01-01',tier_label:'Full',billing_agreement_id:id(8),...extra});
const statusOf=(rows,options)=>createMemberCancellationRequests({db:statusDb({member:[{id:id(2),tenant_id:id(1),membership_cancelled:false}],
 membership_change_policy:[{tenant_id:id(1),policy:{cancellationTiming:'immediate'},revision:1}],...rows},options),
 now:()=>new Date('2026-07-01T12:00:00Z'),authority:{},execution:{}}).status(statusContext);
test('cancellation status is read-only and explains each ineligible case',async()=>{
 const ok=await statusOf({member_membership_history:[history()]});
 assert.equal(ok.eligible,true);assert.equal(ok.current.tierLabel,'Full');assert.equal(ok.current.recurring,true);
 assert.equal((await statusOf({})).blocker,'no_current_membership');
 assert.equal((await statusOf({member_membership_history:[history({term_start_date:'2026-08-01'})]})).blocker,'no_current_membership');
 assert.equal((await statusOf({member_membership_history:[history(),history({id:id(9)})]})).blocker,'multiple_current_memberships');
 assert.equal((await statusOf({member_membership_history:[history({membership_source:'organisation'})]})).blocker,'organisation_funded');
 assert.equal((await statusOf({member:[{id:id(2),tenant_id:id(1),membership_cancelled:true}]})).blocker,'already_cancelled');
 const scheduled=await statusOf({member_membership_history:[history()],member_cancellation_request:[
  {id:id(5),tenant_id:id(1),member_id:id(2),effective_date:'2027-01-01',timing:'end_of_term',access_ended_at:null,withdrawn_at:null,
   authority:{providerPrepared:{authority:{provider:'stripe'}},sourceSnapshot:{secret:'x'}}}]});
 assert.equal(scheduled.blocker,'cancellation_scheduled');assert.equal(scheduled.latest.provider,'stripe');
 assert.equal(scheduled.latest.providerState,'not_started');assert.equal(scheduled.latest.authority,undefined);
 const withdrawn=await statusOf({member_membership_history:[history()],member_cancellation_request:[
  {id:id(5),tenant_id:id(1),member_id:id(2),access_ended_at:null,withdrawn_at:'2026-06-01T00:00:00Z',authority:{}}]});
 assert.equal(withdrawn.eligible,true);
 const applied=await statusOf({member:[{id:id(2),tenant_id:id(1),membership_cancelled:true}],member_cancellation_request:[
  {id:id(5),tenant_id:id(1),member_id:id(2),access_ended_at:'2026-06-01T00:00:00Z',withdrawn_at:null,authority:{providerPrepared:{authority:{provider:'gocardless'}}}}],
  member_cancellation_provider_stop:[{id:id(5),tenant_id:id(1),member_id:id(2),state:'uncertain'}]});
 assert.equal(applied.blocker,'already_cancelled');assert.equal(applied.latest.providerState,'uncertain');
 await assert.rejects(statusOf({member_membership_history:[history()]},{failTable:'member_membership_history'}),/could not be verified/);
 await assert.rejects(createMemberCancellationRequests({db:statusDb({}),authority:{},execution:{}}).status({...statusContext,actorKind:'member'}),/administrator/);
});
