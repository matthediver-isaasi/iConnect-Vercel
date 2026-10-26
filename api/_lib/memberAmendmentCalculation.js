// Shared internal arithmetic for admin and self-service amendments. Callers must
// obtain these inputs from server-owned purchase and settlement evidence. This
// module neither authorizes a member nor asserts that a provider write succeeded.
import { reconcileVariableMonthlyService } from './memberVariableMonthlyService.js';
import { AmendmentCalculationError, amendmentTermDays, amendmentMoneyParts,
  prorateAmendmentMoney, amendmentSafeMinor as safe } from './memberAmendmentMoney.js';
export { AmendmentCalculationError, amendmentDay, amendmentTermDays,
  amendmentMoneyParts, prorateAmendmentMoney } from './memberAmendmentMoney.js';
const fail = message => { throw new AmendmentCalculationError(message); };
function subtract(a,b) {
  return {netMinor:safe(a.netMinor-b.netMinor),vatMinor:safe(a.vatMinor-b.vatMinor),grossMinor:safe(a.grossMinor-b.grossMinor)};
}
const zero=()=>({netMinor:0,vatMinor:0,grossMinor:0});

/**
 * Financial reconciliation from complete purchase-scoped evidence.
 *
 * sourcePrice is the original discounted contract, never today's catalogue.
 * settledFunding entries are net of prior provider refunds, disputes and prior
 * credit transfers, each tied to an immutable funding/evidence ID. Pending or
 * failed collections must NOT be represented as settled funding.
 *
 * Monthly consumption requires independently reconciled delivered-service
 * amounts; annual-price/12 is not a substitute for historical variable pricing.
 * Existing unspent vouchers are not inputs: they belong to their reservation
 * authority and must not be silently applied or counted twice.
 */
export function reconcileAmendmentFunding({
  sourceRecordId,memberId,currency,frequency,pricingBasis,sourcePrice,term,effectiveDate,evidence,
}) {
  if (!sourceRecordId || !memberId || !/^[A-Z]{3}$/.test(currency||'')) fail('Purchase identity and currency are required.');
  if (!Intl.supportedValuesOf('currency').includes(currency)
    || new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits!==2) {
    fail('A supported two-decimal currency is required.');
  }
  if (!['upfront','monthly'].includes(frequency)) fail('Unsupported payment frequency.');
  if(frequency==='monthly' && pricingBasis!==undefined
    && !['annual_instalments','monthly_price'].includes(pricingBasis)) fail('Unsupported monthly pricing basis.');
  if(frequency==='monthly' && pricingBasis==='monthly_price' && !evidence?.variableMonthlyService) {
    fail('Variable monthly pricing requires anniversary-period service evidence.');
  }
  const days=amendmentTermDays(term.startDate,term.renewalDate,effectiveDate);
  const original=amendmentMoneyParts(sourcePrice);
  if (!evidence || evidence.sourceRecordId!==sourceRecordId || evidence.currency!==currency
    || evidence.asOfDate!==effectiveDate || evidence.complete!==true
    || !Array.isArray(evidence.settledFunding) || !Array.isArray(evidence.pendingCollections)
    || !Array.isArray(evidence.failedCollections)) fail('Complete current purchase-scoped financial evidence is required.');
  const seen=new Set(),ownership=new Set();let settled=zero();
  for(const entry of evidence.settledFunding) {
    if (!entry.id || seen.has(entry.id) || entry.state!=='settled'
      || entry.sourceRecordId!==sourceRecordId || entry.currency!==currency
      || !['member','organization','third_party'].includes(entry.ownerType) || !entry.ownerId
      || !['cash','voucher'].includes(entry.kind)) fail('Funding identity, settlement or ownership is ambiguous.');
    seen.add(entry.id);ownership.add(`${entry.ownerType}:${entry.ownerId}`);
    const amount=amendmentMoneyParts(entry);
    settled=amendmentMoneyParts({
      netMinor:safe(settled.netMinor+amount.netMinor),vatMinor:safe(settled.vatMinor+amount.vatMinor),
    });
  }
  let consumed, deliveredServiceEvidence;
  if(frequency==='upfront') {
    // Subtract the rounded remaining value rather than round both halves:
    // consumed + remaining must equal the original purchase to the penny.
    consumed=subtract(original,prorateAmendmentMoney(original,days.remainingDays,days.totalDays));
  } else {
    const delivered=evidence.variableMonthlyService !== undefined
      ? reconcileVariableMonthlyService({sourceRecordId,currency,term,throughExclusiveDate:effectiveDate,
        evidence:evidence.variableMonthlyService})
      : evidence.deliveredService;
    if(delivered?.sourceRecordId!==sourceRecordId
      || delivered?.throughExclusiveDate!==effectiveDate
      || delivered?.verified!==true) fail('Monthly delivered-service obligations must be reconciled.');
    consumed=amendmentMoneyParts(delivered);
    if(evidence.variableMonthlyService !== undefined) deliveredServiceEvidence=delivered;
  }
  const balance=subtract(settled,consumed);
  // Tax-only and mixed-sign positions need accounting review; do not net unlike
  // tax components into apparently spendable cash.
  const mixed=(balance.netMinor<0&&balance.vatMinor>0)||(balance.netMinor>0&&balance.vatMinor<0);
  const outstanding=amendmentMoneyParts(evidence.outstandingDue);
  const blockers=[];
  if(frequency==='upfront' && (settled.netMinor!==original.netMinor || settled.vatMinor!==original.vatMinor)) {
    blockers.push('partial_or_adjusted_purchase_requires_reconciliation');
  }
  if(mixed)blockers.push('mixed_tax_balance');
  if(balance.netMinor<0||balance.vatMinor<0||outstanding.grossMinor>0)blockers.push('outstanding_obligations');
  if(evidence.pendingCollections.length)blockers.push('collections_in_progress');
  if(evidence.failedCollections.length)blockers.push('failed_collections_require_reconciliation');
  if([...ownership].some(owner=>owner!==`member:${memberId}`))blockers.push('non_member_funding');
  const available=balance.netMinor>=0&&balance.vatMinor>=0?amendmentMoneyParts(balance):zero();
  return {days,original,settled,consumed,available,outstanding,blockers,
    ...(deliveredServiceEvidence ? {deliveredServiceEvidence} : {}),
    voucherFunding: evidence.settledFunding.filter(entry=>entry.kind==='voucher').map(entry=>entry.id),
    fundingIds:[...seen],personalFundingOnly:ownership.size===1&&ownership.has(`member:${memberId}`)};
}

export function calculateAmendmentTerms({
  sourceRecordId,memberId,currency,frequency,pricingBasis,sourcePrice,term,effectiveDate,evidence,
  behaviour,targetPrice,targetTerm,action='change',cancellationTiming='immediate',
}) {
  if(!['change','cancel'].includes(action))fail('Unsupported membership operation.');
  if(!['retain_term','new_term'].includes(behaviour))fail('An explicit governing term policy is required.');
  if(!['immediate','end_of_term'].includes(cancellationTiming))fail('Invalid cancellation timing.');
  if(frequency==='monthly' && pricingBasis==='monthly_price' && action==='change') {
    fail('Variable monthly target pricing requires an effective-dated collection quote, not an assumed fixed term total.');
  }
  const finance=reconcileAmendmentFunding({sourceRecordId,memberId,currency,frequency,pricingBasis,sourcePrice,term,effectiveDate,evidence});
  let newCost=zero(),newTerm=null,unused=finance.available;
  if(action==='change') {
    const full=amendmentMoneyParts(targetPrice);
    if(behaviour==='retain_term') {
      newCost=prorateAmendmentMoney(full,finance.days.remainingDays,finance.days.totalDays);
      newTerm={startDate:effectiveDate,renewalDate:term.renewalDate};
    } else {
      if(targetTerm?.startDate!==effectiveDate)fail('The replacement term must start on the effective date.');
      amendmentTermDays(targetTerm.startDate,targetTerm.renewalDate,effectiveDate);
      newCost=full;newTerm={startDate:targetTerm.startDate,renewalDate:targetTerm.renewalDate};
    }
  } else if(cancellationTiming==='end_of_term') {
    // Remaining service is retained, not refunded today. Monthly instalments
    // legitimately due for this term remain obligations of the existing plan.
    unused=zero();
  }
  const delta=subtract(newCost,unused);
  const blockers=[...finance.blockers];
  if(frequency==='monthly')blockers.push('provider_schedule_coordination_required');
  if((delta.netMinor<0&&delta.vatMinor>0)||(delta.netMinor>0&&delta.vatMinor<0))blockers.push('mixed_tax_adjustment');
  return {
    version:2,action,behaviour,effectiveDate,cancellationTiming:action==='cancel'?cancellationTiming:null,
    membershipEndExclusiveDate:action==='cancel'?(cancellationTiming==='end_of_term'?term.renewalDate:effectiveDate):null,
    sourceRecordId,currency,finance,newTerm,newCost,unused,delta,blockers,
    targetFullPrice:action==='change'?amendmentMoneyParts(targetPrice):null,
    paymentDueMinor:frequency==='monthly'?null:Math.max(delta.grossMinor,0),
    futureObligationMinor:frequency==='monthly'?Math.max(delta.grossMinor,0):null,
    surplusMinor:Math.max(-delta.grossMinor,0),
    canAutomaticallySettle:blockers.length===0,
    // Calculation is never evidence of application, approval or provider success.
    entitlementApplied:false,settlementStatus:'not_started',
  };
}
