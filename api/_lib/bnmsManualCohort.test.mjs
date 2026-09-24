import test from 'node:test';
import assert from 'node:assert/strict';
import {MANUAL_TENANT as tenant,MANUAL_WORKBOOK,MANUAL_GATE,MANUAL_BANK_SOURCE,
 resolveManualAccountingContext,assertManualAccountingContext,findManualAdoption} from './bnmsManualCohort.js';
import {currentMembershipRecognition} from './alphaMembershipRecognition.js';
import {directDebitMembershipPresentation} from './directDebitMembershipPresentation.js';
import {migratedMandatePresentation} from './migratedMandatePresentation.js';
import {readConsoleRows} from './directDebitConsoleEligibility.js';
const agreement=()=>({id:'agreement',tenant_id:tenant,member_id:'member',gocardless_customer_id:'CU1',
 gocardless_mandate_id:'MD1',provider:'gocardless',environment:'live',metadata:{bnms_manual_cohort:MANUAL_WORKBOOK}});
const adoption=()=>({id:'adoption',tenant_id:tenant,member_id:'member',agreement_id:'agreement',plan_id:'plan',
 customer_id:'CU1',mandate_id:'MD1',workbook_sha256:MANUAL_WORKBOOK,manifest_sha256:'review',
 evidence:{accounting:{contactId:'contact',contactEmail:'owner@example.test',revenueCode:'203',
  bankAccountId:'d115eacc-1fa7-476d-844e-d3d7f07f5db5',xeroTenantId:'3d57dce6-2205-462f-abf6-9c7cbf00be23'}}});
const release=()=>({tenant_id:tenant,member_id:'member',plan_id:'plan',adoption_id:'adoption',manifest_sha256:'review',processing_not_before:MANUAL_GATE});
const db=(a=adoption(),r=release(),error=null)=>({from(table){return {select(){return this;},eq(){return this;},
 maybeSingle(){return Promise.resolve({data:table==='bnms_dd_manual_adoption'?a:r,error});}};}});
test('manual accounting context is exact cohort/owner/release bound and cannot be caller-forged',async()=>{
 const context=await resolveManualAccountingContext(agreement(),db());
 assert.equal(context.snapshot.source,MANUAL_BANK_SOURCE);
 assert.equal(assertManualAccountingContext(tenant,context).revenue_account_code,'203');
 assert.throws(()=>assertManualAccountingContext(tenant,structuredClone(context)),/Untrusted/);
 for(const patch of [{agreement_id:'wrong'},{customer_id:'other'},{mandate_id:'other'},{workbook_sha256:'other'}]){
  await assert.rejects(resolveManualAccountingContext(agreement(),db({...adoption(),...patch})),/ownership/);
 }
 await assert.rejects(resolveManualAccountingContext(agreement(),db(adoption(),{...release(),processing_not_before:'2026-09-01'})),/incomplete/);
 await assert.rejects(resolveManualAccountingContext(agreement(),db(adoption(),null)),/incomplete/);
});
test('new-table absence is rolling-deployment tolerant only for unrelated agreements, not claimed adoption or read errors',async()=>{
 const generic={...agreement(),metadata:{}};
 assert.equal(await findManualAdoption(generic,db(null,null,{code:'42P01'})),null);
 await assert.rejects(findManualAdoption(agreement(),db(null,null,{code:'42P01'})),/Unable/);
 await assert.rejects(findManualAdoption(generic,db(null,null,{code:'42501'})),/Unable/);
 assert.deepEqual(await readConsoleRows(()=>({range:async()=>({error:{code:'42P01'}})}),{allowMissing:true}),[]);
 await assert.rejects(readConsoleRows(()=>({range:async()=>({error:{code:'42501',message:'denied'}})}),{allowMissing:true}),/denied/);
});
test('manual Current plus Existing mandate active is nonfinancial, bounded, and consistent with imported presentation',()=>{
 const recognition={tenant_id:tenant,member_id:'member',agreement_id:'agreement',history_id:'history',
  workbook_sha256:MANUAL_WORKBOOK,provenance:'bnms_manual_95',effective_from:'2026-09-24',effective_until:'2027-10-01',revoked_at:null};
 const h={id:'history',tenant_id:tenant,member_id:'member',billing_agreement_id:'agreement',membership_source:'personal',
  term_key:'rolling:2026-10-01',term_start_date:'2026-10-01',term_end_date:'2027-09-30',membership_renewal_date:'2027-10-01',
  payment_method:'direct_debit',status:'pending_payment_setup',payment_status:'unpaid',membershipRecognition:recognition};
 const plan={id:'plan',provider:'gocardless',status:'first_payment_pending',billing_agreement_id:'agreement',migratedMandateStatus:'active',
  membership_billing_agreements:{metadata:{dd:{billing_request_mode:'migration_existing_mandate',activation_rule:'first_payment'}}}};
 const before=JSON.stringify({h,plan});
 const view=directDebitMembershipPresentation(plan,[h],{membership_paused:false},'2026-09-24',{source:'bnms_dd_manual_adoption'});
 assert.equal(view.displayStatus,'current');assert.equal(view.evidence.source,'administrative_recognition');
 assert.equal(view.pendingActivation,false);assert.equal(migratedMandatePresentation(plan).mandateStatus,'active');
 assert.equal(JSON.stringify({h,plan}),before);
 assert.equal(currentMembershipRecognition(h,'2026-09-23'),null);
 assert.ok(currentMembershipRecognition(h,'2027-09-30'));
 assert.equal(currentMembershipRecognition(h,'2027-10-01'),null);
 assert.equal(currentMembershipRecognition({...h,status:'cancelled'},'2026-09-24'),null);
 assert.equal(currentMembershipRecognition({...h,membershipRecognition:{...recognition,workbook_sha256:'forged'}},'2026-09-24'),null);
});