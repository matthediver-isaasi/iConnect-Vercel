import test from 'node:test';
import assert from 'node:assert/strict';
import {assessMember} from './bnms-live-xero-review-core.mjs';
const fixture=()=>({review:{memberId:'m',memberClass:'Full',sourceState:'source_fields_corroborated',
  retainedExpiry:'2027-08-27',liveSource:{preferences:{}}},live:{preferences:{},dd_evidence:false,history_count:0},
  classFieldId:'f',configs:[{name:'Full',is_active:true,structure_scope_type:'member',
    structure_field_id:'f',structure_match_value:'Full',billing_period:'annual',effective_from:'2026-09-01'}],
  provider:{exact:true,latestPaidInvoiceId:'i',latestInvoiceId:'i',
    membershipInvoices:[{InvoiceID:'i',InvoiceNumber:'123',Status:'PAID',Type:'ACCREC',Total:156,
      AmountPaid:156,AmountDue:0,CurrencyCode:'GBP',DateString:'2026-08-29T00:00:00',
      LineItems:[{Description:'Full Membership UK',Quantity:1}]}],
    payments:[{Status:'AUTHORISED',Invoice:{InvoiceID:'i'},Amount:156}]}});
test('settlement plus aligned source forms a conditional proposal, not write authority',()=>{
  const r=assessMember(fixture());assert.equal(r.conditionalCandidate,true);
  assert.equal(r.proposedStart,'2026-08-28');assert.match(r.authority,/No repair authorised/);
});
test('credits, wrong contacts, wrong payments, missing structure and stale/future dates are held',()=>{
  for(const mutate of [
    x=>x.provider.exact=false,
    x=>x.provider.contacts=[{AccountNumber:'different-legacy-id'}],
    x=>x.provider.payments[0].Invoice.InvoiceID='other',
    x=>x.provider.membershipInvoices[0].AmountCredited=5,
    x=>x.review.retainedExpiry='2030-08-27',
    x=>x.review.retainedExpiry='2027-03-27',
    x=>x.configs=[],
    x=>x.live.dd_evidence=true,
    x=>x.live.history_count=1,
    x=>x.review.sourceState='source_conflict_requires_review',
  ]){const x=fixture();mutate(x);assert.equal(assessMember(x).conditionalCandidate,false);}
});
test('paid event invoice with an explicit untaxed membership line keeps membership cost separate',()=>{
  const x=fixture(),i=x.provider.membershipInvoices[0];
  i.Total=i.AmountPaid=x.provider.payments[0].Amount=556;
  i.LineItems=[{Description:'Event attendance',Quantity:1,LineAmount:400,TaxAmount:66.67},
    {Description:"1 year's full membership",Quantity:1,LineAmount:156,TaxAmount:0}];
  let r=assessMember(x);assert.equal(r.conditionalCandidate,true);assert.equal(r.membershipAmount,156);
  i.LineItems=[{Description:"Event attendance including 1 year's membership",Quantity:1,LineAmount:556}];
  r=assessMember(x);assert.equal(r.conditionalCandidate,false);assert.equal(r.membershipAmount,null);
  i.LineItems.push({Description:'Discount',Quantity:1,LineAmount:-10});
  assert.equal(assessMember(x).conditionalCandidate,false);
});
