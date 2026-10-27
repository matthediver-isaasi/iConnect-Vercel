import { amendmentMoneyParts } from './memberAmendmentMoney.js';

const fail=message=>{throw Object.assign(new Error(message),{status:422,code:'replacement_finance_unavailable'});};
const zero=()=>({netMinor:0,vatMinor:0,grossMinor:0});
function portion(money,grossMinor){
 if(!Number.isSafeInteger(grossMinor)||grossMinor<0||grossMinor>money.grossMinor)fail('Invalid transfer amount.');
 if(!grossMinor)return zero();
 // Split original tax treatment, not the destination's tax rate. Remainders
 // stay on the surplus note so both credits exactly reverse unused old value.
 const n=BigInt(money.netMinor)*BigInt(grossMinor),d=BigInt(money.grossMinor);
 const netMinor=Number((n+d/2n)/d);
 return {netMinor,vatMinor:grossMinor-netMinor,grossMinor};
}
function classification(accountCode,taxCode){
 if(typeof accountCode!=='string'||!accountCode.trim()||typeof taxCode!=='string'||!taxCode.trim()){
  fail('Explicit source and destination accounting classifications are required.');
 }
 return {accountCode,taxCode};
}
/**
 * A plan is not permission to write: execution must claim each step durably,
 * re-read provider evidence, and atomically apply the new membership afterward.
 * Supported here: verified entirely personal-cash upfront replacement terms.
 */
export function planMemberReplacementFinance({authority,executionId,original,choice}){
 const c=authority?.calculation,f=c?.finance,proof=authority?.fundingEvidence;
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(executionId||'')||authority?.action!=='change'
  ||c?.behaviour!=='new_term'||c.action!=='change'||c.blockers?.length!==0
  ||authority.sourceSnapshot?.commitment_snapshot?.payment_frequency!=='upfront'
  ||!f?.personalFundingOnly||f.voucherFunding?.length!==0||proof?.complete!==true
  ||!Array.isArray(proof.settledFunding)||!proof.settledFunding.length
  ||proof.settledFunding.some(p=>p.kind!=='cash'||p.ownerType!=='member'||p.ownerId!==authority.memberId)
  ||proof.sourceRecordId!==authority.sourceSnapshot.id
  ||!original?.sourceInvoiceId||!original.contactId||!original.xeroTenantId
  ||original.provider!=='xero'||original.sourceInvoiceId!==proof.providerEvidence?.sourceInvoiceId
  ||original.contactId!==proof.providerEvidence?.contactId
  ||original.xeroTenantId!==proof.providerEvidence?.providerTenantId){
  fail('Verified personal upfront replacement authority and original payer are required.');
 }
 const paid=amendmentMoneyParts(f.settled),unused=amendmentMoneyParts(c.unused);
 const oldFull=amendmentMoneyParts(f.original),target=amendmentMoneyParts(c.newCost);
 if(paid.grossMinor!==original.originalPaidMinor||paid.netMinor!==oldFull.netMinor
  ||paid.vatMinor!==oldFull.vatMinor||unused.grossMinor>paid.grossMinor
  ||target.grossMinor<=0||!c.newTerm?.startDate||!c.newTerm?.renewalDate
  ||c.newTerm.startDate===authority.sourceSnapshot.term_start_date
  ||c.newTerm.startDate!==c.effectiveDate||c.newTerm.renewalDate<=c.newTerm.startDate){
  fail('Replacement amounts and term must match a fully paid original purchase.');
 }
 const transfer=portion(unused,Math.min(unused.grossMinor,target.grossMinor));
 const surplus={netMinor:unused.netMinor-transfer.netMinor,vatMinor:unused.vatMinor-transfer.vatMinor,
  grossMinor:unused.grossMinor-transfer.grossMinor};
 const due=target.grossMinor-transfer.grossMinor;
 const liabilityBinding=choice==='credit'?authority.creditLiabilityBinding:null;
 if(choice==='credit'&&(!liabilityBinding?.accountId||liabilityBinding.provider!=='xero'
  ||liabilityBinding.kind!=='iconnect_member_credit_liability'
  ||liabilityBinding.providerTenantId!==original.xeroTenantId||liabilityBinding.currency!==c.currency)){
  fail('Verified liability accounting is required before issuing personal credit.');
 }
 if(due!==c.paymentDueMinor||surplus.grossMinor!==c.surplusMinor
  ||(due>0&&choice!=='collect')||(!due&&!surplus.grossMinor&&choice!=='none')
  ||(surplus.grossMinor>0&&(!['refund','credit'].includes(choice)
   ||![choice,'approval'].includes(authority.settlement?.surplusHandling)))){
  fail('Financial treatment differs from the confirmed replacement policy.');
 }
 const sourceClass=classification(original.accountCode,original.taxCode);
 const band=authority.targetBandSnapshot,config=authority.targetSnapshot;
 const targetClass=classification(band?.nominal_code||config?.nominal_code,band?band.vat_rate:config?.flat_vat_rate);
 const common={providerTenantId:original.xeroTenantId,contactId:original.contactId,
  currency:c.currency,issueDate:c.effectiveDate,sourceInvoiceId:original.sourceInvoiceId};
 const steps=[{key:'new_invoice',kind:'invoice',reference:`MR:${executionId}:new`,
  ...common,...targetClass,amount:target}];
 if(transfer.grossMinor){
  steps.push({key:'transfer_note',kind:'credit_note',reference:`MR:${executionId}:transfer`,
   ...common,...sourceClass,amount:transfer});
  steps.push({key:'transfer_allocation',kind:'allocation',creditStep:'transfer_note',invoiceStep:'new_invoice',
   ...common,amountMinor:transfer.grossMinor});
 }
 if(surplus.grossMinor)steps.push({key:'surplus_note',kind:'credit_note',reference:`MA:${executionId}`,
  ...common,...sourceClass,amount:surplus});
 if(choice==='credit')steps.push({key:'credit_backing',kind:'backing_payment',reference:`MA:${executionId}`,
  ...common,creditStep:'surplus_note',amount:surplus,liabilityBinding});
 return {version:1,executionId,sourceRecordId:authority.sourceSnapshot.id,memberId:authority.memberId,
  tenantId:authority.tenantId,currency:c.currency,choice,newTerm:c.newTerm,steps,
  transferred:transfer,surplus,additionalPaymentMinor:due,targetFullPrice:target,liabilityBinding,
  sourcePaymentIds:[...(original.originalPaymentIds||[])],entitlementApplied:false};
}
