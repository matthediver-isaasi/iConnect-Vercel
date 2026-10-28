import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberChangeRequests,memberRequestSummary} from './memberChangeRequests.js';
import {monthlyAmendmentFingerprint} from './memberAmendmentMonthly.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('member summaries retain quoted term and monthly price without exposing financial evidence',()=>{
 const summary=memberRequestSummary({targetSnapshot:{name:'Full'},request:{reason:'Change'},
  calculation:{currency:'GBP',paymentDueMinor:null,surplusMinor:0,newTerm:{renewalDate:'2027-01-01'},
   currentMonthlyPriceMinor:1300},fundingEvidence:{privateProviderData:'not public'}});
 assert.equal(summary.renewalDate,'2027-01-01');
 assert.equal(summary.monthlyAmountMinor,1300);
 assert.equal(summary.paymentDueMinor,null);
 assert.equal(summary.surplusMinor,0);
 assert.equal(JSON.stringify(summary).includes('privateProviderData'),false);
 assert.equal(memberRequestSummary({calculation:{surplusMinor:100}}).surplusMinor,undefined);
});
function fixture(){
 const context={tenantId:id(1),memberId:id(2),actorId:id(2),actorKind:'member',formId:id(3)};
 const authority={version:1,action:'change',tenantId:id(1),memberId:id(2),
  formBinding:{formId:id(3),revision:1},sourceSnapshot:{id:id(4)},
  request:{configId:id(5),bandId:null,reason:'Upgrade'},
  targetSnapshot:{name:'Full'},calculation:{sourceRecordId:id(4),entitlementApplied:false,settlementStatus:'not_started'},
  fundingEvidence:{complete:true,sourceRecordId:id(4)},settlement:{approvalRequired:true}};
 const state={record:null,reads:0,writes:[],form:{id:id(3),name:'Changes',is_active:true,require_authentication:true},
  settings:{enabled:true,revision:1,target_config_ids:[id(5)]},allowed:true};
 const db={from(table){const q={select(){return q},eq(){return q},async maybeSingle(){
  return {data:table==='form'?state.form:table==='membership_change_form'?state.settings:state.record};
 }};return q;},async rpc(name,args){state.writes.push([name,args]);return {data:state.record};}};
 const service=createMemberChangeRequests({db,amendments:{list(){throw Error('Must not resolve unavailable form');}},
  access:async()=>({allowed:state.allowed}),resolveMember:async()=>{state.reads++;return authority;},
  resolveAdmin:async()=>{const {formBinding,...value}=authority;return value;}});
 return {context,authority,state,service};
}
test('recovery reads persisted owned evidence without re-pricing or writing',async()=>{
 const f=fixture(),fingerprint=monthlyAmendmentFingerprint(f.authority);
 f.state.record={id:id(6),member_id:id(2),form_id:id(3),authority:f.authority,state:'pending'};
 assert.equal((await f.service.recover(f.context,'request-key',fingerprint)).id,id(6));
 assert.equal(f.state.reads,0);assert.equal(f.state.writes.length,0);
 await assert.rejects(f.service.submit(f.context,{key:'request-key',fingerprint,
  selection:{configId:id(5),reason:'Different'}}),/different selection/);
 await assert.rejects(f.service.recover({...f.context,actorId:id(99)},'request-key',fingerprint),/ownership/);
 await assert.rejects(f.service.recover({...f.context,formId:id(99)},'request-key',fingerprint),/different evidence/);
});
test('form access and persisted sign-in/opt-in fail closed before discovery',async()=>{
 for(const change of [f=>{f.state.form.is_active=false},f=>{f.state.form.require_authentication=false},
  f=>{f.state.settings.enabled=false},f=>{f.state.allowed=false},f=>{f.state.form.deactivate_at='invalid'}]){
  const f=fixture();change(f);
  await assert.rejects(f.service.contextInfo(f.context),e=>e.status===403);
  assert.deepEqual(await f.service.availability(f.context),{available:false});
 }
 const f=fixture();
 assert.deepEqual(await f.service.availability(f.context),{available:true});
 assert.equal(f.state.reads,0);
 assert.equal(f.state.writes.length,0);
});
test('members cannot approve requests and previews cannot confirm changed evidence',async()=>{
 const f=fixture();
 await assert.rejects(f.service.review(f.context,{id:id(6),action:'approve',reason:'Me'}),e=>e.status===403);
 await assert.rejects(f.service.submit(f.context,{key:'request-key',fingerprint:'a'.repeat(64),
  selection:{configId:id(5),reason:'Upgrade'}}),/quote changed/);
 assert.equal(f.state.writes.length,0);
});
