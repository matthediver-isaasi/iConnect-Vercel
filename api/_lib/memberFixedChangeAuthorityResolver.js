import {normalizeAmendmentRequest} from './memberAmendments.js';
import {resolveAnnualMemberTargetPrice} from './memberAmendmentQuote.js';
import {calculateAmendmentTerms,amendmentTermDays,prorateAmendmentMoney} from './memberAmendmentCalculation.js';
import {resolveMembershipChangeBehaviour,readMembershipChangePolicy} from './membershipChangePolicy.js';
import {monthlyAmendmentFingerprint} from './memberAmendmentMonthly.js';
import {monthlyInvoiceMinor as minor} from './memberMonthlyHistoricalPrices.js';
const fail=message=>{throw Object.assign(new Error(message),{status:422,code:'fixed_monthly_quote_unavailable'});};
export async function resolveMemberFixedChangeAuthority({db,purchases,context,selection,base}){
  const one=async(table,filters)=>{
    let q=db.from(table).select('*').eq('tenant_id',context.tenantId);
    for(const [k,v] of Object.entries(filters))q=q.eq(k,v);
    const {data,error}=await q.maybeSingle();
    if(error)fail('Monthly configuration could not be verified.');
    return data;
  };
  const request=normalizeAmendmentRequest({...selection,memberId:context.memberId,settlementChoice:'defer'});
  const source=base.purchase,term={startDate:source.term_start_date,renewalDate:source.membership_renewal_date};
  const governing=await one('membership_tier_config',{id:source.config_id});
  if(resolveMembershipChangeBehaviour(source,governing)!=='retain_term')fail('Replacement terms require a separate settlement and consent flow.');
  const config=await one('membership_tier_config',{id:request.configId});
  const card=base.authority.provider==='stripe';
  if(!config || config.structure_scope_type!=='member' || config.is_active!==true
    || config.billing_period!=='annual' || config.currency!==base.authority.currency
    || config.start_mode!==governing.start_mode || !config.effective_from
    || config.effective_from>request.effectiveDate || (config.effective_to&&config.effective_to<request.effectiveDate)
    || config.free_period_amount || config.rollover_enabled || (!card&&config.dd_enabled!==true)) {
    fail('Target must be an effective annual personal structure compatible with the current agreement.');
  }
  const band=request.bandId?await one('membership_tier_band',{id:request.bandId,config_id:config.id}):null;
  if((config.pricing_model==='flat'&&band)||(config.pricing_model!=='flat'&&(!band||config.pricing_model!=='tiered'))
    || (source.config_id===config.id&&(source.band_id||null)===(band?.id||null)))fail('Select a different valid target structure or tier.');
  for(const table of ['membership_tier_discount','membership_tier_vat_override']){
    const {data,error}=await db.from(table).select('id').eq('tenant_id',context.tenantId).eq('config_id',config.id).limit(1);
    if(error||!Array.isArray(data)||data.length)fail('Target pricing rules require separate reconciliation.');
  }
  const vatSetting=await one('system_settings',{setting_key:`xero_vat_rates_${context.tenantId}`});
  const targetPrice=resolveAnnualMemberTargetPrice({config,band,vatSetting});
  const days=amendmentTermDays(term.startDate,term.renewalDate,request.effectiveDate);
  const remaining=prorateAmendmentMoney(targetPrice,days.remainingDays,days.totalDays);
  const terms=base.agreement.metadata[card?'card':'dd'];
  // This is only a preliminary schedule quote. The receipt/date/invoice join
  // below must independently verify every expected past collection.
  const expectedPaid=base.authority.collectionDates.filter(date=>date<request.effectiveDate).length*terms.monthly_amount_minor;
  const signed=source.commitment_snapshot?.amounts;
  const unchangedPrice=!!signed&&targetPrice.netMinor===minor(signed.final_cost)
    &&targetPrice.vatMinor===minor(signed.vat_amount)&&targetPrice.grossMinor===minor(signed.total_with_vat)
    &&targetPrice.grossMinor===minor(terms.plan_total);
  const providerTarget={currency:base.authority.currency,
    termTotalMinor:unchangedPrice?targetPrice.grossMinor:expectedPaid+remaining.grossMinor,
    ...(card?{createInlinePrice:true}:{})};
  const reconciled=await purchases.reconcileFunding({
    tenantId:context.tenantId,memberId:context.memberId,amendmentId:base.amendmentId,
    effectiveDate:request.effectiveDate,target:providerTarget,
  });
  if(monthlyAmendmentFingerprint(reconciled.input.purchase)!==monthlyAmendmentFingerprint(source)
    || reconciled.prepared.funding.settledGrossMinor!==expectedPaid)fail('Original purchase or received cash changed.');
  const calculation=calculateAmendmentTerms({
    sourceRecordId:source.id,memberId:context.memberId,currency:base.authority.currency,
    frequency:'monthly',pricingBasis:'annual_instalments',sourcePrice:reconciled.sourcePrice,
    term,effectiveDate:request.effectiveDate,evidence:reconciled.fundingEvidence,behaviour:'retain_term',targetPrice,
  });
  if(calculation.finance.blockers.length || (!unchangedPrice&&calculation.finance.available.grossMinor!==0)
    || calculation.surplusMinor!==0
    || (!unchangedPrice&&calculation.futureObligationMinor!==remaining.grossMinor)
    || (unchangedPrice&&calculation.futureObligationMinor!==targetPrice.grossMinor-expectedPaid)
    || reconciled.prepared.quote.amountMinor*reconciled.prepared.quote.collectionDates.length!==calculation.futureObligationMinor) {
    fail('Outstanding obligations, prepaid value or uneven instalments require settlement before changing the schedule.');
  }
  await readMembershipChangePolicy(db,context.tenantId);
  const policySnapshot=await one('membership_change_policy',{});
  return {version:1,tenantId:context.tenantId,memberId:context.memberId,action:'change',request,
    sourceSnapshot:source,targetSnapshot:config,targetBandSnapshot:band,governingSnapshot:governing,
    pricingSnapshot:{config,band,vatSetting,discounts:[],vatOverrides:[]},policySnapshot,
    calculation,fundingEvidence:reconciled.fundingEvidence,
    settlement:{requiresApproval:true,surplusHandling:'none',moneyMoved:false,entitlementApplied:false},
    monthlyExecution:{version:1,unchangedPriceCarry:unchangedPrice,providerTarget,providerAuthority:reconciled.input.authority,
      providerFunding:reconciled.prepared.funding},
    executionEnabled:false};
}
