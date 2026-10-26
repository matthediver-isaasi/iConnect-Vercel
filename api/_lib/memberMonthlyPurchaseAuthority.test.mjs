import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberMonthlyPurchaseAuthority} from './memberMonthlyPurchaseAuthority.js';
function fixture(provider='stripe',dynamic=false) {
 const purchase={id:'purchase',tenant_id:'tenant',member_id:'member',billing_agreement_id:'agreement',
   status:'active',term_key:'rolling:2026-01-31',term_start_date:'2026-01-31',
   membership_renewal_date:'2027-01-31',currency:'GBP'};
 const terms={kind:provider==='stripe'?'monthly_card':'monthly_direct_debit',accepted_at:'2026-01-31T10:00:00Z',
   commitment:{term_key:purchase.term_key,term_start_date:purchase.term_start_date,
     membership_renewal_date:purchase.membership_renewal_date},
   instalment_count:3,monthly_amount_minor:1000,plan_total:30,currency:'GBP',
   ...(dynamic?{collection_policy:{version:1,pricing_policy:'dynamic',end_policy:'stop'},invoicing_mode:'per_instalment'}:{})};
 const agreement={id:'agreement',tenant_id:'tenant',member_id:'member',agreement_type:'member',provider,
   environment:provider==='stripe'?'test':'sandbox',status:'active',
   stripe_customer_id:'payer',stripe_subscription_id:'sub',gocardless_customer_id:'payer',
   gocardless_mandate_id:'mandate',metadata:{[provider==='stripe'?'card':'dd']:terms}};
 const plan={id:'plan',tenant_id:'tenant',member_id:'member',billing_agreement_id:'agreement',
   provider,environment:agreement.environment,status:'active',instalments_total:3,currency:'GBP',
   stripe_customer_id:'payer',stripe_subscription_id:'sub',gocardless_mandate_id:'mandate',
   gocardless_subscription_id:dynamic?null:'gcsub',
   metadata:dynamic?{collection_mode:'dynamic',dynamic_first_date:'2026-01-31'}:{}};
 const tables={member_membership_history:[purchase],membership_billing_agreements:[agreement],membership_payment_plans:[plan]};
 const reads=[];
 const db={from(table){const filters={};const q={select(){return q},eq(k,v){filters[k]=v;return q},
   order(){return q},async range(start,end){reads.push({table,filters:{...filters},start});
     return {data:tables[table].filter(r=>Object.entries(filters).every(([k,v])=>r[k]===v)).slice(start,end+1)};}};
   return q;}};
 const anchor=Date.parse('2026-01-31T10:00:00Z')/1000;
 const schedule={subscription:'sub',end_behavior:'cancel',phases:[{start_date:anchor,end_date:Date.parse('2026-04-30T10:00:00Z')/1000}]};
 let providerReads=0,prepared;
 const stripe={subscriptions:{async retrieve(){providerReads++;return {id:'sub',customer:'payer',livemode:false,schedule:'schedule',billing_cycle_anchor:anchor}}},
   subscriptionSchedules:{async retrieve(){return schedule}}};
 const subscription={id:'gcsub',links:{mandate:'mandate'},count:3,start_date:'2026-01-31'};
 const initialPayment={id:'first-payment',links:{mandate:'mandate'},status:'paid_out',amount:1000,
   currency:'GBP',charge_date:'2026-01-31'};
 const gc={async getMandate(){providerReads++;return {id:'mandate',status:'active',links:{customer:'payer'}}},
   async getSubscription(){return subscription},async getPayment(){return initialPayment}};
 const service=createMemberMonthlyPurchaseAuthority({db,now:()=>new Date('2026-02-15T12:00:00Z'),
   getStripe:async()=>stripe,getGc:async()=>gc,monthly:{async prepare(input){prepared=input;return {input}}}});
 const request={tenantId:'tenant',memberId:'member',amendmentId:'amendment-test',effectiveDate:'2026-02-28',
   target:{amountMinor:1500,termTotalMinor:4000,currency:'GBP'}};
 return {service,request,purchase,agreement,terms,plan,tables,schedule,reads,subscription,initialPayment,db,
   providerReads:()=>providerReads,prepared:()=>prepared};
}
for(const [provider,dynamic] of [['stripe',false],['gocardless',false],['gocardless',true]]) {
 test(`${provider} ${dynamic?'dynamic':'fixed'}: server-owned linkage and original month-end calendar`,async()=>{
   const f=fixture(provider,dynamic);
   await f.service.prepare({...f.request,purchase:{id:'forged'},authority:{payerId:'forged'}});
   const loaded=f.prepared();
   assert.equal(loaded.purchase.id,'purchase');
   assert.equal(loaded.authority.payerId,'payer');
   assert.deepEqual(loaded.authority.collectionDates,['2026-01-31','2026-02-28','2026-03-31']);
   assert.equal(loaded.authority.pricingBasis,dynamic?'monthly_price':'annual_instalments');
   assert.ok(f.reads.every(read=>read.filters.tenant_id==='tenant' && read.filters.member_id==='member'));
 });
}
test('missing/changed consent, currencies, retry holds and ambiguous plans fail before provider reads',async()=>{
 for(const mutate of [
   f=>f.terms.commitment.term_key='different',
   f=>f.terms.commitment.membership_renewal_date='2028-01-31',
   f=>f.plan.instalments_total=12,
   f=>f.plan.currency='USD',
   f=>f.plan.auto_retry_claim_token='in-flight',
   f=>f.agreement.organization_id='org',
   f=>f.tables.membership_payment_plans.push({...f.plan,id:'another-plan'}),
   f=>f.terms.plan_total=999,
 ]) {
   const f=fixture();mutate(f);
   await assert.rejects(f.service.load(f.request),{code:'monthly_purchase_evidence_required'});
   assert.equal(f.providerReads(),0);
 }
});
test('overlapping current purchases beyond a default database page are not hidden',async()=>{
 const f=fixture();
 const historical=Array.from({length:500},(_,i)=>({...f.purchase,id:`old-${i}`,status:'expired'}));
 f.tables.member_membership_history=[...historical,f.purchase,{...f.purchase,id:'overlap'}];
 await assert.rejects(f.service.load(f.request),/Exactly one current/);
 assert.ok(f.reads.some(read=>read.start===500));
});
test('provider calendar changes and mismatched initial-payment calendars require reconciliation',async()=>{
 const card=fixture();card.schedule.phases[0].end_date+=86400;
 await assert.rejects(card.service.load(card.request),/Provider end/);
 const dd=fixture('gocardless');dd.agreement.metadata.gocardless_initial_payment={id:'first-payment'};
 await assert.rejects(dd.service.load(dd.request),/subscription count/);
});
test('a separately paid first DD preserves the independent recurring start date',async()=>{
 const f=fixture('gocardless');
 f.agreement.metadata.gocardless_initial_payment={id:'first-payment',charge_date:'2026-01-31'};
 f.subscription.count=2;f.subscription.start_date='2026-02-28';
 const loaded=await f.service.load(f.request);
 assert.deepEqual(loaded.authority.collectionDates,['2026-01-31','2026-02-28','2026-03-28']);
 f.initialPayment.status='submitted';
 await assert.rejects(f.service.load(f.request),/Initial payment/);
 f.initialPayment.status='paid_out';f.initialPayment.links.mandate='foreign';
 await assert.rejects(f.service.load(f.request),/Initial payment/);
});
test('dynamic calendars use collector history and reject concurrent plan revisions',async()=>{
 const f=fixture('gocardless',true);f.plan.metadata.collection_schedule_version=1;
 const dates=['2026-01-31','2026-02-20','2026-03-20'];
 f.db.rpc=async(name,args)=>{
   assert.equal(name,'gocardless_dynamic_collection_due_date');assert.equal(args.p_plan_id,'plan');
   return {data:dates[args.p_collection_number-1]};
 };
 const loaded=await f.service.load(f.request);
 assert.deepEqual(loaded.authority.collectionDates,dates);
 f.db.rpc=async(_,args)=>{
   f.tables.membership_payment_plans=[{...f.plan,metadata:{...f.plan.metadata,collection_schedule_version:2}}];
   return {data:dates[args.p_collection_number-1]};
 };
 await assert.rejects(f.service.load(f.request),/changed during evidence/);
});
