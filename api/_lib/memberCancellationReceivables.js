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
 * One annual receivable is deliberately distinguished from missing invoicing:
 * credit its unearned amount before collecting its remaining earned balance.
 */
export function planMemberCancellationReceivables({calculation,evidence}){
 const c=calculation,e=evidence;
 if(c?.action!=='cancel'||c.cancellationTiming!=='immediate'
  ||c.cancellationChargeBasis!=='service_used'||!c.sourceRecordId
  ||c.accessWaitsForSettlement!==false||c.paymentReactivatesMembership!==false
  ||!c.effectiveDate||c.membershipEndExclusiveDate!==c.effectiveDate
  ||e?.complete!==true||e.sourceRecordId!==c.sourceRecordId
  ||e.currency!==c.currency||!e.contactId||!e.providerTenantId
  ||!Array.isArray(e.invoices)||e.invoices.length>1
  ||e.pendingCollections?.length!==0||e.disputedPayments?.length!==0){
  fail('Complete, undisputed cancellation receivables evidence is required.');
 }
 amendmentDay(c.effectiveDate);
 const earned=amendmentMoneyParts(c.finance.consumed);
 const paid=amendmentMoneyParts(c.finance.settled);
 const invoice=e.invoices[0];
 if(!invoice&&paid.grossMinor)fail('Settled money must link to its original invoice.');
 let billed=zero(),due=zero();
 if(invoice){
  if(!invoice.id||!['AUTHORISED','PAID'].includes(invoice.status)
   ||invoice.providerTenantId!==e.providerTenantId
   ||invoice.sourceRecordId!==c.sourceRecordId||invoice.contactId!==e.contactId
   ||invoice.currency!==c.currency||!invoice.accountCode||!invoice.taxCode
   ||invoice.creditedMinor!==0||invoice.prepaymentMinor!==0||invoice.overpaymentMinor!==0){
   fail('Original invoice identity and unadjusted accounting treatment are required.');
  }
  billed=amendmentMoneyParts(invoice.amount);
  const received=amendmentMoneyParts(invoice.paid);
  due=amendmentMoneyParts(invoice.due);
  if(invoice.status==='PAID'&&due.grossMinor!==0)fail('Paid invoice has an inconsistent outstanding balance.');
  if(received.netMinor!==paid.netMinor||received.vatMinor!==paid.vatMinor
   ||received.netMinor+due.netMinor!==billed.netMinor
   ||received.vatMinor+due.vatMinor!==billed.vatMinor){
   fail('Invoice balances do not reconcile with verified settled funding.');
  }
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
 return {
  version:1,sourceRecordId:c.sourceRecordId,currency:c.currency,
  accessEndExclusiveDate:c.membershipEndExclusiveDate,
  accessWaitsForSettlement:false,paymentReactivatesMembership:false,
  sourceInvoiceId:invoice?.id||null,unearnedCredit:credit,
  creditAllocationMinor,existingInvoiceDebtMinor:retainedDebtMinor,
  additionalInvoice:additional,
  surplusCreditMinor:credit.grossMinor-creditAllocationMinor,
  debtMinor:retainedDebtMinor+newDebtMinor,
  requiresProviderStop:true,accessApplied:false,moneyMoved:false,
 };
}
