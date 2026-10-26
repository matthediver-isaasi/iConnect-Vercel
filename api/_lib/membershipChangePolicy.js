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
