import {amendmentMoneyParts} from './memberAmendmentMoney.js';
import {planMembershipChangeSettlement,membershipSurplusCreditExpiry} from './membershipChangePolicy.js';
import {planMemberCancellationReceivables} from './memberCancellationReceivables.js';

const fail=message=>{throw Object.assign(new Error(message),{status:409,code:'cancellation_finance_conflict'});};
const part=(money,gross)=>{
 if(!Number.isSafeInteger(gross)||gross<0||gross>money.grossMinor)fail('Exact cancellation credit allocation required.');
 if(!gross)return {netMinor:0,vatMinor:0,grossMinor:0};
 const total=BigInt(money.grossMinor);
 const netMinor=Number((BigInt(money.netMinor)*BigInt(gross)+total/2n)/total);
 return amendmentMoneyParts({netMinor,vatMinor:gross-netMinor});
};

/**
 * Plans the accounting documents, not provider writes or entitlement changes.
 * Credits against unpaid annual receivables are not spendable member credit.
 * Tenant policy can retain prepaid surplus without charging unused instalments.
 */
export function planMemberCancellationFinance({
 requestId,memberId,calculation,policy,evidence,choice,liabilityBinding,issuedAt,
}){
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId||'')
  ||!memberId||typeof issuedAt!=='string'||!Number.isFinite(Date.parse(issuedAt))){
  fail('Owned cancellation request and exact issue date required.');
 }
 const receivables=planMemberCancellationReceivables({calculation,evidence});
 const resolved=new Set(['cancellation_receivables_reconciliation_required','provider_schedule_coordination_required',
  'outstanding_obligations','partial_or_adjusted_purchase_requires_reconciliation']);
 if(calculation.blockers.some(reason=>!resolved.has(reason))
  ||receivables.debtMinor!==calculation.paymentDueMinor
  ||(calculation.finance.settled.grossMinor>0&&!calculation.finance.personalFundingOnly)){
  fail('Cancellation money or funding ownership still requires reconciliation.');
 }
 const settlement=planMembershipChangeSettlement({calculation,policy,issuedAt});
 if(calculation.finance.voucherFunding?.length||calculation.finance.organisationFunding?.length){
  fail('Return funded value to its original owner before allocating personal cancellation credit.');
 }
 const surplus=receivables.surplusCreditMinor;
 if(surplus!==calculation.surplusMinor)fail('Cancellation surplus differs from verified receivables.');
 const eligible=settlement.surplusEligibleMinor;
 if(eligible!==0&&eligible!==surplus)fail('Partial surplus eligibility requires explicit accounting attribution.');
 if(receivables.debtMinor>0&&choice!=='collect')fail('Verified earned debt requires collection treatment.');
 if(!receivables.debtMinor&&!eligible&&choice!=='none')fail('No payable or returnable balance remains.');
 if(eligible&&(!['credit','refund'].includes(choice)||![choice,'approval'].includes(settlement.surplusHandling))){
  fail('Surplus treatment differs from the cancellation policy.');
 }
 if(choice==='credit'&&(!liabilityBinding?.accountId||liabilityBinding.provider!=='xero'
  ||liabilityBinding.kind!=='iconnect_member_credit_liability'
  ||liabilityBinding.providerTenantId!==evidence.providerTenantId
  ||liabilityBinding.currency!==calculation.currency)){
  fail('Personal credit needs verified liability accounting.');
 }
 const common={providerTenantId:evidence.providerTenantId,contactId:evidence.contactId,
  currency:calculation.currency,issueDate:issuedAt.slice(0,10)};
 const original=evidence.invoices[0];
 const classification=original||evidence.billingClass;
 if(!classification?.accountCode||!classification?.taxCode||(!original&&classification.verified!==true)){
  fail('Verified revenue and tax classification required.');
 }
 const steps=[];
 // Retained prepaid value stays invoiced; only unused, unpaid service is
 // removed when the tenant's cancellation policy does not return surplus.
 const retained=surplus-eligible;
 const retainedParts=part(receivables.unearnedCredit,retained);
 const credit=amendmentMoneyParts({
  netMinor:receivables.unearnedCredit.netMinor-retainedParts.netMinor,
  vatMinor:receivables.unearnedCredit.vatMinor-retainedParts.vatMinor,
 });
 const reference=`MC:${requestId}`;
 const invoiceKeys=new Map();
 for(const [index,invoice] of evidence.invoices.entries()){
  const key=evidence.invoices.length===1?'original':`original_${index}`;
  invoiceKeys.set(invoice.id,key);
  steps.push({...common,key,kind:'original_invoice',
   invoiceId:invoice.id,amount:invoice.amount,reference:`${reference}:${key}`,readOnly:true,
   minimumPaidMinor:invoice.paid.grossMinor,
   accountCode:invoice.accountCode,taxCode:invoice.taxCode});
 }
 if(receivables.creditAllocationMinor>credit.grossMinor)fail('Earned-debt allocation does not reconcile.');
 let remainingCredit=credit;
 for(const [index,allocation] of receivables.creditAllocations.entries()){
  const invoiceStep=invoiceKeys.get(allocation.invoiceId);
  if(!invoiceStep)fail('Earned-debt invoice is missing.');
  const amount=part(remainingCredit,allocation.amountMinor),creditStep=`debt_note_${index}`;
  remainingCredit=amendmentMoneyParts({
   netMinor:remainingCredit.netMinor-amount.netMinor,vatMinor:remainingCredit.vatMinor-amount.vatMinor,
  });
  // Each debt note is fully allocated to one original invoice. Keep its
  // accounting distinct from the unallocated cash surplus that may be backed
  // as member credit or refunded; the same note cannot represent both.
  steps.push({...common,key:creditStep,kind:'credit_note',reference:`${reference}:debt-${index}`,amount,
   accountCode:classification.accountCode,taxCode:classification.taxCode,
   description:`Unused membership service after ${calculation.effectiveDate}`});
  steps.push({...common,key:`reduce_original_${index}`,kind:'allocation',reference:`${reference}:reduce-original-${index}`,
   creditStep,invoiceStep,amountMinor:allocation.amountMinor});
 }
 if(receivables.additionalInvoice.grossMinor){
  steps.push({...common,key:'earned',kind:'invoice',reference:`${reference}:earned`,
   amount:receivables.additionalInvoice,accountCode:classification.accountCode,taxCode:classification.taxCode,
   description:`Membership service provided up to ${calculation.effectiveDate}`});
 }
 const returnAmount=remainingCredit;
 if(returnAmount.grossMinor!==eligible)fail('Surplus and original-invoice credits do not reconcile.');
 if(eligible){
  steps.push({...common,key:'surplus_note',kind:'credit_note',reference:`${reference}:surplus`,amount:returnAmount,
   accountCode:classification.accountCode,taxCode:classification.taxCode,
   description:`Unused prepaid membership value after ${calculation.effectiveDate}`});
 }
 if(choice==='credit'&&eligible){
  steps.push({...common,key:'backing',kind:'backing_payment',reference:`${reference}:surplus`,
   creditStep:'surplus_note',amount:returnAmount,liabilityBinding});
 }
 return {version:1,requestId,memberId,sourceRecordId:calculation.sourceRecordId,currency:calculation.currency,
  choice,steps,receivables,retainedPrepaidMinor:retained,surplusMinor:eligible,returnAmount,
  creditExpiresAt:choice==='credit'?membershipSurplusCreditExpiry(policy,issuedAt):null,
  debtMinor:receivables.debtMinor,accessWaitsForSettlement:false,paymentReactivatesMembership:false};
}
