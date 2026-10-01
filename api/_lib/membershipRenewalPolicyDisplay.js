import {
  loadExpiryOnlyRenewalPolicy,
  expiryOnlyRenewalPolicyDisplay,
} from './expiryOnlyRenewalPolicy.js';

const POLICY_UNAVAILABLE = 'Renewal policy unavailable. The approved assignment could not be verified.';

/**
 * Call only after authorizing the owner and loading tenant-scoped history.
 * This is a read-only projection, never a replacement for purchased terms.
 * The authority loader alone handles missing-schema compatibility; all other
 * failures remain visible and must not enable inferred renewal eligibility.
 */
export async function attachExpiryRenewalPolicyDisplay(db, {
  tenantId,
  memberId,
  history,
  loadPolicy = loadExpiryOnlyRenewalPolicy,
}) {
  for (const record of history || []) {
    delete record.expiry_renewal_policy;
    delete record.expiry_renewal_policy_error;
    if (record.membership_source !== 'personal'
        || record.tenant_id !== tenantId || record.member_id !== memberId) continue;
    try {
      const policy = await loadPolicy(db, { tenantId, history: record });
      const display = expiryOnlyRenewalPolicyDisplay(policy);
      if (display) record.expiry_renewal_policy = display;
    } catch {
      // Do not leak database details, assignment IDs, or approval evidence.
      record.expiry_renewal_policy_error = POLICY_UNAVAILABLE;
    }
  }
}

export function legacyRenewalPolicyDisplay(record) {
  return {
    ...(record?.expiry_renewal_policy
      ? { expiry_renewal_policy: record.expiry_renewal_policy } : {}),
    ...(record?.expiry_renewal_policy_error
      ? { expiry_renewal_policy_error: record.expiry_renewal_policy_error } : {}),
  };
}