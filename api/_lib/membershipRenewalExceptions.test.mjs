import test from 'node:test';
import assert from 'node:assert/strict';
import {applyRenewalJourney} from './membershipRenewalJourney.js';
import {assertRenewalCategory} from './membershipRenewalExceptions.js';
import {normalizeCanvasMembershipSummary} from '../../client/src/lib/canvasMembershipData.js';
const rule={route:'same_schedule',formId:'form',restrictToClass:true,purchasedFieldId:'class',purchasedClassValue:'Retired'};
function db(resolved=rule,{failure=false,target='Retired'}={}){
 return {rpc:async(name,args)=>{assert.equal(args.p_member_id,'member');return failure?{error:{message:'Conflicting renewal exceptions'}}:{data:resolved};},
  from(table){const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:
   table==='membership_renewal_exceptions'?{revision:1,rules:[rule]}:
   table==='membership_tier_config'?{tenant_id:'tenant',structure_scope_type:'member',structure_field_id:'class',structure_match_value:target}:
   table==='form'?{tenant_id:'tenant',slug:'direct',is_active:true,require_authentication:true}:
   {mode:'questionnaire',form_id:'form'}})};return q;}};
}
test('direct exception overrides both ordinary and post-grace questionnaires and survives client normalization',async()=>{
 for(const state of ['eligible_renewal','post_grace_renewal']){
  const renewal=await applyRenewalJourney(db(),'tenant',{eligible:true,state},'member');
  assert.equal(renewal.journeyMode,'same_schedule');assert.equal(renewal.entryHref,'/FormView?slug=direct');
  assert.equal(normalizeCanvasMembershipSummary({renewal}).renewal.entryHref,renewal.entryHref);
 }
});
test('ineligible members never acquire eligibility through an exception',async()=>{
 assert.deepEqual(await applyRenewalJourney({from(){throw Error('must not read');}},'tenant',{eligible:false},'member'),{eligible:false});
});
test('ambiguous or unavailable policy fails closed rather than silently taking another route',async()=>{
 const result=await applyRenewalJourney(db(rule,{failure:true}),'tenant',{eligible:true},'member');
 assert.equal(result.eligible,false);assert.equal(result.journeyUnavailable,true);
});
test('new annual schedule in same category allowed, other category blocked',async()=>{
 await assertRenewalCategory(db(),'tenant','member','next-year');
 await assert.rejects(assertRenewalCategory(db(rule,{target:'Full'}),'tenant','member','full'),/existing category/);
});
test('unmatched members retain default questionnaire, direct without destination retains original link',async()=>{
 assert.equal((await applyRenewalJourney(db(null),'tenant',{eligible:true},'member')).journeyMode,'questionnaire');
 assert.deepEqual(await applyRenewalJourney(db({...rule,formId:null}),'tenant',{eligible:true},'member'),{eligible:true,journeyMode:'same_schedule'});
});
