import {createMemberCancellationProvider} from './memberCancellationProvider.js';
import {createMemberAmendmentFinance,amendmentMinor} from './memberAmendmentFinance.js';
import {calculateAmendmentTerms} from './memberAmendmentCalculation.js';
import {amendmentMoneyParts} from './memberAmendmentMoney.js';
import {monthlyAmendmentFingerprint} from './memberAmendmentMonthly.js';
import {readMembershipChangePolicy} from './membershipChangePolicy.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=message=>{throw Object.assign(new Error(message),{status:409,code:'cancellation_authority_conflict'});};

// Read-only cancellation admission. Access approval never asserts that debt,
// a provider stop or a refund is settled. No browser financial input is used.
export function createMemberCancellationAuthority({
 db,provider=createMemberCancellationProvider(),finance=createMemberAmendmentFinance(),
 now=()=>new Date(),
}){
 async function one(table,context,filters={}){
  let query=db.from(table).select('*').eq('tenant_id',context.tenantId);
  for(const [key,value] of Object.entries(filters))query=query.eq(key,value);
  const {data,error}=await query.maybeSingle();
  if(error)fail('Cancellation ownership could not be verified.');
  return data;
 }
 async function histories(context){
  const all=[];
  for(let offset=0;offset<1000;offset+=100){
   const {data,error}=await db.from('member_membership_history').select('*')
    .eq('tenant_id',context.tenantId).eq('member_id',context.memberId)
    .order('id').range(offset,offset+99);
   if(error||!Array.isArray(data))fail('Complete membership history could not be read.');
   all.push(...data);if(data.length<100)return all;
  }
  fail('Membership history requires a bounded manual review.');
 }
 async function preview(context,selection={}){
  if(context.actorKind!=='admin'||![context.tenantId,context.memberId,context.actorId].every(v=>uuid.test(v||''))){
   fail('An authenticated membership finance administrator is required.');
  }
  const reason=typeof selection.reason==='string'?selection.reason.trim():'';
  if(!reason||reason.length>2000)fail('An explicit cancellation reason is required.');
  const member=await one('member',context,{id:context.memberId});
  if(!member||member.membership_cancelled)fail('An existing, uncancelled member is required.');
  const today=now().toISOString().slice(0,10);
  const current=(await histories(context)).filter(h=>h.status==='active'
   &&h.term_start_date<=today&&h.membership_renewal_date>today);
  if(current.length!==1)fail('Exactly one current dated membership is required.');
  const source=current[0];
  if(source.organization_id||source.membership_source==='organisation')fail('Organisation-funded membership requires its own owner authority.');
  const policySnapshot=await readMembershipChangePolicy(db,context.tenantId);
  const policy=policySnapshot.policy;
  const timing=selection.timing||policy.cancellationTiming;
  if(timing!==policy.cancellationTiming)fail('Cancellation timing differs from the tenant policy. Refresh before approving.');
  const effectiveDate=timing==='immediate'?today:source.membership_renewal_date;
  let agreement=null,plan=null,providerPrepared=null;
  if(source.billing_agreement_id){
   agreement=await one('membership_billing_agreements',context,{id:source.billing_agreement_id,member_id:context.memberId});
   plan=await one('membership_payment_plans',context,{billing_agreement_id:source.billing_agreement_id,member_id:context.memberId});
   if(!agreement||!plan||agreement.organization_id||plan.organization_id
    ||agreement.agreement_type!=='member'||agreement.provider!==plan.provider
    ||agreement.environment!==plan.environment)fail('Owned billing agreement and plan are required.');
   const subscriptionId=plan.provider==='stripe'?plan.stripe_subscription_id:plan.gocardless_subscription_id;
   if(subscriptionId){
    const payerId=plan.provider==='stripe'?agreement.stripe_customer_id:agreement.gocardless_customer_id;
    // The Stripe schedule ID is read from the owned subscription by the provider
    // boundary, not accepted from the browser or guessed from current pricing.
    providerPrepared=await provider.prepareOwnedSubscription({
     tenantId:context.tenantId,memberId:context.memberId,agreementId:agreement.id,
     provider:plan.provider,environment:plan.environment,subscriptionId,payerId,
     mandateId:agreement.gocardless_mandate_id,
    });
   }else if(plan.provider!=='gocardless'||plan.metadata?.collection_mode!=='dynamic'){
    fail('The current billing plan has no verifiable collection authority.');
   }
  }else if(source.commitment_snapshot?.payment_frequency!=='upfront'){
   fail('Monthly membership must have its original billing agreement.');
  }
  let calculation={version:2,action:'cancel',sourceRecordId:source.id,
   effectiveDate:today,membershipEndExclusiveDate:effectiveDate,cancellationTiming:timing,
   cancellationChargeBasis:'service_used',accessWaitsForSettlement:false,paymentReactivatesMembership:false,
   currency:source.currency,entitlementApplied:false,settlementStatus:'requires_reconciliation',
   paymentDueMinor:null,futureObligationMinor:null,finance:null};
  let financialEvidence=null,financialReviewReason=null;
  if(source.commitment_snapshot?.payment_frequency==='upfront'){
   try{
    const full=amendmentMoneyParts({netMinor:amendmentMinor(source.final_cost),vatMinor:amendmentMinor(source.vat_amount)});
    if(full.grossMinor!==amendmentMinor(source.total_with_vat))fail('Purchased invoice totals differ.');
    const original=await finance.verifyOriginal({tenant_id:context.tenantId,member_id:context.memberId,
     quote:{sourceSnapshot:source,currency:source.currency,originalFullTerm:full}});
    const funding={sourceRecordId:source.id,currency:source.currency,asOfDate:today,complete:true,
     settledFunding:[{id:`xero:${original.sourceInvoiceId}`,sourceRecordId:source.id,currency:source.currency,
      state:'settled',ownerType:'member',ownerId:context.memberId,kind:'cash',...full}],
     pendingCollections:[],failedCollections:[],outstandingDue:{netMinor:0,vatMinor:0,grossMinor:0}};
    calculation=calculateAmendmentTerms({sourceRecordId:source.id,memberId:context.memberId,
     currency:source.currency,frequency:'upfront',sourcePrice:full,
     term:{startDate:source.term_start_date,renewalDate:source.membership_renewal_date},
     effectiveDate:today,evidence:funding,behaviour:'retain_term',action:'cancel',cancellationTiming:timing});
    financialEvidence={original,funding};
   }catch{
    financialReviewReason='Financial evidence still requires reconciliation; cancellation does not waive debt or authorize a refund.';
   }
  }else{
   financialReviewReason='Monthly receipts and earned service must be reconciled separately from ending access.';
  }
  const authority={version:1,tenantId:context.tenantId,memberId:context.memberId,actorId:context.actorId,
   reason,timing,effectiveDate,sourceSnapshot:source,agreementSnapshot:agreement,planSnapshot:plan,
   policySnapshot,calculation,financialEvidence,financialReviewReason,providerPrepared};
  return {authority,fingerprint:monthlyAmendmentFingerprint(authority)};
 }
 return {preview};
}
