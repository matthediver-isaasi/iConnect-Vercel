import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberCancellationCashReader} from './memberCancellationCash.js';
function fixture(){
 const source={id:'purchase',tenant_id:'tenant',member_id:'member',billing_agreement_id:'agreement',
  currency:'GBP',term_start_date:'2026-01-01',membership_renewal_date:'2027-01-01'};
 const agreement={id:'agreement',tenant_id:'tenant',member_id:'member',agreement_type:'member',
  provider:'stripe',environment:'test',stripe_customer_id:'payer',stripe_subscription_id:'sub'};
 const plan={id:'plan',tenant_id:'tenant',member_id:'member',billing_agreement_id:'agreement',
  provider:'stripe',environment:'test',stripe_customer_id:'payer',stripe_subscription_id:'sub'};
 const record={id:'cancel',source_record_id:'purchase',tenant_id:'tenant',member_id:'member',access_ended_at:'2026-02-01',
  authority:{tenantId:'tenant',memberId:'member',sourceSnapshot:source,agreementSnapshot:agreement,planSnapshot:plan,
   providerPrepared:{authority:{tenantId:'tenant',memberId:'member',agreementId:'agreement',
    provider:'stripe',environment:'test',subscriptionId:'sub',payerId:'payer'}}}};
 const invoice={id:'invoice',customer:'payer',subscription:'sub',currency:'gbp',livemode:false,
  total:1000,amount_paid:1000,amount_remaining:0,status:'paid',
  lines:{has_more:false,data:[{amount:1000,period:{start:1767225600,end:1769904000}}]}};
 const charge={id:'charge',customer:'payer',payment_intent:'intent',paid:true,captured:true,
  amount:1000,amount_refunded:0,currency:'gbp',livemode:false,created:1767225600};
 const stripe={customers:{retrieve:async()=>({metadata:{tenant_id:'tenant',member_id:'member'}})},
  invoices:{list:async()=>({data:[invoice],has_more:false})},
  invoicePayments:{list:async()=>({data:[{amount_paid:1000,payment:{type:'payment_intent',payment_intent:'intent'}}],has_more:false})},
  paymentIntents:{retrieve:async()=>({id:'intent',status:'succeeded',amount_received:1000,
   currency:'gbp',customer:'payer',livemode:false,latest_charge:'charge'})},
  charges:{retrieve:async()=>charge}};
 let state='stopped';
 const reader=createMemberCancellationCashReader({getStripe:async()=>stripe,
  provider:{reconcile:async()=>({state})}});
 return {record,source,agreement,plan,invoice,charge,stripe,reader,pending(){state='uncertain'}};
}
test('reads verified historical card cash after subscription cancellation without mutating providers',async()=>{
 const f=fixture(),result=await f.reader.read(f.record);
 assert.equal(result.settledGrossMinor,1000);
 assert.equal(result.payments[0].paymentIntentId,'intent');
 assert.equal(result.unresolved.length,0);
});
test('unpaid invoices are unresolved collections, not zero-debt or settled receipts',async()=>{
 const f=fixture();Object.assign(f.invoice,{status:'open',amount_paid:0,amount_remaining:1000});
 const result=await f.reader.read(f.record);
 assert.equal(result.payments.length,0);
 assert.equal(result.unresolved[0].id,'invoice');
});
test('foreign stop authority, chargebacks and unknown provider stops fail closed',async()=>{
 const f=fixture();
 f.record.authority.providerPrepared.authority.memberId='other';
 await assert.rejects(f.reader.read(f.record),/another purchase/);
 f.record.authority.providerPrepared.authority.memberId='member';
 f.charge.disputed=true;
 await assert.rejects(f.reader.read(f.record),/disputed/);
 f.charge.disputed=false;f.pending();
 await assert.rejects(f.reader.read(f.record),/confirmed stopped/);
});
test('previous-term receipts are excluded and future-term collections remain visible for recovery',async()=>{
 const f=fixture();
 f.invoice.lines.data[0].period={start:1735689600,end:1738368000};
 assert.equal((await f.reader.read(f.record)).payments.length,0);
 f.invoice.lines.data[0].period={start:1798761600,end:1801440000};
 const future=await f.reader.read(f.record);
 assert.equal(future.payments.length,0);
 assert.equal(future.unresolved[0].reason,'future_term_collection');
});
test('dynamic DD distinguishes paid, pending and failed collections without stopping a shared mandate',async()=>{
 const f=fixture();f.record.authority.providerPrepared=null;
 Object.assign(f.agreement,{provider:'gocardless',environment:'sandbox',
  gocardless_customer_id:'payer',gocardless_mandate_id:'mandate'});
 Object.assign(f.plan,{provider:'gocardless',environment:'sandbox',gocardless_mandate_id:'mandate',
  gocardless_subscription_id:null,metadata:{collection_mode:'dynamic'}});
 const payments=['confirmed','pending_submission','failed'].map((status,index)=>({
  id:`payment-${index}`,status,amount:1000,currency:'GBP',charge_date:`2026-0${index+1}-01`,
  links:{mandate:'mandate'},metadata:{plan_id:'plan',tenant_id:'tenant',member_id:'member'},
 }));
 const reader=createMemberCancellationCashReader({db:{from(){
  const q={select(){return q},eq(){return q},async maybeSingle(){return {data:{collection_stopped_at:'2026-04-01'}}}};return q;
 }},getGc:async()=>({getGocardlessEnvironment:()=> 'sandbox',
  getMandate:async()=>({id:'mandate',links:{customer:'payer'}}),
  listPaymentsPage:async()=>({payments,after:null})})});
 const result=await reader.read(f.record);
 assert.equal(result.settledGrossMinor,1000);assert.equal(result.unresolved.length,1);assert.equal(result.failed.length,1);
 payments.push({...payments[2]});
 await assert.rejects(reader.read(f.record),/Duplicate/);
});
