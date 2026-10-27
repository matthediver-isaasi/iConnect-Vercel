import {amendmentResult} from './memberAmendmentSettlement.js';
import {amendmentMinor} from './memberAmendmentFinance.js';
import {amendmentMoneyParts} from './memberAmendmentMoney.js';
import {calculateAmendmentTerms} from './memberAmendmentCalculation.js';
import {planMemberCancellationFinance} from './memberCancellationFinancialPlan.js';
import {monthlyAmendmentFingerprint} from './memberAmendmentMonthly.js';
import {planMembershipChangeSettlement} from './membershipChangePolicy.js';
const fail=message=>{throw Object.assign(new Error(message),{status:409,code:'cancellation_financial_review_required'});};

/** Internal approval boundary. Browser amounts, invoice IDs and liability
 * accounts are never financial authority. Monthly evidence must be supplied
 * by a server-owned resolver, not substituted with an upfront purchase. */
export function createMemberCancellationFinancialPreparation({db,finance,resolveMonthly,now=()=>new Date()}){
 async function row(table,context,filters){
  let q=db.from(table).select('*').eq('tenant_id',context.tenantId);
  for(const [key,value] of Object.entries(filters))q=q.eq(key,value);
  return amendmentResult(await q.maybeSingle());
 }
 async function load(context,id){
  if(!context?.isAdmin||!context.actorId||!context.memberId||!context.tenantId)fail('Administrator context required.');
  const record=await row('member_cancellation_request',context,{id,member_id:context.memberId});
  if(!record?.access_ended_at||record.id!==id||record.tenant_id!==context.tenantId||record.member_id!==context.memberId
   ||!record.authority?.policySnapshot?.policy)fail('Owned applied cancellation and its approved policy required.');
  return record;
 }
 async function resolveUpfront(context,record){
  const source=record.authority.sourceSnapshot;
  const before=record.authority.financialEvidence?.original;
  if(!before)fail('Payment timing needs review; later receipts must not become forfeitable prepaid value.');
  const full=amendmentMoneyParts({netMinor:amendmentMinor(source.final_cost),vatMinor:amendmentMinor(source.vat_amount)});
  if(full.grossMinor!==amendmentMinor(source.total_with_vat))fail('Original signed prices differ.');
  const original=await finance.verifyOriginal({tenant_id:context.tenantId,member_id:context.memberId,
   quote:{sourceSnapshot:source,currency:source.currency,originalFullTerm:full}});
  if(monthlyAmendmentFingerprint(original)!==monthlyAmendmentFingerprint(before)){
   fail('Original payment evidence changed after cancellation approval.');
  }
  const funding={sourceRecordId:source.id,currency:source.currency,asOfDate:record.effective_date,complete:true,
   settledFunding:[{id:`xero:${original.sourceInvoiceId}`,sourceRecordId:source.id,currency:source.currency,
    state:'settled',ownerType:'member',ownerId:context.memberId,kind:'cash',...full}],
   pendingCollections:[],failedCollections:[],outstandingDue:{netMinor:0,vatMinor:0,grossMinor:0}};
  const calculation=calculateAmendmentTerms({sourceRecordId:source.id,memberId:context.memberId,
   currency:source.currency,frequency:'upfront',sourcePrice:full,
   term:{startDate:source.term_start_date,renewalDate:source.membership_renewal_date},
   effectiveDate:record.effective_date,evidence:funding,behaviour:'retain_term',action:'cancel',
   cancellationTiming:record.timing,settlementAtTermEnd:record.timing==='end_of_term'});
  const zero={netMinor:0,vatMinor:0,grossMinor:0};
  return {calculation,evidence:{complete:true,sourceRecordId:source.id,currency:source.currency,
   provider:'xero',providerTenantId:original.xeroTenantId,contactId:original.contactId,
   providerEvidence:original,pendingCollections:[],disputedPayments:[],invoices:[{
    id:original.sourceInvoiceId,sourceRecordId:source.id,currency:source.currency,
    providerTenantId:original.xeroTenantId,contactId:original.contactId,status:'PAID',
    serviceStartDate:source.term_start_date,amount:full,paid:full,due:zero,
    creditedMinor:0,prepaymentMinor:0,overpaymentMinor:0,
    accountCode:original.accountCode,taxCode:original.taxCode,
   }]}};
 }
 async function build(context,record,choice){
  const source=record.authority.sourceSnapshot;
  const resolved=source.commitment_snapshot?.payment_frequency==='upfront'
   ?await resolveUpfront(context,record)
   :resolveMonthly?await resolveMonthly(context,record):fail('Monthly earned-service and receipt evidence needs its dedicated resolver.');
  const issuedAt=`${now().toISOString().slice(0,10)}T00:00:00.000Z`;
  const treatment=planMembershipChangeSettlement({
   calculation:resolved.calculation,policy:record.authority.policySnapshot.policy,issuedAt,
  });
  if(!choice){
   choice=resolved.calculation.paymentDueMinor>0?'collect':
    treatment.surplusEligibleMinor>0?treatment.surplusHandling:'none';
  }
  let liabilityBinding;
  if(choice==='credit'){
   const enabled=await row('system_settings',context,{setting_key:'individual_vouchers_enabled'});
   if(![true,'true'].includes(enabled?.setting_value))fail('Enable individual member credit before choosing it.');
   const account=await row('system_settings',context,{setting_key:'xero_voucher_clearing_account_code'});
   liabilityBinding=await finance.verifyCreditLiability(context.tenantId,{
    accountCode:account?.setting_value,currency:source.currency,
   });
  }
  const plan=planMemberCancellationFinance({requestId:record.id,memberId:context.memberId,
   ...resolved,policy:record.authority.policySnapshot.policy,choice,liabilityBinding,
   issuedAt});
  const result={plan,calculation:resolved.calculation,evidence:resolved.evidence};
  return {...result,fingerprint:monthlyAmendmentFingerprint(result)};
 }
 async function preview(context,id,{choice}={}){
  return build(context,await load(context,id),choice);
 }
 async function confirm(context,id,{choice,approve,expectedFingerprint}={}){
  if(approve!==true||!/^[a-f0-9]{64}$/.test(expectedFingerprint||''))fail('Explicit financial preview approval required.');
  const record=await load(context,id);
  const existing=await row('member_cancellation_finance',context,{request_id:id,member_id:context.memberId});
  if(existing){
   if(existing.tenant_id!==context.tenantId||existing.member_id!==context.memberId||existing.request_id!==id){
    fail('Financial approval belongs to a different cancellation.');
   }
   const fingerprint=monthlyAmendmentFingerprint({plan:existing.plan,calculation:existing.calculation,evidence:existing.source_evidence});
   if(fingerprint!==expectedFingerprint||(choice&&choice!==existing.plan.choice))fail('A different financial plan is already approved.');
   return existing;
  }
  const fresh=await build(context,record,choice);
  if(fresh.fingerprint!==expectedFingerprint)fail('Financial evidence changed; refresh the preview.');
  return amendmentResult(await db.rpc('prepare_member_cancellation_finance',{
   p_tenant_id:context.tenantId,p_member_id:context.memberId,p_id:id,p_actor_id:context.actorId,
   p_plan:fresh.plan,p_calculation:fresh.calculation,p_source_evidence:fresh.evidence,
  }));
 }
 return {preview,confirm};
}
