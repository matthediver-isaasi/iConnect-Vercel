import test from 'node:test';
import assert from 'node:assert/strict';
import { loadJoiningJourney } from './membershipJoiningJourney.js';
import { createRenewalJourneyHandler } from '../admin/membership-renewal-journey.js';
const owner={id:'member',tenant_id:'tenant',organization_id:null};
const formId='ab2d6278-686c-4604-be28-05d4bb328e03';
function fixture(overrides={},failure=null) {
 const tables={
  membership_joining_journey:[{tenant_id:'tenant',form_id:formId,revision:1}],
  form:[{id:formId,tenant_id:'tenant',slug:'getting-started-with-bnms',is_active:true,require_authentication:false,form_type:'standard'}],
  ...overrides,
 };
 const calls=[];
 return {calls,from(table) {
  const filters=[];let start=0,end=Infinity;calls.push({table,filters});
  const result=()=>({data:(tables[table]||[]).filter(r=>filters.every(f=>f(r))).slice(start,end+1),error:failure===table?{message:'unavailable'}:null});
  const q={select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},is(k,v){filters.push(r=>(r[k]??null)===v);return q;},
   in(k,v){filters.push(r=>v.includes(r[k]));return q;},order(){return q;},range(a,b){start=a;end=b;return q;},limit(n){end=n-1;return q;},
   maybeSingle(){const r=result();return Promise.resolve({...r,data:r.data[0]||null});},
   then(resolve,reject){return Promise.resolve(result()).then(resolve,reject);}};
  return q;
 }};
}
test('confirmed first-time accounts receive the joining questionnaire, including a public form',async()=>{
 const db=fixture();
 assert.deepEqual(await loadJoiningJourney(db,{tenantId:'tenant',owner}),
  {eligible:true,entryHref:'/FormView?slug=getting-started-with-bnms'});
 assert.ok(db.calls.some(c=>c.table==='membership_payment_quote'));
});
test('every retained membership/payment authority suppresses joining, regardless of status',async()=>{
 for(const table of ['member_membership_history','membership_billing_agreements','membership_payment_quote','membership_payment_plans','membership_fee_token','form_joining_voucher_checkout']) {
  const db=fixture({[table]:[{id:'row',fee_token_id:'row',tenant_id:'tenant',member_id:'member',status:'pending'}]});
  assert.equal((await loadJoiningJourney(db,{tenantId:'tenant',owner})).eligible,false,table);
 }
 const orgDb=fixture({organisation_membership_history:[{id:'org-term',tenant_id:'tenant',organization_id:'org'}]});
 assert.equal((await loadJoiningJourney(orgDb,{tenantId:'tenant',owner:{...owner,organization_id:'org'}})).eligible,false);
 const affiliationOnly=await loadJoiningJourney(fixture(),{tenantId:'tenant',owner:{...owner,organization_id:'org'}});
 assert.equal(affiliationOnly.eligible,true,'affiliation alone is not organisation-funded membership');
});
test('verified retirement is distinct from expiry or failed evidence reads',async()=>{
 const retired={id:'row',tenant_id:'tenant',member_id:'member',cancelled_for_switch_at:'2026-11-07'};
 assert.equal((await loadJoiningJourney(fixture({member_membership_history:[retired],membership_billing_agreements:[retired],membership_payment_quote:[retired]}),{tenantId:'tenant',owner})).eligible,true);
 for(const table of ['membership_joining_journey','form','member_membership_history','membership_payment_plans','membership_fee_token']) {
  assert.equal((await loadJoiningJourney(fixture({},table),{tenantId:'tenant',owner})).eligible,false,table);
 }
 for(const o of [{...owner,membership_paused:true},{...owner,membership_cancelled:true},{...owner,tenant_id:'other'}])
  assert.equal((await loadJoiningJourney(fixture(),{tenantId:'tenant',owner:o})).eligible,false);
});
test('expired voucher tokens need explicit release evidence before joining is offered',async()=>{
 const tokens=[{id:'token',tenant_id:'tenant',member_id:'member',status:'expired'}];
 assert.equal((await loadJoiningJourney(fixture({membership_fee_token:tokens}),{tenantId:'tenant',owner})).eligible,false);
 const db=fixture({membership_fee_token:tokens,form_joining_voucher_checkout:[
  {fee_token_id:'token',tenant_id:'tenant',member_id:'member',released_at:'2026-11-07'}]});
 assert.equal((await loadJoiningJourney(db,{tenantId:'tenant',owner})).eligible,true);
});
test('form deletion/deactivation or no configuration never falls back to the renewal form',async()=>{
 for(const overrides of [{membership_joining_journey:[]},{form:[]},{form:[{id:formId,tenant_id:'other'}]},
  {form:[{id:formId,tenant_id:'tenant',slug:'x',is_active:false}]},
  {form:[{id:formId,tenant_id:'tenant',slug:'x',is_active:true,form_type:'survey'}]}])
  assert.deepEqual(await loadJoiningJourney(fixture(overrides),{tenantId:'tenant',owner}),{eligible:false});
});
test('joining settings have a separate service RPC and permit clearing without changing renewal',async()=>{
 const db=fixture();let args,name;
 db.rpc=async(n,a)=>{name=n;args=a;return {data:{form_id:a.p_form_id,revision:2}};};
 const handler=createRenewalJourneyHandler({db,joining:true,getContext:async()=>({isAuthenticated:true,tenantId:'tenant',memberId:'admin'}),isAdmin:async()=>true});
 const res={setHeader(){},status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
 await handler({method:'PUT',body:{formId,expectedRevision:1}},res);
 assert.equal(name,'save_membership_joining_journey');assert.equal(args.p_form_id,formId);assert.equal(args.p_mode,undefined);
 await handler({method:'PUT',body:{formId:null,expectedRevision:2}},res);
 assert.equal(args.p_form_id,null);
});
