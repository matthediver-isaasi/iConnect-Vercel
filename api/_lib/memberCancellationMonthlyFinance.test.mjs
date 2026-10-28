test('monthly service, unpaid balance and surplus retain their VAT components',async()=>{
 const f=fixture({paid:72});
 Object.assign(f.record.authority.sourceSnapshot,{final_cost:120,vat_amount:24,total_with_vat:144});
 f.record.authority.sourceSnapshot.commitment_snapshot.amounts={final_cost:120,vat_amount:24,total_with_vat:144};
 f.record.authority.agreementSnapshot.metadata.card.plan_total=144;
 Object.assign(f.invoice,{SubTotal:60,TotalTax:12,Total:72});
 const result=await f.resolve();
 const allocation=planMemberCancellationReceivables(result);
 assert.equal(result.calculation.surplusMinor,2466);
 assert.equal(allocation.surplusCreditMinor,2466);
 assert.equal(result.evidence.invoices[0].paid.netMinor,6000);
 assert.equal(result.evidence.invoices[0].paid.vatMinor,1200);
});
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberCancellationMonthlyFinance} from './memberCancellationMonthlyFinance.js';
import {planMemberCancellationReceivables} from './memberCancellationReceivables.js';
import {planMemberCancellationFinance} from './memberCancellationFinancialPlan.js';
import {MEMBERSHIP_CHANGE_POLICY_DEFAULTS} from './membershipChangePolicy.js';
function fixture({paid=60,annual=false,provider='stripe'}={}){
 const source={id:'purchase',tenant_id:'tenant',member_id:'member',currency:'GBP',
  final_cost:120,vat_amount:0,total_with_vat:120,term_start_date:'2026-01-01',membership_renewal_date:'2027-01-01',
  billing_agreement_id:'agreement',accounting_invoice_id:annual?'invoice':null,
  commitment_snapshot:{payment_frequency:'monthly',amounts:{final_cost:120,vat_amount:0,total_with_vat:120}}};
 const agreement={id:'agreement',tenant_id:'tenant',member_id:'member',provider,metadata:{[provider==='stripe'?'card':'dd']:{
  plan_total:120,invoicing_mode:annual?'annual':'per_instalment'}}};
 const plan={id:'plan',tenant_id:'tenant',member_id:'member',billing_agreement_id:'agreement',provider};
 const policy={...MEMBERSHIP_CHANGE_POLICY_DEFAULTS,cancellationTiming:'immediate',
  cancellationUnusedValue:'tenant_surplus_policy',surplusHandling:'refund'};
 const record={id:'11111111-1111-4111-8111-111111111111',tenant_id:'tenant',member_id:'member',
  source_record_id:'purchase',effective_date:'2026-05-01',access_ended_at:'2026-05-01T12:00:00Z',timing:'immediate',
  authority:{sourceSnapshot:source,agreementSnapshot:agreement,planSnapshot:plan,policySnapshot:{policy}}};
 const cash={complete:true,sourceRecordId:'purchase',planId:'plan',agreementId:'agreement',currency:'GBP',provider,
  payments:[{id:'receipt',settled:true,amountMinor:paid*100,date:'2026-01-01',paidAt:'2026-01-01T00:00:00Z'}],
  unresolved:[],failed:[],settledGrossMinor:paid*100};
 const mirrors=annual?[]:[{id:'mirror',billing_agreement_id:'agreement',external_payment_id:'receipt',
  gocardless_payment_id:'receipt',accounting_invoice_id:'invoice'}];
 const invoice={InvoiceID:'invoice',Type:'ACCREC',Status:annual?'AUTHORISED':'PAID',CurrencyCode:'GBP',
  Contact:{ContactID:'payer'},SubTotal:annual?120:paid,TotalTax:0,Total:annual?120:paid,
  AmountPaid:paid,AmountDue:annual?120-paid:0,AmountCredited:0,Payments:[{PaymentID:'payment'}],
  LineItems:[{AccountCode:'200',TaxType:'NONE'}]};
 const payment={PaymentID:'payment',Status:'AUTHORISED',Invoice:{InvoiceID:'invoice'},Account:{AccountID:'bank'},Amount:paid};
 const db={from(){const q={select(){return q},eq(){return q},order(){return q},
  async range(){return {data:mirrors,error:null}}};return q;}};
 let reads=0,change=false;
 const cashReader={async read(){reads++;return structuredClone(change&&reads>1?{...cash,settledGrossMinor:1}:cash);}};
 const finance={async accountingClient(){return {xeroTenantId:'books',async request(path){
  if(path==='Invoices/invoice')return {Invoices:[invoice]};
  if(path==='Payments/payment')return {Payments:[payment]};
  throw Error(`Unexpected accounting request: ${path}`);
 }}}};
 const resolve=createMemberCancellationMonthlyFinance({db,finance,cashReader});
 return {record,cash,invoice,payment,mirrors,policy,agreement,db,finance,cashReader,
  resolve:()=>resolve({tenantId:'tenant',memberId:'member'},record),change(){change=true}};
}
for(const provider of ['stripe','gocardless']){
 test(`${provider}: paid instalments produce surplus, not an unpaid annual balance`,async()=>{
  const f=fixture({provider}),result=await f.resolve();
  const r=planMemberCancellationReceivables(result);
  assert.equal(r.debtMinor,0);assert.equal(r.surplusCreditMinor,2055);
  assert.equal(result.calculation.finance.consumed.grossMinor,3945);
  const plan=planMemberCancellationFinance({...result,requestId:f.record.id,memberId:'member',
   policy:f.policy,choice:'refund',issuedAt:'2026-05-01T00:00:00Z'});
  assert.equal(plan.choice,'refund');
 });
 test(`${provider}: an unpaid annual invoice is reduced instead of double-billed`,async()=>{
  const f=fixture({provider,annual:true,paid:20}),result=await f.resolve();
  const r=planMemberCancellationReceivables(result);
  assert.equal(r.creditAllocationMinor,8055);assert.equal(r.debtMinor,1945);
  assert.equal(r.additionalInvoice.grossMinor,0);
 });
}
test('cash, invoice payment, contact and credit discrepancies fail before financial execution',async()=>{
 for(const mutate of [
  f=>f.invoice.AmountPaid=59,f=>f.payment.Amount=59,f=>f.invoice.AmountCredited=1,
  f=>f.invoice.Contact=null,f=>f.cash.unresolved.push({id:'pending'}),
  f=>f.mirrors.splice(0),f=>f.agreement.metadata.voucher_funding={id:'funding'},
 ]){
  const f=fixture();mutate(f);await assert.rejects(f.resolve());
 }
});
test('changed provider evidence cannot authorize a previously calculated plan',async()=>{
 const f=fixture();f.change();await assert.rejects(f.resolve(),/evidence changed/);
});
test('unknown or late receipt timing cannot turn surplus into forfeited prepaid value',async()=>{
 for(const paidAt of [undefined,'2026-05-02T00:00:00Z']){
  const f=fixture();f.policy.cancellationUnusedValue='none';f.cash.payments[0].paidAt=paidAt;
  await assert.rejects(f.resolve(),/cannot be forfeited/);
 }
});

test('variable Direct Debit uses membership anniversaries, not collection dates',async()=>{
 const f=fixture({provider:'gocardless'});
 f.record.authority.planSnapshot.metadata={collection_mode:'dynamic'};
 f.record.authority.sourceSnapshot.term_key='rolling:2026-01-01';
 const payments=[],mirrors=[],reservations=[],docs={},entries={};
 for(let i=1;i<=4;i++){
  const date=`2026-0${i}-25`;
  payments.push({id:`receipt${i}`,date,amountMinor:1000,settled:true});
  mirrors.push({id:`mirror${i}`,tenant_id:'tenant',plan_id:'plan',gocardless_payment_id:`receipt${i}`,
   accounting_invoice_id:`invoice${i}`,billing_agreement_id:'agreement',charge_date:date});
  reservations.push({id:`reservation${i}`,tenant_id:'tenant',plan_id:'plan',collection_number:i,
   gocardless_payment_id:`receipt${i}`,billing_agreement_id:'agreement',term_key:'rolling:2026-01-01',
   currency:'GBP',amount_minor:1000,price_snapshot:{currency:'GBP',monthly_amount_minor:1000}});
  docs[`Invoices/invoice${i}`]={Invoices:[{...f.invoice,InvoiceID:`invoice${i}`,SubTotal:10,Total:10,
   AmountPaid:10,Payments:[{PaymentID:`payment${i}`}]}]};
  entries[`Payments/payment${i}`]={Payments:[{...f.payment,PaymentID:`payment${i}`,
   Invoice:{InvoiceID:`invoice${i}`},Amount:10}]};
 }
 f.cash.payments=payments;f.cash.settledGrossMinor=4000;
 const db={from(table){
  const filters=[],q={select(){return q},eq(k,v){filters.push([k,v]);return q},order(){return q},
   async range(){return {data:(table==='gocardless_payments'?mirrors:reservations)
    .filter(r=>filters.every(([k,v])=>r[k]===v))};}};return q;
 }};
 const finance={async accountingClient(){return {xeroTenantId:'books',
  async request(path){return docs[path]||entries[path]||{};}};}};
 const resolve=createMemberCancellationMonthlyFinance({db,finance,cashReader:f.cashReader});
 const result=await resolve({tenantId:'tenant',memberId:'member'},f.record);
 assert.equal(result.calculation.finance.consumed.grossMinor,4000);
 assert.equal(result.calculation.paymentDueMinor,0);
 assert.equal(result.calculation.surplusMinor,0);
 reservations.push({id:'in-flight',tenant_id:'tenant',plan_id:'plan'});
 await assert.rejects(resolve({tenantId:'tenant',memberId:'member'},f.record),/local Direct Debit reservation/);
});
