import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberDdCancellation,memberCancellationView} from './memberDdCancellation.js';
import {monthlyAmendmentFingerprint} from './memberAmendmentMonthly.js';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const T=id(1),M=id(2);
const context={tenantId:T,memberId:M,actorId:M,actorKind:'member'};
const found=()=>({eligible:true,blocker:null,
 evidence:{threshold:12,successfulCollections:12,collectionsInFlight:0,sequenceStartAgreementId:id(10),sequenceLength:1,
  effectiveDate:'2027-03-01',paidThroughDate:'2027-02-28',fallbackRole:{id:id(8),name:'Supporter'},tierLabel:'Full'},
 snapshots:{source:{id:id(30)},agreement:{id:id(10),gocardless_customer_id:'CU1',gocardless_mandate_id:'MD1'},
  plan:{id:id(20),environment:'live',gocardless_subscription_id:'SB1',gocardless_mandate_id:'MD1',metadata:{}},member:{}}});

function fixture({installed=true,providerState='active',providerStatus=undefined,stopOutcome='stopped',stopThrows=false,completed=false}={}){
 const calls={prepare:0,stop:0,reconcile:0,begin:0,claims:0};
 let record=null,stop=null;
 const db={
  async rpc(name,args){
   if(name==='member_dd_cancellation_available')return installed?{data:true}:{data:null,error:{code:'PGRST202'}};
   if(name==='begin_member_dd_paid_period_cancellation'){
    calls.begin++;
    if(!record){
     record={id:id(40),tenant_id:T,member_id:M,mode:'member_paid_period',request_key:args.p_key,fingerprint:args.p_fingerprint,
      authority:args.p_authority,effective_date:args.p_authority.effectiveDate,paid_through_date:args.p_authority.paidThroughDate,
      collections_fenced_at:'2026-11-27T10:00:00Z',created_at:'2026-11-27T10:00:00Z',access_ended_at:null,withdrawn_at:null};
     if(args.p_authority.providerPrepared)stop={id:record.id,tenant_id:T,member_id:M,state:'pending',
      prepared:args.p_authority.providerPrepared,fingerprint:args.p_authority.providerPrepared.fingerprint};
    }
    return {data:record};
   }
   if(name==='claim_member_dd_cancellation_provider_stop'){
    calls.claims++;
    if(stop.state!=='pending')return {data:{claimed:false,operation:stop}};
    stop={...stop,state:'claimed',claim_token:id(50)};
    return {data:{claimed:true,operation:stop}};
   }
   if(name==='record_member_dd_cancellation_provider_stop'){
    if(stop.state==='stopped')return {data:stop};
    stop={...stop,state:args.p_evidence.state==='stopped'?'stopped':'uncertain'};
    return {data:stop};
   }
   if(name==='apply_member_dd_paid_period_cancellation'){
    record={...record,access_ended_at:'2027-03-01T00:01:00Z',role_outcome:'applied'};return {data:record};
   }
   throw Error(`unexpected rpc ${name}`);
  },
  from(table){
   const filters={};const q={select(){return q},eq(k,v){filters[k]=v;return q},is(){return q},order(){return q},
    limit(){return q},
    async maybeSingle(){
     if(table==='member_cancellation_provider_stop')return {data:stop};
     if(table==='member_cancellation_request'){
      if(filters.request_key)return {data:record?.request_key===filters.request_key?record:null};
      return {data:record&&(!filters.id||filters.id===record.id)?record:null};
     }
     return {data:null};
    },
    then(resolve){return Promise.resolve({data:record&&table==='member_cancellation_request'?[record]:[]}).then(resolve);}};
   return q;
  },
 };
 const provider={
  async prepareOwnedSubscription(authority){
   calls.prepare++;
   const body={version:1,kind:'stop_subscription_without_settlement',authority};
   return {...body,fingerprint:monthlyAmendmentFingerprint(body),observation:{state:providerState,providerStatus,subscriptionId:'SB1'}};
  },
  async submitReservedStop(){calls.stop++;if(stopThrows)throw Error('timeout');return {state:stopOutcome,subscriptionId:'SB1'};},
  async reconcile(){calls.reconcile++;return {state:'stopped',subscriptionId:'SB1'};},
 };
 let evidenceCalls=0;
 const service=createMemberDdCancellation({db,provider,now:()=>new Date('2026-11-27T10:00:00Z'),
  evidence:{async evaluate(){evidenceCalls++;const f=found();
   if(completed){f.evidence.planCompleted=true;f.snapshots.plan={...f.snapshots.plan,status:'expired',completed_at:'2027-02-01'};}
   return f;}}});
 return {service,calls,get record(){return record},get stop(){return stop},get evidenceCalls(){return evidenceCalls}};
}

test('only the signed-in member may act on their own membership',async()=>{
 const f=fixture();
 for(const bad of [{...context,actorKind:'admin'},{...context,actorId:id(9)},{...context,memberId:'x'}]){
  await assert.rejects(f.service.preview(bad,{reason:'x'}),{status:403});
 }
});

test('preview never contacts the payment provider and requires a reason',async()=>{
 const f=fixture();
 await assert.rejects(f.service.preview(context,{reason:'   '}),{status:400});
 const preview=await f.service.preview(context,{reason:'Moving abroad'});
 assert.equal(preview.eligible,true);
 assert.match(preview.fingerprint,/^[a-f0-9]{64}$/);
 assert.equal(preview.summary.paidThroughDate,'2027-02-28');
 assert.equal(preview.summary.fallbackRoleName,'Supporter');
 assert.equal(f.calls.prepare,0);
 const status=await f.service.status(context);
 assert.equal(status.eligible,true);assert.equal(f.calls.prepare,0);
});

test('feature stays unavailable until its database contract is installed',async()=>{
 const f=fixture({installed:false});
 const status=await f.service.status(context);
 assert.equal(status.available,false);assert.equal(status.eligible,false);
 await assert.rejects(f.service.preview(context,{reason:'x'}),{status:503});
});

test('confirmation is idempotent and a changed preview is rejected',async()=>{
 const f=fixture();
 const preview=await f.service.preview(context,{reason:'Moving abroad'});
 await assert.rejects(f.service.confirm(context,{key:'member-dd-cancel:1',fingerprint:preview.fingerprint,reason:'Other reason',approve:true}),
  {code:'preview_changed'});
 await assert.rejects(f.service.confirm(context,{key:'member-dd-cancel:1',fingerprint:preview.fingerprint,reason:'Moving abroad'}),{status:400});
 const first=await f.service.confirm(context,{key:'member-dd-cancel:1',fingerprint:preview.fingerprint,reason:'Moving abroad',approve:true});
 assert.equal(first.request.state,'scheduled');
 assert.equal(first.request.providerState,'stopped');
 assert.equal(first.request.needsReview,false);
 // A repeated click (lost response) replays without a second provider call.
 const again=await f.service.confirm(context,{key:'member-dd-cancel:1',fingerprint:preview.fingerprint,reason:'Moving abroad',approve:true});
 assert.equal(again.request.id,first.request.id);
 assert.deepEqual([f.calls.begin,f.calls.stop,f.calls.prepare],[1,1,1]);
});

test('a provider timeout is shown as unconfirmed, never as stopped, and recovers without a second stop',async()=>{
 const f=fixture({stopThrows:true});
 const preview=await f.service.preview(context,{reason:'Cost'});
 const result=await f.service.confirm(context,{key:'member-dd-cancel:2',fingerprint:preview.fingerprint,reason:'Cost',approve:true});
 assert.equal(result.request.providerState,'uncertain');
 assert.equal(result.request.needsReview,true);
 const recovered=await f.service.recover(context,{id:f.record.id});
 assert.equal(recovered.request.providerState,'stopped');
 assert.equal(f.calls.stop,1);assert.equal(f.calls.reconcile,1);
});

test('a Direct Debit that is not active at the provider needs review before scheduling',async()=>{
 const f=fixture({providerState:'stopped'});
 const preview=await f.service.preview(context,{reason:'Cost'});
 await assert.rejects(f.service.confirm(context,{key:'member-dd-cancel:3',fingerprint:preview.fingerprint,reason:'Cost',approve:true}),
  {code:'provider_review'});
 assert.equal(f.calls.begin,0);
});

test('the member view omits administrator detail',()=>{
 const view=memberCancellationView({id:id(1),effective_date:'2027-03-01',paid_through_date:'2027-02-28',created_at:'x',
  actor_id:id(2),reason:'private',authority:{fallbackRoleName:'Supporter',reason:'private'},collections_fenced_at:'y'},null);
 assert.equal(view.state,'scheduled');assert.equal(view.reason,undefined);assert.equal(view.actorId,undefined);
 assert.equal(view.providerState,'not_required');
});

test('a fully collected plan needs no provider stop, and a naturally finished subscription is not cancelled again',async()=>{
 const done=fixture({completed:true});
 let preview=await done.service.preview(context,{reason:'Retiring'});
 let result=await done.service.confirm(context,{key:'member-dd-cancel:4',fingerprint:preview.fingerprint,reason:'Retiring',approve:true});
 assert.equal(result.request.providerState,'not_required');
 assert.equal(result.request.needsReview,false);
 assert.equal(done.record.authority.providerPrepared,null);
 assert.deepEqual([done.calls.prepare,done.calls.stop,done.calls.claims],[0,0,0]);
 // The webhook has not yet recorded completion: the provider reports "finished".
 const finished=fixture({providerState:'stopped',providerStatus:'finished'});
 preview=await finished.service.preview(context,{reason:'Retiring'});
 result=await finished.service.confirm(context,{key:'member-dd-cancel:5',fingerprint:preview.fingerprint,reason:'Retiring',approve:true});
 assert.equal(finished.calls.begin,1);
 // An unexpected provider cancellation still needs review.
 const cancelled=fixture({providerState:'stopped',providerStatus:'cancelled'});
 preview=await cancelled.service.preview(context,{reason:'Retiring'});
 await assert.rejects(cancelled.service.confirm(context,{key:'member-dd-cancel:6',fingerprint:preview.fingerprint,reason:'Retiring',approve:true}),
  {code:'provider_review'});
});
