import test from 'node:test';
import assert from 'node:assert/strict';
import {completeRecord} from './complete-bnms-expiry-gap-core.mjs';
import {shapeLegacyCurrentMembership,shapePersistedCommitment} from '../api/membership/member-membership.js';
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const before={tenant_id:tenant,id:'history',member_id:'member',membership_source:'personal',
  membership_year:'2026/2027',field_value:'Full',term_start_date:null,term_end_date:'2027-04-29',
  status:'active',payment_status:'paid',payment_method:'upfront',billing_period:'annual',
  notes:JSON.stringify({source:'bnms_2027_expiry_gap_correction'})};
const config={id:'config',name:'Full member',structure_match_value:'Full',billing_period:'annual',
  start_mode:'immediate',structure_scope_type:'member',currency:'GBP'};
const evidence={term_end_date:'2027-04-29',proposedStart:'2026-04-30',emailMatches:true,
  explicitAccountConflict:false,invoiceId:'invoice',invoice_number:'123',xeroStatus:'PAID',
  currency:'GBP',due:0,credited:0,lines:[{description:'Full Membership UK',quantity:1,tax:0,lineAmount:156}]};
const payment={verified:true,invoiceId:'invoice',payments:[{PaymentID:'payment',Date:'/Date(1777507200000)/'}]};
test('verified reconstruction retains expiry and membership-only financials',()=>{
  const {patch,priced,linked}=completeRecord(before,config,evidence,payment,'hash');
  assert.ok(priced&&linked);assert.equal(patch.final_cost,156);assert.equal(patch.vat_amount,0);
  assert.equal(patch.accounting_invoice_id,'invoice');assert.equal(patch.term_start_date,'2026-04-30');
  assert.equal(patch.term_end_date,before.term_end_date);
  const view=shapePersistedCommitment({...before,...patch},new Date('2026-10-19'));
  assert.equal(view.lifecycle,'current');assert.equal(view.structureName,'Full member');assert.equal(view.agreedPrice,156);
});
test('included package links paid invoice without inventing membership value or rolling commitment',()=>{
  const result=completeRecord(before,config,{...evidence,lines:[{description:"Event incl. 1 year's full membership",quantity:1,tax:93,lineAmount:556}]},payment,'hash');
  assert.equal(result.priced,false);assert.equal(result.linked,true);assert.equal(result.patch.final_cost,null);
  assert.equal(result.patch.term_key,null);assert.equal(result.patch.commitment_snapshot,null);
  const view=shapeLegacyCurrentMembership({...before,...result.patch},tenant,new Date('2026-10-19'));
  assert.equal(view.startDate,'2026-04-30');assert.equal(view.historicalStructureName,'Full member');assert.equal(view.paidAmount,null);
});
test('identity conflicts never gain invoice links or financial values',()=>{
  for(const change of [{emailMatches:false},{explicitAccountConflict:true}]){
    const r=completeRecord(before,config,{...evidence,...change},payment,'hash');
    assert.equal(r.linked,false);assert.equal(r.priced,false);
    assert.equal(r.patch.accounting_invoice_id,null);assert.equal(r.patch.final_cost,null);
    assert.equal(r.patch.term_start_date,'2026-04-30');assert.equal(r.patch.config_id,'config');
  }
});
test('unverified payments, credits and outstanding invoices do not establish financial evidence',()=>{
  assert.equal(completeRecord(before,config,evidence,{...payment,verified:false},'hash').linked,false);
  for(const change of [{due:1},{credited:1},{currency:'USD'}])
    assert.equal(completeRecord(before,config,{...evidence,...change},payment,'hash').linked,false);
});
test('wrong class, dates and stale provenance are rejected',()=>{
  assert.throws(()=>completeRecord(before,{...config,structure_match_value:'Trainee'},evidence,payment,'hash'));
  assert.throws(()=>completeRecord(before,config,{...evidence,proposedStart:'2026-05-01'},payment,'hash'));
  assert.throws(()=>completeRecord({...before,notes:'{}'},config,evidence,payment,'hash'));
});
