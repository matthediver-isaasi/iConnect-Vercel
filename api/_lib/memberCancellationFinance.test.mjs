import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberCancellationFinance} from './memberCancellationFinance.js';
function fixture(){
 const context={actorKind:'admin',tenantId:'tenant',memberId:'member',actorId:'actor'};
 const record={id:'cancel',tenant_id:'tenant',member_id:'member',access_ended_at:'today',financial_state:'awaiting_reconciliation'};
 const plan={request_id:'cancel',tenant_id:'tenant',member_id:'member',plan:{steps:[{key:'original'},{key:'note'},{key:'allocation'}]}};
 const rows=plan.plan.steps.map(s=>({step_key:s.key,state:'pending'})),calls=[];
 let approved=true,state='observed';
 const db={from(table){
  const query={select(){return this;},eq(){return this;},order(){return this;},
   async range(){return {data:rows};},
   async maybeSingle(){return {data:table==='member_cancellation_request'?record:approved?plan:null};}};
  return query;
 }};
 const preparation={preview:async a=>{assert.equal(a.isAdmin,true);return {fingerprint:'preview'};},
  confirm:async()=>{approved=true;calls.push('confirm');}};
 const execution={
  run:async(a,id,key)=>{assert.equal(a.isAdmin,true);calls.push(key);
   rows.find(r=>r.step_key===key).state=state;return {state};},
  reconcileBalance:async()=>{calls.push('balance');return {state:'settled',evidence:{kind:'debt_paid'}};},
 };
 const service=createMemberCancellationFinance({db,preparation,execution,finance:{},now:()=>0});
 return {context,record,plan,rows,calls,service,setApproved:v=>approved=v,setState:v=>state=v,execution};
}
test('recovery never approves a financial choice on behalf of an administrator',async()=>{
 const f=fixture();f.setApproved(false);
 const r=await f.service.recover(f.context,'cancel');
 assert.equal(r.needsApproval,true);assert.deepEqual(f.calls,[]);
});
test('approved operations complete in dependency order and replay skips observed steps',async()=>{
 const f=fixture();const r=await f.service.recover(f.context,'cancel');
 assert.equal(r.state,'done');assert.deepEqual(f.calls,['original','note','allocation','balance']);
 f.calls.length=0;await f.service.recover(f.context,'cancel');
 assert.deepEqual(f.calls,['balance']);
 f.record.financial_state='settled';f.calls.length=0;
 await f.service.recover(f.context,'cancel');assert.deepEqual(f.calls,[]);
});
test('unknown accounting outcomes block dependent writes and settlement',async()=>{
 const f=fixture();f.setState('uncertain');
 const r=await f.service.recover(f.context,'cancel');
 assert.equal(r.needsReview,true);assert.deepEqual(f.calls,['original']);
});
test('bounded continuations resume rather than restart financial operations',async()=>{
 const f=fixture();
 assert.equal((await f.service.recover(f.context,'cancel',{maxSteps:1})).state,'pending');
 assert.deepEqual(f.calls,['original']);
 await f.service.recover(f.context,'cancel');
 assert.deepEqual(f.calls,['original','note','allocation','balance']);
});
test('foreign records and malformed journals fail before accounting',async()=>{
 const f=fixture();f.record.tenant_id='other';
 await assert.rejects(f.service.recover(f.context,'cancel'),/Owned cancellation/);
 f.record.tenant_id='tenant';f.rows[1].step_key='original';
 await assert.rejects(f.service.recover(f.context,'cancel'),/journal differs/);
 assert.deepEqual(f.calls,[]);
});
