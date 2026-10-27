// Configuration only. Saving policy never enables execution or moves money.
export const MEMBERSHIP_CHANGE_POLICY_DEFAULTS = Object.freeze({
  surplusHandling: 'approval',
  creditExpiryDays: null,
  upgradesRequireApproval: true,
  downgradesRequireApproval: true,
  cancellationTiming: 'end_of_term',
  cancellationUnusedValue: 'none',
});

export function validateMembershipChangePolicy(value) {
  const fail = () => { throw Object.assign(new Error('Invalid membership change policy.'), { status: 400 }); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const keys = Object.keys(MEMBERSHIP_CHANGE_POLICY_DEFAULTS);
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
  if (!['approval', 'credit', 'refund'].includes(value.surplusHandling)
    || !['end_of_term', 'immediate'].includes(value.cancellationTiming)
    || !['none', 'tenant_surplus_policy'].includes(value.cancellationUnusedValue)
    || typeof value.upgradesRequireApproval !== 'boolean'
    || typeof value.downgradesRequireApproval !== 'boolean'
    || (value.creditExpiryDays !== null && (!Number.isInteger(value.creditExpiryDays)
      || value.creditExpiryDays < 1 || value.creditExpiryDays > 36500))) fail();
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

export async function readMembershipChangePolicy(db, tenantId) {
  const { data, error } = await db.from('membership_change_policy')
    .select('policy,revision').eq('tenant_id', tenantId).maybeSingle();
  if (error) throw error; // Missing migration is not an absent tenant policy.
  return {
    policy: data ? validateMembershipChangePolicy(data.policy) : { ...MEMBERSHIP_CHANGE_POLICY_DEFAULTS },
    revision: data?.revision ?? 0,
    executionEnabled: false,
  };
}

export function membershipSurplusCreditExpiry(policy, issuedAt) {
  const checked = validateMembershipChangePolicy(policy);
  const date = new Date(issuedAt);
  if (!Number.isFinite(date.getTime())) throw new Error('A valid credit issue timestamp is required.');
  if (checked.creditExpiryDays === null) return null;
  date.setUTCDate(date.getUTCDate() + checked.creditExpiryDays);
  return date.toISOString();
}

// Never take behaviour from the destination schedule or a posted form value.
// The caller must load the purchase's governing schedule in the same tenant.
export function resolveMembershipChangeBehaviour(source, governingSchedule) {
  if (!source?.config_id || !source.tenant_id || !governingSchedule
    || governingSchedule.id !== source.config_id || governingSchedule.tenant_id !== source.tenant_id) {
    throw Object.assign(new Error('The governing membership schedule could not be verified.'), { status: 422 });
  }
  const behaviour = governingSchedule.membership_change_behaviour ?? 'retain_term';
  if (!['retain_term','new_term'].includes(behaviour)) {
    throw Object.assign(new Error('Unsupported membership change behaviour.'), { status: 422 });
  }
  return behaviour;
}

/**
 * A settlement decision is a plan, never evidence that money was moved.
 * Existing voucher-funded value must be returned through its original credit
 * authority; this policy does not convert it to cash or reset its expiry.
 */
export function planMembershipChangeSettlement({calculation, policy, issuedAt}) {
  const checked=validateMembershipChangePolicy(policy);
  if (!calculation || calculation.version!==2 || calculation.entitlementApplied!==false
    || calculation.settlementStatus!=='not_started' || !Array.isArray(calculation.blockers)) {
    throw Object.assign(new Error('A verified pending membership calculation is required.'), {status:422});
  }
  const blockers=[...calculation.blockers];
  const cancelling=calculation.action==='cancel';
  const immediateCancellation=cancelling&&calculation.cancellationTiming==='immediate';
  if(immediateCancellation&&(calculation.cancellationChargeBasis!=='service_used'
    ||calculation.accessWaitsForSettlement!==false||calculation.paymentReactivatesMembership!==false
    ||!Number.isSafeInteger(calculation.paymentDueMinor)||calculation.paymentDueMinor<0)){
    throw Object.assign(new Error('Cancellation calculation must be refreshed using the service-used policy.'),{status:409});
  }
  const direction=cancelling?'cancel'
    : calculation.newCost.grossMinor===0 && calculation.unused.grossMinor===0 ? 'lateral'
    : calculation.targetFullPrice.grossMinor>calculation.finance.original.grossMinor?'upgrade'
    : calculation.targetFullPrice.grossMinor<calculation.finance.original.grossMinor?'downgrade':'lateral';
  let requiresApproval=direction==='upgrade'?checked.upgradesRequireApproval
    : direction==='downgrade'?checked.downgradesRequireApproval
    : direction==='lateral'?(checked.upgradesRequireApproval||checked.downgradesRequireApproval):false;
  if(cancelling && calculation.cancellationTiming!==checked.cancellationTiming) {
    throw Object.assign(new Error('Cancellation policy changed. Preview again.'), {status:409});
  }
  let surplusHandling='none',creditExpiresAt=null;
  const surplusEligible=calculation.surplusMinor>0
    && (!cancelling || checked.cancellationUnusedValue==='tenant_surplus_policy');
  if(surplusEligible) {
    surplusHandling=checked.surplusHandling;
    if(surplusHandling==='approval')requiresApproval=true;
    if(surplusHandling==='credit')creditExpiresAt=membershipSurplusCreditExpiry(checked,issuedAt);
    if(calculation.finance.voucherFunding.length)blockers.push('original_voucher_return_required');
  }
  return {
    changeType:direction,requiresApproval,
    ...(immediateCancellation?{cancellationChargeBasis:'service_used',
      accessWaitsForSettlement:false,paymentReactivatesMembership:false,
      accessEndExclusiveDate:calculation.membershipEndExclusiveDate}:{}),
    status:blockers.length?'requires_reconciliation':requiresApproval?'pending_approval':'ready_for_settlement',
    surplusHandling,creditExpiresAt,
    // A fixed server-owned rule, not a tenant/browser-selectable write-off
    // instruction. Approval may subsequently choose credit, so freeze the rule
    // for that path too. Expiry is not proof of an accounting adjustment.
    creditExpiryLiabilityTreatment:
      ['credit','approval'].includes(surplusHandling) ? 'manual_review' : null,
    surplusEligibleMinor:surplusEligible?calculation.surplusMinor:0,
    ...(immediateCancellation?{
      retainedPrepaidMinor:surplusEligible?0:calculation.surplusMinor,
    }:{}),
    paymentDueMinor:calculation.paymentDueMinor,
    futureObligationMinor:calculation.futureObligationMinor,
    blockers:[...new Set(blockers)],moneyMoved:false,entitlementApplied:false,
  };
}
