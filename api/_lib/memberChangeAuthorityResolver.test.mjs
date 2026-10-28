import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberChangeAuthorityResolver} from './memberChangeAuthorityResolver.js';
import {createMemberChangeAuthorityService} from './memberChangeAuthority.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('production resolver builds confirmation authority from provider-backed preview, not submitted evidence',async()=>{
 const context={tenantId:id(1),memberId:id(2),actorId:id(3),actorKind:'admin'};
 const config={id:id(4),tenant_id:id(1),membership_change_behaviour:'retain_term'};
 const source={id:id(5),config_id:id(4),tenant_id:id(1)};
 let providerReads=0,writes=0;
 const db={from(table){const q={select(){return q},eq(){return q},async maybeSingle(){
   return {data:table==='membership_tier_config'?config:null};
 }};return q},async rpc(name,args){writes++;assert.equal(name,'confirm_member_change_authority');
   return {data:{authority:args.p_authority}};}};
 const amendments={async preview(){providerReads++;return {canCreate:true,quote:{
   sourceSnapshot:source,targetSnapshot:{config:{id:id(6)},band:null},effectiveDate:'2026-07-01',
   currency:'GBP',term:{startDate:'2026-01-01',renewalDate:'2027-01-01'},
   originalFullTerm:{netMinor:10000,vatMinor:0,grossMinor:10000},
   targetFullTerm:{netMinor:7500,vatMinor:0,grossMinor:7500},
   fundingEvidence:{provider:'xero',sourceInvoiceId:'invoice',paymentIds:['payment'],paidMinor:10000},
 }}}};
 const service=createMemberChangeAuthorityService({db,resolve:createMemberChangeAuthorityResolver({db,amendments})});
 const selection={configId:id(6),reason:'Change class',fundingEvidence:{paidMinor:99999999}};
 const preview=await service.preview(context,selection);
 assert.equal(preview.authority.fundingEvidence.settledFunding[0].grossMinor,10000);
 assert.equal(preview.authority.settlement.requiresApproval,true);
 assert.equal(preview.authority.executionEnabled,false);
 await service.confirm(context,{selection,fingerprint:preview.fingerprint,key:'request-key'});
 assert.equal(providerReads,2);assert.equal(writes,1);
 config.membership_change_behaviour='new_term';
 await assert.rejects(service.confirm(context,{selection,fingerprint:preview.fingerprint,key:'request-key'}),/changed/);
 await assert.rejects(service.preview({...context,actorKind:'member',actorId:id(2)},selection),/FormBuilder/);
});
test('monthly member requests keep their form revision without pretending to be an administrator',async()=>{
 const member={tenantId:id(1),memberId:id(2),actorId:id(2),actorKind:'member'};
 let seen=null;
 const resolve=createMemberChangeAuthorityResolver({db:{},
  amendments:{source:async()=>({current:{commitment_snapshot:{payment_frequency:'monthly'}}})},
  authorizeMember:async()=>({formId:id(3),revision:4}),
  monthlyResolve:async context=>{seen=context;return {version:1};}});
 const result=await resolve(member,{configId:id(6),reason:'Change'});
 assert.equal(seen.actorKind,'member');
 assert.deepEqual(result.formBinding,{formId:id(3),revision:4});
 await assert.rejects(resolve({...member,actorId:id(99)},{configId:id(6),reason:'Change'}),/FormBuilder/);
});
