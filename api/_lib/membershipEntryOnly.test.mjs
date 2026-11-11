import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMembershipEntryOnly } from './membershipEntryOnly.js';
const owner={id:'member',tenant_id:'tenant'};
function db(mode='questionnaire') {
  return {from(table){const q={select(){return q;},eq(){return q;},async maybeSingle(){
    if(table==='membership_renewal_exceptions')return {data:null,error:null};
    return {data:table==='form'?{id:'form',tenant_id:'tenant',slug:'continue',is_active:true,require_authentication:true}:
      {mode,form_id:'form',post_grace_form_id:mode==='questionnaire'?'form':null}};} };return q;}};
}
test('eligible entry-only response excludes all private quote and history fields',async()=>{
  const result=await loadMembershipEntryOnly(db(),{tenantId:'tenant',owner,
    loadContext:async()=>({renewal:{eligible:true,state:'post_grace_renewal',currentEnd:'2020-01-01',price:999},simulation:{private:true}})});
  assert.deepEqual(result,{membership:{state:'unavailable'},payment:{state:'unavailable'},
    renewal:{eligible:true,state:'post_grace_renewal',journeyMode:'questionnaire',entryHref:'/FormView?slug=continue'}});
});
test('ineligible, paused, mismatched, unavailable and same-schedule entries do not bypass history permission',async()=>{
  const loadContext=async()=>({renewal:{eligible:false}});
  assert.equal(await loadMembershipEntryOnly(db(),{tenantId:'tenant',owner,loadContext}),null);
  for(const changed of [{...owner,membership_paused:true},{...owner,membership_cancelled:true},{...owner,tenant_id:'other'}]) {
    assert.equal(await loadMembershipEntryOnly(db(),{tenantId:'tenant',owner:changed,loadContext:()=>{throw Error('must not load');}}),null);
  }
  assert.equal(await loadMembershipEntryOnly(db('same_schedule'),{tenantId:'tenant',owner,loadContext:async()=>({renewal:{eligible:true}})}),null);
  assert.equal(await loadMembershipEntryOnly(db(),{tenantId:'tenant',owner,loadContext:async()=>{throw Error('evidence failed');}}),null);
});
