import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleNoticeKind,lifecycleReviewers,queueLifecycleNotice,deliverLifecycleNotice } from './memberLifecycleNotifications.js';
import { DEFAULT_LIFECYCLE_POLICY } from '../../shared/memberLifecyclePolicy.mjs';
const policy={timezone:'UTC',notificationLeadDays:30,notificationsEnabled:true};
test('only approaching calendar dates and review/archive outcomes queue notices',()=>{
  assert.equal(lifecycleNoticeKind({action:'none',eligibleOn:'2026-12-01'},policy,new Date('2026-11-22')),'approaching');
  assert.equal(lifecycleNoticeKind({action:'none',eligibleOn:'2027-02-01'},policy,new Date('2026-11-22')),null);
  assert.equal(lifecycleNoticeKind({action:'none',reason:'administrator_hold'},policy),null);
  assert.equal(lifecycleNoticeKind({action:'deletion_review'},policy),'review');
});
test('reviewers require existing admin authority and both scoped permissions, excluding closed accounts',async()=>{
  const selected=await lifecycleReviewers({},'t',{read:async(_db,table)=>table==='tenant_user'
    ?[{id:'team',email:'team@example.invalid',status:'active'},{id:'disabled',email:'no@example.invalid',status:'disabled'}]
    :[{id:'allowed',role_id:'admin',email:'a@example.invalid'},{id:'no',role_id:'admin',email:'b@example.invalid',member_excluded_features:['review']},
      {id:'archived',role_id:'admin',email:'c@example.invalid',lifecycle_state:'archived'}],
    admin:async context=>context.roleId==='admin',feature:async(_role,_key,excluded)=>!excluded.includes('review')});
  assert.deepEqual(selected.map(row=>row.key),['tenant_user:team','member:allowed']);
});
test('outbox keys are stable across retries and change with policy approval',async()=>{
  const calls=[];const db={rpc:async(_name,args)=>{calls.push(args);return{};}};
  const request={tenantId:'t',memberId:'m',proposal:{action:'deletion_review',reason:'archive_retention_elapsed'},saved:{revision:1,policy}};
  const deps={reviewers:async()=>[{key:'member:fixture'}]};
  await queueLifecycleNotice(db,request,deps);await queueLifecycleNotice(db,request,deps);
  assert.equal(calls[0].p_key,calls[1].p_key);
  await queueLifecycleNotice(db,{...request,saved:{revision:2,policy}},deps);
  assert.notEqual(calls[1].p_key,calls[2].p_key);
  assert.equal(Object.hasOwn(calls[0],'email'),false);
});
for(const [result,status] of [[{success:true},'sent'],[{success:false,ambiguousEffect:true},'needs_review'],[{success:false,ambiguousEffect:false},'pending']]){
  test(`provider outcome becomes ${status}, not an invented delivery`,async()=>{
    let finished;
    const db={rpc:async(name,args)=>name==='member_lifecycle_claim_notice'?{data:{id:'n',tenant_id:'t',recipient:'member:m',reason:'review',kind:'review',policy_revision:1}}
      :(finished=args,{data:null}),from(table){const query={select(){return query;},eq(){return query;},async single(){
        return{data:table==='tenant'?{slug:'fixture'}:{enabled:true,policy,revision:1}};
      }};return query;}};
    await deliverLifecycleNotice(db,{detail:async()=>({proposal:{action:'deletion_review'}}),reviewers:async()=>[{key:'member:m',email:'fixture@example.invalid'}],send:async()=>result});
    assert.equal(finished.p_status,status);
  });
}
test('delivery uses the real stable detail and evidence path with the nested policy',async()=>{
  const tenantId='11111111-1111-4111-8111-111111111111',memberId='22222222-2222-4222-8222-222222222222';
  const reads=new Set();let sent=0,finished;
  const saved={revision:7,enabled:true,policy:{...DEFAULT_LIFECYCLE_POLICY,notificationsEnabled:true}};
  const tables={member:[{id:memberId,tenant_id:tenantId,email:'fixture@example.invalid'}],
    member_lifecycle_policy:[saved],tenant:[{id:tenantId,slug:'fixture'}]};
  const db={
    async rpc(name,args){
      if(name==='member_lifecycle_claim_notice')return{data:{id:'fixture-notice',tenant_id:tenantId,member_id:memberId,
        recipient:`member:${memberId}`,kind:'review',reason:'membership_history_unknown',policy_revision:7}};
      if(name==='member_lifecycle_source_stamp')return{data:'a'.repeat(32)};
      if(name==='member_lifecycle_finish_notice'){finished=args;return{};}
      throw new Error(`Unexpected fixture RPC ${name}`);
    },
    from(table){
      reads.add(table);let single=false;
      const query=new Proxy({}, {get(_,key){
        if(key==='then')return resolve=>resolve({data:single?(tables[table]?.[0]||null):(tables[table]||[]),count:tables[table]?.length||0,error:null});
        return()=>{if(['single','maybeSingle'].includes(key))single=true;return query;};
      }});
      return query;
    },
  };
  await deliverLifecycleNotice(db,{reviewers:async()=>[{key:`member:${memberId}`,email:'fixture@example.invalid'}],
    send:async()=>{sent++;return{success:true};}});
  assert.equal(sent,1);assert.equal(finished.p_status,'sent');
  assert.ok(reads.has('member_membership_history'));
  assert.ok(reads.has('member_lifecycle_record_audit'));
});
