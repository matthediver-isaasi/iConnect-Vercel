// Pure per-plan orchestration. No production client, clock, network or writer
// is reachable here; mutations can only cross the explicit effect capability.
const POLICIES = ['keep_active', 'restrict', 'suspend', 'manual_review', 'cancel_at_period_end'];
const ARREARS_STATUSES = ['payment_grace_period', 'payment_overdue'];
const iso = now => new Date(now).toISOString();

export function selectArrearsAccess(query, now) {
  return query.in('status', ARREARS_STATUSES)
    .or('arrears_policy_applied.is.null,arrears_policy_applied.eq.restrict')
    .not('grace_expires_at', 'is', null).lte('grace_expires_at', typeof now === 'string' ? now : iso(now));
}

export function selectArrearsMonthly(query, now) {
  return query.in('status', ARREARS_STATUSES).neq('provider', 'stripe').eq('interval_unit', 'monthly')
    .not('grace_expires_at', 'is', null).lte('grace_expires_at', typeof now === 'string' ? now : iso(now));
}

export function arrearsDue(plan, now) {
  return ARREARS_STATUSES.includes(plan.status) && !!plan.grace_expires_at
    && new Date(plan.grace_expires_at).getTime() <= new Date(now).getTime();
}

const update = (table, values, filters, description) => ({
  type: 'arrears_update', description, payload: { table, values, filters },
});
const scope = plan => [['eq', 'id', plan.id], ['eq', 'tenant_id', plan.tenant_id]];

async function restrictRole({ db, plan, agreement, tierConfig, effects, now }) {
  const tenantId = plan.tenant_id || agreement?.tenant_id;
  const fallbackRoleId = tierConfig?.dd_arrears_fallback_role_id;
  if (!tenantId || !plan.id) return { assigned: 0, skipped: 0, reason: 'missing-plan-tenant' };
  const attention = async (reason, code) => {
    await effects.perform(update('membership_payment_plans', {
      needs_attention: true, attention_reason: reason, updated_at: iso(now),
    }, scope(plan), reason));
    return { assigned: 0, skipped: 0, reason: code };
  };
  if (!fallbackRoleId) return attention(
    'Recurring-payment restriction requires a fallback role in the membership tier configuration.', 'missing-fallback-role');
  const roleResult = await db.from('role').select('id, name, is_tenant_admin')
    .eq('id', fallbackRoleId).eq('tenant_id', tenantId).maybeSingle();
  if (roleResult.error) throw new Error(`validate arrears fallback role failed: ${roleResult.error.message}`);
  const fallbackRole = roleResult.data;
  if (!fallbackRole || fallbackRole.is_tenant_admin) return attention(
    fallbackRole?.is_tenant_admin
      ? 'Tenant administrator roles cannot be used as a recurring-payment fallback role.'
      : 'The recurring-payment fallback role is missing or belongs to another tenant.',
    fallbackRole?.is_tenant_admin ? 'tenant-admin-fallback-role' : 'invalid-fallback-role');
  const memberId = agreement?.member_id || plan.member_id;
  const organizationId = agreement?.organization_id || plan.organization_id;
  let members = [];
  if (memberId || organizationId) {
    let query = db.from('member').select('id, tenant_id, organization_id, role_id').eq('tenant_id', tenantId);
    query = memberId ? query.eq('id', memberId) : query.eq('organization_id', organizationId);
    const result = await query;
    if (result.error) throw new Error(`load arrears restriction members failed: ${result.error.message}`);
    members = result.data || [];
  }
  let assigned = 0, skipped = 0;
  for (const member of members) {
    const rows = await effects.perform({
      type: 'arrears_rpc', description: 'Atomically assign fallback role if the member role still matches; preserve concurrent administrator changes.',
      payload: { name: 'apply_membership_arrears_fallback_role', args: {
        p_tenant_id: tenantId, p_plan_id: plan.id, p_member_id: member.id,
        p_config_id: tierConfig?.id || null, p_assigned_role_id: fallbackRoleId,
      } },
      continuation: 'Only a successful role assignment permits restriction notification. The prior role is durably audited by the RPC.',
    });
    if ((Array.isArray(rows) ? rows[0] : rows)?.result_status === 'applied') assigned++;
    else skipped++;
  }
  if (assigned > 0 && plan.attention_reason?.startsWith('Recurring-payment restriction requires a fallback role')) {
    await effects.perform(update('membership_payment_plans', {
      needs_attention: false, attention_reason: null, updated_at: iso(now),
    }, scope(plan), 'Clear resolved fallback-role warning.'));
  }
  return { assigned, skipped, roleId: fallbackRole.id, roleName: fallbackRole.name || null };
}

export async function runArrearsPolicy({ db, plan, agreement, tierConfig, now, effects, source = 'system' }) {
  const policy = POLICIES.includes(tierConfig?.dd_arrears_policy) ? tierConfig.dd_arrears_policy : 'manual_review';
  if (plan.arrears_policy_applied) {
    const roleAssignment = plan.arrears_policy_applied === 'restrict'
      ? await restrictRole({ db, plan, agreement, tierConfig, effects, now }) : null;
    return { applied: false, policy: plan.arrears_policy_applied, roleAssignment,
      fallbackRoleName: roleAssignment?.roleName || null, result: { skippedReason: 'already-applied' } };
  }
  const nowIso = iso(now);
  const result = await effects.perform({
    type: 'arrears_transition', description: `Attempt overdue status transition and record '${policy}' arrears policy.`,
    payload: {
      entityType: 'payment_plan', entityId: plan.id, toStatus: 'payment_overdue',
      reason: `grace expired — arrears policy '${policy}'`, source,
      extraUpdate: { arrears_policy_applied: policy, arrears_policy_applied_at: nowIso },
    },
    continuation: 'If transition is a no-op, claim the unapplied policy with compare-and-set. Agreement access flags, fallback roles and emails depend on that real result; no claim or notification is performed here.',
  });
  if (!result.applied) {
    const operation = update('membership_payment_plans', {
      arrears_policy_applied: policy, arrears_policy_applied_at: nowIso, updated_at: nowIso,
    }, [...scope(plan), ['is', 'arrears_policy_applied', null]], 'Claim unapplied arrears policy once.');
    operation.payload.returnOne = true;
    operation.payload.errorPolicy = 'claim_failed';
    const claimed = await effects.perform(operation);
    if (claimed?.claimFailed) return { applied: false, policy, result: { ...result, skippedReason: 'claim-failed' } };
    if (!claimed) return { applied: false, policy, result: { ...result, skippedReason: 'already-applied' } };
  }
  if (policy !== 'keep_active' && agreement) {
    const metadata = { ...(agreement.metadata || {}) };
    metadata.dd = { ...(metadata.dd || {}), arrears_state: policy, arrears_flagged_at: nowIso };
    const operation = update('membership_billing_agreements', { metadata, updated_at: nowIso },
      [['eq', 'id', agreement.id], ['eq', 'tenant_id', plan.tenant_id]], 'Flag agreement access state for the applied arrears policy.');
    operation.payload.errorPolicy = 'best_effort';
    await effects.perform(operation);
  }
  const roleAssignment = policy === 'restrict'
    ? await restrictRole({ db, plan, agreement, tierConfig, effects, now }) : null;
  return { applied: true, policy, result, roleAssignment, fallbackRoleName: roleAssignment?.roleName || null };
}

async function loadAgreement(db, plan, agreement) {
  if (agreement) return agreement;
  if (!plan.billing_agreement_id) return null;
  const result = await db.from('membership_billing_agreements').select('*')
    .eq('id', plan.billing_agreement_id).eq('tenant_id', plan.tenant_id).maybeSingle();
  if (result.error) throw new Error(`load arrears agreement failed: ${result.error.message}`);
  return result.data;
}

export async function runArrearsAccess({ db, plan, agreement, now, effects, trace = () => {} }) {
  if (!arrearsDue(plan, now) || (plan.arrears_policy_applied != null && plan.arrears_policy_applied !== 'restrict')) {
    trace({ stage: 'access-policy', status: 'skipped', reason: 'No expired-grace unapplied/restrict access policy is due.' });
    return { applied: false, result: { skippedReason: 'not-due' } };
  }
  agreement = await loadAgreement(db, plan, agreement);
  let tierConfig = null;
  const configId = agreement?.metadata?.dd?.config_id || agreement?.metadata?.card?.config_id;
  if (configId) {
    const result = await db.from('membership_tier_config')
      .select('id, tenant_id, dd_arrears_policy, dd_arrears_fallback_role_id')
      .eq('id', configId).eq('tenant_id', plan.tenant_id).maybeSingle();
    if (result.error) throw new Error(`load arrears tier configuration failed: ${result.error.message}`);
    tierConfig = result.data;
  }
  trace({ stage: 'access-policy', status: 'eligible', reason: 'Grace expired; access policy is independent of money collection.', evidenceAt: iso(now) });
  return runArrearsPolicy({ db, plan, agreement, tierConfig, now, effects });
}

export function monthlyAccrualOperation({ tenantId, plan, duePeriod, paymentReference = null }) {
  if (!tenantId || !plan?.id || !duePeriod) throw new Error('tenantId, plan and duePeriod are required');
  return {
    type: 'arrears_accrual', description: 'Accrue failed monthly period idempotently in the debt ledger.',
    amountMinor: plan.amount_minor, currency: plan.currency, date: duePeriod,
    payload: { name: 'accrue_membership_monthly_arrears_period', args: {
      p_tenant_id: tenantId, p_plan_id: plan.id, p_due_period: duePeriod,
      p_amount_minor: plan.amount_minor, p_currency: plan.currency, p_payment_reference: paymentReference,
    } },
    continuation: 'Collection is conditional on the resulting ledger and a separate intent lease. It may stop the subscription or request catch-up under the saved collection policy; provider acceptance and bank debit date are unknown.',
  };
}

export async function runArrearsMonthly({ db, plan, agreement, now, getGc, effects, trace = () => {} }) {
  if (!arrearsDue(plan, now) || plan.interval_unit !== 'monthly' || plan.provider == null || plan.provider === 'stripe') {
    trace({ stage: 'monthly-collection', status: 'skipped', reason: 'No expired-grace monthly GoCardless collection sweep is due.' });
    return { created: false, skipped: 'not-due' };
  }
  agreement = await loadAgreement(db, plan, agreement);
  if (!agreement) throw new Error('billing agreement not found');
  trace({ stage: 'monthly-collection', status: 'eligible', reason: 'Monthly debt accrual precedes collection; access policy is not a collection authorization.', evidenceAt: iso(now) });
  await effects.perform(monthlyAccrualOperation({
    tenantId: plan.tenant_id, plan,
    duePeriod: String(plan.failed_due_period || plan.grace_expires_at).slice(0, 10),
    paymentReference: plan.last_payment_id || null,
  }));
  // This continuation needs the actual accrual result and subsequent ledger.
  // Recording execution never reaches it or obtains provider credentials.
  return effects.perform({
    type: 'arrears_collection_continuation',
    description: 'Execute leased monthly collection against the post-accrual ledger.',
    payload: { plan, agreement },
  });
}

export const runArrears = runArrearsAccess;