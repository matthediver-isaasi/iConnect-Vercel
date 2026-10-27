import test from 'node:test';
import assert from 'node:assert/strict';
import {planMemberCancellationReceivables as plan} from './memberCancellationReceivables.js';
const money=n=>({netMinor:n,vatMinor:0,grossMinor:n});
function input({billed=12000,paid=3000,earned=4000}={}){
 return {calculation:{action:'cancel',cancellationTiming:'immediate',
  cancellationChargeBasis:'service_used',sourceRecordId:'purchase',currency:'GBP',
  accessWaitsForSettlement:false,paymentReactivatesMembership:false,
  effectiveDate:'2026-10-27',membershipEndExclusiveDate:'2026-10-27',
  finance:{consumed:money(earned),settled:money(paid)}},
 evidence:{complete:true,sourceRecordId:'purchase',currency:'GBP',contactId:'contact',
  providerTenantId:'books',pendingCollections:[],disputedPayments:[],
  invoices:[{id:'invoice',providerTenantId:'books',status:'AUTHORISED',sourceRecordId:'purchase',
   contactId:'contact',currency:'GBP',accountCode:'400',taxCode:'NONE',
   creditedMinor:0,prepaymentMinor:0,overpaymentMinor:0,
   amount:money(billed),paid:money(paid),due:money(billed-paid)}]}};
}
test('annual cancellation credits unused receivable without invoicing earned debt twice',()=>{
 const result=plan(input());
 assert.equal(result.unearnedCredit.grossMinor,8000);
 assert.equal(result.creditAllocationMinor,8000);
 assert.equal(result.existingInvoiceDebtMinor,1000);
 assert.equal(result.additionalInvoice.grossMinor,0);
 assert.equal(result.accessWaitsForSettlement,false);
 assert.equal(result.paymentReactivatesMembership,false);
 assert.equal(result.accessApplied,false);
});
test('fully paid cancellation separates surplus from debt and access',()=>{
 const result=plan(input({paid:12000}));
 assert.equal(result.surplusCreditMinor,8000);
 assert.equal(result.creditAllocationMinor,0);
 assert.equal(result.debtMinor,0);
});
test('invoices only earned service not already billed',()=>{
 assert.equal(plan(input({billed:3000})).additionalInvoice.grossMinor,1000);
 assert.equal(plan(input({billed:4000})).additionalInvoice.grossMinor,0);
});
test('missing invoices cannot erase paid evidence; no-payment service debt can be billed',()=>{
 const missing=input();missing.evidence.invoices=[];
 assert.throws(()=>plan(missing),/Settled money/);
 missing.calculation.finance.settled=money(0);
 assert.equal(plan(missing).additionalInvoice.grossMinor,4000);
});
test('ambiguous, adjusted, foreign and incomplete evidence fails closed',()=>{
 for(const modify of [
  x=>{x.evidence.complete=false;},
  x=>{delete x.calculation.accessWaitsForSettlement;},
  x=>{x.calculation.paymentReactivatesMembership=true;},
  x=>{x.evidence.invoices[0].status='PAID';},
  x=>{x.evidence.invoices.push(x.evidence.invoices[0]);},
  x=>{x.evidence.invoices[0].contactId='other';},
  x=>{x.evidence.invoices[0].providerTenantId='other';},
  x=>{x.evidence.invoices[0].creditedMinor=1;},
  x=>{x.evidence.invoices[0].due=money(1);},
  x=>{x.evidence.pendingCollections=['pending'];},
  x=>{x.evidence.disputedPayments=['disputed'];},
 ]){
  const value=input();modify(value);assert.throws(()=>plan(value),{code:'cancellation_receivables_unverified'});
 }
});
test('preserves VAT while removing future charges rather than creating a second debt',()=>{
 const value=input();
 const m=(netMinor,vatMinor)=>({netMinor,vatMinor,grossMinor:netMinor+vatMinor});
 value.calculation.finance={consumed:m(4000,800),settled:m(2500,500)};
 Object.assign(value.evidence.invoices[0],{
  amount:m(10000,2000),paid:m(2500,500),due:m(7500,1500),
 });
 const result=plan(value);
 assert.deepEqual(result.unearnedCredit,m(6000,1200));
 assert.equal(result.creditAllocationMinor,7200);
 assert.equal(result.existingInvoiceDebtMinor,1800);
 assert.equal(result.additionalInvoice.grossMinor,0);
 assert.equal(result.surplusCreditMinor,0);
});
test('does not mutate the calculation or provider snapshot',()=>{
 const value=input(),before=structuredClone(value);
 plan(value);
 assert.deepEqual(value,before);
});

test('per-instalment invoices reduce later unused service first without duplicating earned debt',()=>{
 const value=input({billed:12000,paid:3000,earned:4000});
 const base=value.evidence.invoices[0];
 value.evidence.invoices=[
  {...base,id:'paid-first',status:'PAID',serviceStartDate:'2026-01-01',
   amount:money(3000),paid:money(3000),due:money(0)},
  {...base,id:'second',serviceStartDate:'2026-02-01',amount:money(3000),paid:money(0),due:money(3000)},
  {...base,id:'third',serviceStartDate:'2026-03-01',amount:money(3000),paid:money(0),due:money(3000)},
  {...base,id:'fourth',serviceStartDate:'2026-04-01',amount:money(3000),paid:money(0),due:money(3000)},
 ];
 const result=plan(value);
 assert.deepEqual(result.creditAllocations,[
  {invoiceId:'fourth',amountMinor:3000},{invoiceId:'third',amountMinor:3000},{invoiceId:'second',amountMinor:2000},
 ]);
 assert.equal(result.existingInvoiceDebtMinor,1000);
 assert.equal(result.additionalInvoice.grossMinor,0);
 value.evidence.invoices[1].accountCode='other-revenue';
 assert.throws(()=>plan(value),/Different revenue/);
});
