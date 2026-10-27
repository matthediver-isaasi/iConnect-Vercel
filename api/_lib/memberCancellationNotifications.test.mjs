import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberCancellationNotifications} from './memberCancellationNotifications.js';
function fixture(){
 let sends=0,response={success:true,messageId:'accepted-id'};
 const context={tenantId:'tenant',memberId:'member'};
 const record={id:'request',tenant_id:'tenant',member_id:'member',access_ended_at:'2026-01-01',
  effective_date:'2026-01-01',financial_state:'awaiting_reconciliation'};
 const job={id:'job',request_id:'request',state:'claimed',claim_token:'token',kind:'notify_access'};
 const service=createMemberCancellationNotifications({db:{from(){
  const q={select(){return q},eq(){return q},async maybeSingle(){return {data:{id:'member',email:'member@example.test'}}}};
  return q;
 }},sendEmail:async email=>{
  sends++;assert.equal(email.to,'member@example.test');
  assert.match(email.text,/does not restart/);assert.equal(email.disableTracking,true);
  return response;
 }});
 return {service,context,record,job,get sends(){return sends},respond(value){response=value}};
}
test('cancellation notice records provider acceptance without claiming debt is paid',async()=>{
 const f=fixture(),result=await f.service.send(f.context,f.record,f.job);
 assert.deepEqual(result,{state:'done',evidence:{messageId:'accepted-id'}});
 assert.equal(f.sends,1);
});
test('only a proven non-submission permits notification retry',async()=>{
 const f=fixture();f.respond({success:false,notSubmitted:true});
 assert.equal((await f.service.send(f.context,f.record,f.job)).state,'pending');
 f.respond({success:false});
 assert.equal((await f.service.send(f.context,f.record,f.job)).state,'uncertain');
 f.respond({success:true});
 assert.equal((await f.service.send(f.context,f.record,f.job)).state,'uncertain');
});
test('unsettled finances, wrong ownership and missing claims cannot send notices',async()=>{
 const f=fixture();
 await assert.rejects(f.service.send(f.context,f.record,{...f.job,kind:'notify_finance'}),/not ready/);
 await assert.rejects(f.service.send({...f.context,memberId:'other'},f.record,f.job),/Owned applied/);
 await assert.rejects(f.service.send(f.context,f.record,{...f.job,claim_token:null}),/Owned applied/);
 assert.equal(f.sends,0);
});
