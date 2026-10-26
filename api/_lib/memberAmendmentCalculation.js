// Shared internal arithmetic for admin and self-service amendments. Callers must
// obtain these inputs from server-owned purchase and settlement evidence. This
// module neither authorizes a member nor asserts that a provider write succeeded.
export class AmendmentCalculationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AmendmentCalculationError';
    this.code = 'amendment_evidence_required';
    this.status = 422;
  }
}
const fail = message => { throw new AmendmentCalculationError(message); };

export function amendmentDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('An exact calendar date is required.');
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0,10) !== value) fail('Invalid calendar date.');
  return ms / 86400000;
}

export function amendmentTermDays(startDate, renewalDate, effectiveDate) {
  const start = amendmentDay(startDate), renewal = amendmentDay(renewalDate), effective = amendmentDay(effectiveDate);
  const totalDays = renewal - start, remainingDays = renewal - effective;
  if (totalDays <= 0 || remainingDays <= 0 || remainingDays > totalDays) fail('The effective date must be within the current term.');
  return {totalDays,remainingDays,elapsedDays:totalDays-remainingDays};
}

function minor(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('Nonnegative integer minor-unit amounts are required.');
  return value;
}
function safe(value) {
  if (!Number.isSafeInteger(value)) fail('Amount exceeds safe minor-unit bounds.');
  return value;
}
export function amendmentMoneyParts(value) {
  if (!value || typeof value !== 'object') fail('Net and tax evidence is required.');
  const netMinor=minor(value.netMinor),vatMinor=minor(value.vatMinor);
  const grossMinor=safe(netMinor+vatMinor);
  if (value.grossMinor !== undefined && value.grossMinor !== grossMinor) fail('Net and tax do not match the gross amount.');
  return {netMinor,vatMinor,grossMinor};
}
export function prorateAmendmentMoney(value,numerator,denominator) {
  const parts=amendmentMoneyParts(value);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)
    || numerator<0 || denominator<=0 || numerator>denominator) fail('Invalid proration period.');
  const round=amount=>Number((BigInt(amount)*BigInt(numerator)*2n+BigInt(denominator))/(BigInt(denominator)*2n));
  return amendmentMoneyParts({netMinor:round(parts.netMinor),vatMinor:round(parts.vatMinor)});
}
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
  sourceRecordId,memberId,currency,frequency,sourcePrice,term,effectiveDate,evidence,
}) {
  if (!sourceRecordId || !memberId || !/^[A-Z]{3}$/.test(currency||'')) fail('Purchase identity and currency are required.');
  if (!Intl.supportedValuesOf('currency').includes(currency)
    || new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits!==2) {
    fail('A supported two-decimal currency is required.');
  }
  if (!['upfront','monthly'].includes(frequency)) fail('Unsupported payment frequency.');
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
  let consumed;
  if(frequency==='upfront') {
    // Subtract the rounded remaining value rather than round both halves:
    // consumed + remaining must equal the original purchase to the penny.
    consumed=subtract(original,prorateAmendmentMoney(original,days.remainingDays,days.totalDays));
  } else {
    if(evidence.deliveredService?.sourceRecordId!==sourceRecordId
      || evidence.deliveredService?.throughExclusiveDate!==effectiveDate
      || evidence.deliveredService?.verified!==true) fail('Monthly delivered-service obligations must be reconciled.');
    consumed=amendmentMoneyParts(evidence.deliveredService);
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
    voucherFunding: evidence.settledFunding.filter(entry=>entry.kind==='voucher').map(entry=>entry.id),
    fundingIds:[...seen],personalFundingOnly:ownership.size===1&&ownership.has(`member:${memberId}`)};
}

export function calculateAmendmentTerms({
  sourceRecordId,memberId,currency,frequency,sourcePrice,term,effectiveDate,evidence,
  behaviour,targetPrice,targetTerm,action='change',cancellationTiming='immediate',
}) {
  if(!['change','cancel'].includes(action))fail('Unsupported membership operation.');
  if(!['retain_term','new_term'].includes(behaviour))fail('An explicit governing term policy is required.');
  if(!['immediate','end_of_term'].includes(cancellationTiming))fail('Invalid cancellation timing.');
  const finance=reconcileAmendmentFunding({sourceRecordId,memberId,currency,frequency,sourcePrice,term,effectiveDate,evidence});
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
