// GoCardless Phase 4 — arrears state machine + grace-period handling.
//
// Design rules:
//   - Grace days come from the agreement's SNAPSHOT (metadata.dd.grace_days,
//     captured at consent time) — never from the live tier config. Changing
//     the tier's grace setting must not retroactively change the terms a
//     payer agreed to.
//   - The post-grace arrears POLICY (what happens when grace expires) is the
//     tenant's current operational choice, so it IS read live from
//     membership_tier_config.dd_arrears_policy.
//   - Never-double-charge: a retry is only allowed after the GoCardless API
//     confirms the payment is actually 'failed'. Local state alone is never
//     enough to authorise a re-collection.
//   - All db/gc dependencies injectable for tests.

import { supabase } from './database.js';
import { applyStatusTransition, STATUS } from './gocardlessState.js';
import {
  accrueFailedMonthlyPeriod,
} from './monthlyArrearsCollection.js';

export const DEFAULT_GRACE_DAYS = 7;

export const ARREARS_POLICIES = Object.freeze([
  'keep_active',
  'restrict',
  'suspend',
  'manual_review',
  'cancel_at_period_end',
]);

/**
 * Grace days from the agreement snapshot (metadata.dd.grace_days).
 * NEVER reads live tier config — the snapshot is the contract.
 */
export function graceDaysForAgreement(agreement) {
  const raw = agreement?.metadata?.dd?.grace_days;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(Math.floor(n), 90);
  return DEFAULT_GRACE_DAYS;
}

/**
 * Compute the grace expiry timestamp for a failure.
 * @param {string|Date} failedAt  when the failure landed
 * @param {number} graceDays      snapshot grace days
 * @param {number} [extendedDays] admin-granted extension (plan.grace_extended_days)
 */
export function computeGraceExpiry(failedAt, graceDays, extendedDays = 0) {
  const base = new Date(failedAt);
  if (Number.isNaN(base.getTime())) throw new Error('computeGraceExpiry: invalid failedAt');
  const days = (Number(graceDays) || 0) + (Number(extendedDays) || 0);
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

export function isGraceExpired(plan, now = new Date()) {
  if (!plan?.grace_expires_at) return false;
  return new Date(plan.grace_expires_at).getTime() <= now.getTime();
}

/**
 * Resolve the arrears policy for a plan from the live tier config row.
 * Unknown/missing values collapse to 'manual_review' (safest default).
 */
export function resolveArrearsPolicy(tierConfig) {
  const policy = tierConfig?.dd_arrears_policy;
  return ARREARS_POLICIES.includes(policy) ? policy : 'manual_review';
}

async function markMissingRestrictionRole(db, plan, reason) {
  if (!plan?.id) return;
  const update = {
    needs_attention: true,
    attention_reason: reason,
    updated_at: new Date().toISOString(),
  };
  let query = db.from('membership_payment_plans').update(update).eq('id', plan.id);
  if (plan.tenant_id) query = query.eq('tenant_id', plan.tenant_id);
  const { error } = await query;
  if (error) throw new Error(`record arrears fallback-role issue failed: ${error.message}`);
}

async function loadRestrictionCandidates(db, plan, agreement, tenantId) {
  const memberId = agreement?.member_id || plan?.member_id || null;
  const organizationId = agreement?.organization_id || plan?.organization_id || null;
  let query = db
    .from('member')
    .select('id, tenant_id, organization_id, role_id')
    .eq('tenant_id', tenantId);
  if (memberId) {
    query = query.eq('id', memberId);
  } else if (organizationId) {
    query = query.eq('organization_id', organizationId);
  } else {
    return [];
  }
  const { data, error } = await query;
  if (error) throw new Error(`load arrears restriction members failed: ${error.message}`);
  return data || [];
}

/**
 * Assign the configured tenant role to the member(s) affected by an overdue
 * recurring plan. One immutable audit row per plan/member stores the prior
 * role. Role updates use a compare-and-set so a concurrent administrator edit
 * is never overwritten.
 */
export async function applyArrearsRestrictionRole({
  plan,
  agreement,
  tierConfig,
  db: dbArg,
} = {}) {
  const db = dbArg || supabase;
  const tenantId = plan?.tenant_id || agreement?.tenant_id || null;
  const fallbackRoleId = tierConfig?.dd_arrears_fallback_role_id || null;
  if (!tenantId || !plan?.id) {
    return { assigned: 0, skipped: 0, reason: 'missing-plan-tenant' };
  }
  if (!fallbackRoleId) {
    await markMissingRestrictionRole(
      db,
      plan,
      'Recurring-payment restriction requires a fallback role in the membership tier configuration.',
    );
    return { assigned: 0, skipped: 0, reason: 'missing-fallback-role' };
  }

  const { data: fallbackRole, error: fallbackError } = await db
    .from('role')
    .select('id, name, is_tenant_admin')
    .eq('id', fallbackRoleId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (fallbackError) throw new Error(`validate arrears fallback role failed: ${fallbackError.message}`);
  if (!fallbackRole || fallbackRole.is_tenant_admin) {
    await markMissingRestrictionRole(
      db,
      plan,
      fallbackRole?.is_tenant_admin
        ? 'Tenant administrator roles cannot be used as a recurring-payment fallback role.'
        : 'The recurring-payment fallback role is missing or belongs to another tenant.',
    );
    return {
      assigned: 0,
      skipped: 0,
      reason: fallbackRole?.is_tenant_admin ? 'tenant-admin-fallback-role' : 'invalid-fallback-role',
    };
  }

  const members = await loadRestrictionCandidates(db, plan, agreement, tenantId);
  let assigned = 0;
  let skipped = 0;
  for (const member of members) {
    const { data: rpcRows, error: rpcError } = await db.rpc(
      'apply_membership_arrears_fallback_role',
      {
        p_tenant_id: tenantId,
        p_plan_id: plan.id,
        p_member_id: member.id,
        p_config_id: tierConfig?.id || null,
        p_assigned_role_id: fallbackRoleId,
      },
    );
    if (rpcError) throw new Error(`atomically assign arrears fallback role failed: ${rpcError.message}`);
    const status = (Array.isArray(rpcRows) ? rpcRows[0] : rpcRows)?.result_status;
    if (status === 'applied') assigned++;
    else skipped++;
  }

  if (
    assigned > 0
    && typeof plan.attention_reason === 'string'
    && plan.attention_reason.startsWith('Recurring-payment restriction requires a fallback role')
  ) {
    const { error: clearError } = await db
      .from('membership_payment_plans')
      .update({ needs_attention: false, attention_reason: null, updated_at: new Date().toISOString() })
      .eq('id', plan.id)
      .eq('tenant_id', tenantId);
    if (clearError) throw new Error(`clear arrears fallback-role issue failed: ${clearError.message}`);
  }

  return {
    assigned,
    skipped,
    roleId: fallbackRole.id,
    roleName: fallbackRole.name || null,
  };
}

/**
 * Restore roles changed by applyArrearsRestrictionRole. A role is restored
 * only while the member still has the exact fallback role assigned by this
 * plan. Later administrator edits are marked as preserved and never replaced.
 */
export async function restoreArrearsRoleAssignments({ plan, agreement, db: dbArg } = {}) {
  const db = dbArg || supabase;
  const tenantId = plan?.tenant_id || agreement?.tenant_id || null;
  if (!tenantId || !plan?.id) return { restored: 0, preserved: 0 };

  const { data: actions, error } = await db
    .from('membership_arrears_role_action')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('plan_id', plan.id)
    .is('restored_at', null);
  if (error) throw new Error(`load arrears role recovery actions failed: ${error.message}`);

  let restored = 0;
  let preserved = 0;
  for (const action of actions || []) {
    const { data: rpcRows, error: rpcError } = await db.rpc(
      'restore_membership_arrears_fallback_role',
      { p_tenant_id: tenantId, p_action_id: action.id },
    );
    if (rpcError) throw new Error(`atomically restore arrears fallback role failed: ${rpcError.message}`);
    const restorationStatus = (Array.isArray(rpcRows) ? rpcRows[0] : rpcRows)?.result_status;
    if (restorationStatus === 'restored') restored++;
    else if (restorationStatus !== 'already_completed') preserved++;
  }
  return { restored, preserved };
}

/**
 * Never-double-charge guard. Given the CURRENT payment resource fetched from
 * the GoCardless API, decide whether a retry may be issued.
 * THROWS when the retry must be refused; returns true otherwise, so a
 * forgotten call site can never silently authorise a re-collection.
 */
export function assertRetryablePayment(gcPayment) {
  if (!gcPayment) throw new Error('payment not found at GoCardless — retry refused (never-double-charge)');
  if (gcPayment.status !== 'failed') {
    throw new Error(`payment status is '${gcPayment.status}', not 'failed' — retry refused (never-double-charge)`);
  }
  return true;
}

/**
 * Handle a payment failure webhook for a plan: enter/extend the arrears
 * state using SNAPSHOT grace days. First failure → grace period with a
 * concrete grace_expires_at; failure after grace expiry (or repeated
 * failures once already overdue) → overdue.
 *
 * Returns { toStatus, result, graceExpiresAt }.
 */
export async function handlePaymentFailure({ plan, agreement, event, action, db: dbArg } = {}) {
  const db = dbArg || supabase;
  const now = new Date();
  const retryCount = (plan.retry_count || 0) + 1;
  const graceDays = graceDaysForAgreement(agreement);

  // Keep an existing grace window if one is running; otherwise open one now.
  let graceExpiresAt = plan.grace_expires_at ? new Date(plan.grace_expires_at) : null;
  if (!graceExpiresAt || Number.isNaN(graceExpiresAt.getTime())) {
    graceExpiresAt = computeGraceExpiry(now, graceDays, plan.grace_extended_days || 0);
  }

  const overdue = graceExpiresAt.getTime() <= now.getTime() || plan.status === STATUS.PAYMENT_OVERDUE;
  const toStatus = overdue ? STATUS.PAYMENT_OVERDUE : STATUS.PAYMENT_GRACE_PERIOD;

  const result = await applyStatusTransition({
    entityType: 'payment_plan',
    entityId: plan.id,
    toStatus,
    reason: `payment ${action || 'failed'} (failure #${retryCount}, grace ${graceDays}d from snapshot)`,
    source: 'webhook',
    eventId: event?.id || null,
    extraUpdate: {
      retry_count: retryCount,
      grace_expires_at: graceExpiresAt.toISOString(),
    },
  }, { db });

  // Even when the transition is a no-op (already in grace), keep the plan's
  // failure bookkeeping current.
  if (!result.applied) {
    const { error } = await db
      .from('membership_payment_plans')
      .update({
        retry_count: retryCount,
        grace_expires_at: graceExpiresAt.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq('id', plan.id);
    if (error) console.error('[gocardlessArrears] failure bookkeeping update failed:', error.message);
  }
  // A later failed collection must retain the original grace deadline but,
  // under the snapshotted catch-up contract, gets its own idempotent period.
  // The unique tenant/plan/due-period RPC makes replay safe.
  if (plan.interval_unit === 'monthly') {
    if (!plan.failed_due_period || !plan.failed_provider_reference) {
      throw new Error('authoritative failed due period/reference required for immediate GC arrears accrual');
    }
    await accrueFailedMonthlyPeriod({
      tenantId: plan.tenant_id,
      plan,
      duePeriod: plan.failed_due_period,
      paymentReference: plan.failed_provider_reference,
      db,
    });
  }

  return { toStatus, result, graceExpiresAt: graceExpiresAt.toISOString(), retryCount };
}

/**
 * Apply the tenant's arrears policy to a plan whose grace window has
 * expired. Marks the plan overdue, records which policy was applied, and
 * flags the agreement metadata so member/admin surfaces can react.
 * Policy effects:
 *   keep_active           — record only; membership untouched
 *   restrict / suspend    — record + flag agreement metadata.dd.arrears_state
 *   cancel_at_period_end  — record + flag; actual cancel is an explicit admin action
 *   manual_review         — record + flag for the admin console queue
 *
 * Returns { applied, policy, result }.
 */
export async function applyArrearsPolicy({ plan, agreement, tierConfig, source = 'system', db: dbArg } = {}) {
  const db = dbArg || supabase;
  const policy = resolveArrearsPolicy(tierConfig);
  const nowIso = new Date().toISOString();

  if (plan.arrears_policy_applied) {
    const roleAssignment = plan.arrears_policy_applied === 'restrict'
      ? await applyArrearsRestrictionRole({ plan, agreement, tierConfig, db })
      : null;
    return {
      applied: false,
      policy: plan.arrears_policy_applied,
      roleAssignment,
      fallbackRoleName: roleAssignment?.roleName || null,
      result: { skippedReason: 'already-applied' },
    };
  }

  const result = await applyStatusTransition({
    entityType: 'payment_plan',
    entityId: plan.id,
    toStatus: STATUS.PAYMENT_OVERDUE,
    reason: `grace expired — arrears policy '${policy}'`,
    source,
    extraUpdate: {
      arrears_policy_applied: policy,
      arrears_policy_applied_at: nowIso,
    },
  }, { db });

  // If already overdue the transition no-ops; still record the policy once.
  if (!result.applied) {
    const { data: claimed, error } = await db
      .from('membership_payment_plans')
      .update({ arrears_policy_applied: policy, arrears_policy_applied_at: nowIso, updated_at: nowIso })
      .eq('id', plan.id)
      .is('arrears_policy_applied', null)
      .select('id')
      .maybeSingle();
    if (error) console.error('[gocardlessArrears] record arrears policy failed:', error.message);
    if (error || !claimed) {
      return {
        applied: false,
        policy,
        result: { ...result, skippedReason: error ? 'claim-failed' : 'already-applied' },
      };
    }
  }

  if (policy !== 'keep_active' && agreement) {
    const metadata = { ...(agreement.metadata || {}) };
    metadata.dd = { ...(metadata.dd || {}), arrears_state: policy, arrears_flagged_at: nowIso };
    const { error } = await db
      .from('membership_billing_agreements')
      .update({ metadata, updated_at: nowIso })
      .eq('id', agreement.id);
    if (error) console.error('[gocardlessArrears] flag agreement arrears state failed:', error.message);
  }

  const roleAssignment = policy === 'restrict'
    ? await applyArrearsRestrictionRole({ plan, agreement, tierConfig, db })
    : null;

  return {
    applied: true,
    policy,
    result,
    roleAssignment,
    fallbackRoleName: roleAssignment?.roleName || null,
  };
}

/**
 * Clear the arrears bookkeeping after a successful payment (recovery).
 * Returns the extraUpdate columns callers should merge into the ACTIVE
 * transition so recovery is one guarded write.
 */
export function recoveryPlanUpdate() {
  return {
    retry_count: 0,
    grace_expires_at: null,
    arrears_policy_applied: null,
    arrears_policy_applied_at: null,
    failed_due_period: null,
    failed_provider_reference: null,
  };
}

/**
 * Clear the agreement-level arrears flag after recovery (best-effort).
 */
export async function clearAgreementArrearsFlag(agreement, { db: dbArg } = {}) {
  const db = dbArg || supabase;
  if (!agreement?.metadata?.dd?.arrears_state) return { cleared: false };
  const metadata = { ...(agreement.metadata || {}) };
  metadata.dd = { ...(metadata.dd || {}) };
  delete metadata.dd.arrears_state;
  delete metadata.dd.arrears_flagged_at;
  const { error } = await db
    .from('membership_billing_agreements')
    .update({ metadata, updated_at: new Date().toISOString() })
    .eq('id', agreement.id);
  if (error) {
    console.error('[gocardlessArrears] clear agreement arrears flag failed:', error.message);
    return { cleared: false };
  }
  return { cleared: true };
}
