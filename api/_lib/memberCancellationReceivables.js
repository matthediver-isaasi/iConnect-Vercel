import { amendmentMoneyParts, amendmentDay } from './memberAmendmentMoney.js';

const fail=message=>{throw Object.assign(new Error(message),{
 status:422,code:'cancellation_receivables_unverified',
});};
const zero=()=>({netMinor:0,vatMinor:0,grossMinor:0});
const subtract=(a,b)=>amendmentMoneyParts({netMinor:a.netMinor-b.netMinor,vatMinor:a.vatMinor-b.vatMinor});

/**
 * Internal planning only. The caller must independently load and verify the
 * complete purchase-scoped invoice/receipt evidence; never accept this envelope
 * from a browser. This does not stop collections, cancel access or move money.
 *
 * Annual and per-instalment receivables remain distinct from missing invoicing:
 * credit unearned service before collecting the remaining earned balance.
 */
export function planMemberCancellationReceivables({calculation,evidence}){
 const c=calculation,e=evidence;
 const finalTerm=c?.cancellationTiming==='end_of_term'&&c.settlementAtTermEnd===true
  &&c.finance?.days?.remainingDays===0;
 if(c?.action!=='cancel'||(c.cancellationTiming!=='immediate'&&!finalTerm)
  ||c.cancellationChargeBasis!=='service_used'||!c.sourceRecordId
  ||c.accessWaitsForSettlement!==false||c.paymentReactivatesMembership!==false
  ||!c.effectiveDate||c.membershipEndExclusiveDate!==c.effectiveDate
  ||e?.complete!==true||e.sourceRecordId!==c.sourceRecordId
  ||e.currency!==c.currency||!e.contactId||!e.providerTenantId
  ||!Array.isArray(e.invoices)||e.invoices.length>1000
  ||e.pendingCollections?.length!==0||e.disputedPayments?.length!==0){
  fail('Complete, undisputed cancellation receivables evidence is required.');
 }
 amendmentDay(c.effectiveDate);
 const earned=amendmentMoneyParts(c.finance.consumed);
 const paid=amendmentMoneyParts(c.finance.settled);
 if(!e.invoices.length&&paid.grossMinor)fail('Settled money must link to its original invoice.');
 let billed=zero(),due=zero(),receivedTotal=zero();
 const identities=new Set(),classes=new Set();
 const add=(a,b)=>amendmentMoneyParts({netMinor:a.netMinor+b.netMinor,vatMinor:a.vatMinor+b.vatMinor});
 for(const invoice of e.invoices){
  if(!invoice.id||!['AUTHORISED','PAID'].includes(invoice.status)
   ||invoice.providerTenantId!==e.providerTenantId
   ||invoice.sourceRecordId!==c.sourceRecordId||invoice.contactId!==e.contactId
   ||invoice.currency!==c.currency||!invoice.accountCode||!invoice.taxCode
   ||invoice.creditedMinor!==0||invoice.prepaymentMinor!==0||invoice.overpaymentMinor!==0){
   fail('Original invoice identity and unadjusted accounting treatment are required.');
  }
  if(identities.has(invoice.id))fail('Duplicate source invoice evidence.');
  identities.add(invoice.id);classes.add(`${invoice.accountCode}\0${invoice.taxCode}`);
  if(e.invoices.length>1){
   try{amendmentDay(invoice.serviceStartDate);}
   catch{fail('Each instalment invoice needs its verified service date.');}
  }
  const amount=amendmentMoneyParts(invoice.amount);
  const received=amendmentMoneyParts(invoice.paid);
  const outstanding=amendmentMoneyParts(invoice.due);
  if(invoice.status==='PAID'&&outstanding.grossMinor!==0)fail('Paid invoice has an inconsistent outstanding balance.');
  if(received.netMinor+outstanding.netMinor!==amount.netMinor
   ||received.vatMinor+outstanding.vatMinor!==amount.vatMinor){
   fail('Invoice balances do not reconcile with verified settled funding.');
  }
  billed=add(billed,amount);due=add(due,outstanding);receivedTotal=add(receivedTotal,received);
 }
 if(classes.size>1)fail('Different revenue or tax classifications need separate cancellation attribution.');
 if(receivedTotal.netMinor!==paid.netMinor||receivedTotal.vatMinor!==paid.vatMinor){
  fail('Invoice balances do not reconcile with verified settled funding.');
 }
 // Mixed tax positions need explicit reclassification, never gross netting.
 const changes=[billed.netMinor-earned.netMinor,billed.vatMinor-earned.vatMinor];
 if(changes[0]*changes[1]<0)fail('Mixed tax adjustments need separate reconciliation.');
 const credit=billed.grossMinor>earned.grossMinor?subtract(billed,earned):zero();
 const additional=earned.grossMinor>billed.grossMinor?subtract(earned,billed):zero();
 const creditAllocationMinor=Math.min(credit.grossMinor,due.grossMinor);
 const retainedDebtMinor=due.grossMinor-creditAllocationMinor;
 const newDebtMinor=additional.grossMinor;
 if(retainedDebtMinor+newDebtMinor!==Math.max(0,earned.grossMinor-paid.grossMinor)){
  fail('Earned debt does not reconcile without duplicate billing.');
 }
 let unallocated=creditAllocationMinor;
 const creditAllocations=[];
 // Reduce later service first; historical import/creation timestamps are not
 // evidence of which service period an invoice billed.
 for(const invoice of [...e.invoices].sort((a,b)=>
  (b.serviceStartDate||'').localeCompare(a.serviceStartDate||'')||a.id.localeCompare(b.id))){
  const amountMinor=Math.min(unallocated,invoice.due.grossMinor);
  if(amountMinor)creditAllocations.push({invoiceId:invoice.id,amountMinor});
  unallocated-=amountMinor;
 }
 if(unallocated)fail('Cancellation credit could not be attributed to original invoices.');
 return {
  version:1,sourceRecordId:c.sourceRecordId,currency:c.currency,
  accessEndExclusiveDate:c.membershipEndExclusiveDate,
  accessWaitsForSettlement:false,paymentReactivatesMembership:false,
  sourceInvoiceId:e.invoices.length===1?e.invoices[0].id:null,
  sourceInvoiceIds:e.invoices.map(invoice=>invoice.id),creditAllocations,unearnedCredit:credit,
  creditAllocationMinor,existingInvoiceDebtMinor:retainedDebtMinor,
  additionalInvoice:additional,
  surplusCreditMinor:credit.grossMinor-creditAllocationMinor,
  debtMinor:retainedDebtMinor+newDebtMinor,
  requiresProviderStop:true,accessApplied:false,moneyMoved:false,
 };
}
