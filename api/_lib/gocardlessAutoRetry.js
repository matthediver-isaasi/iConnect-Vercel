// Tenant-configured GoCardless collection retry policy and safe retry service.
//
// Automatic retries are deliberately separate from the existing retry_count:
// retry_count is the arrears/failure count, while auto_retry_attempts counts
// only provider retry requests made by this service. A plan row is the
// cross-path claim lock; the attempt ledger is the durable audit/idempotency
// record for each payment and attempt number.

import { supabase } from './database.js';
import { buildIdempotencyKey } from './gocardless.js';
import { assertRetryablePayment, isGraceExpired } from './gocardlessArrears.js';
import { STATUS } from './gocardlessState.js';

export const DEFAULT_AUTO_RETRY_POLICY = Object.freeze({
  enabled: false,
  intervalDays: 3,
  maxAttempts: 3,
});

export const AUTO_RETRY_LIMITS = Object.freeze({
  minIntervalDays: 1,
  maxIntervalDays: 30,
  minAttempts: 0,
  maxAttempts: 10,
});

export function normalizeAutoRetryPolicy(value = {}) {
  return {
    enabled: value.enabled === true || value.auto_retry_enabled === true,
    intervalDays: Number.isInteger(value.intervalDays)
      ? value.intervalDays
      : Number.isInteger(value.auto_retry_interval_days)
        ? value.auto_retry_interval_days
        : DEFAULT_AUTO_RETRY_POLICY.intervalDays,
    maxAttempts: Number.isInteger(value.maxAttempts)
      ? value.maxAttempts
      : Number.isInteger(value.auto_retry_max_attempts)
        ? value.auto_retry_max_attempts
        : DEFAULT_AUTO_RETRY_POLICY.maxAttempts,
  };
}

export function validateAutoRetryPolicy(value = {}) {
  const rawInterval = value.intervalDays ?? value.auto_retry_interval_days;
  const rawMaxAttempts = value.maxAttempts ?? value.auto_retry_max_attempts;
  const policy = normalizeAutoRetryPolicy(value);
  if (typeof (value.enabled ?? value.auto_retry_enabled) !== 'undefined'
      && typeof (value.enabled ?? value.auto_retry_enabled) !== 'boolean') {
    throw new Error('Automatic retry enabled must be a boolean');
  }
  if ((rawInterval !== undefined && !Number.isInteger(rawInterval))
      || !Number.isInteger(policy.intervalDays)
      || policy.intervalDays < AUTO_RETRY_LIMITS.minIntervalDays
      || policy.intervalDays > AUTO_RETRY_LIMITS.maxIntervalDays) {
    throw new Error(`Automatic retry interval must be a whole number from ${AUTO_RETRY_LIMITS.minIntervalDays} to ${AUTO_RETRY_LIMITS.maxIntervalDays} days`);
  }
  if ((rawMaxAttempts !== undefined && !Number.isInteger(rawMaxAttempts))
      || !Number.isInteger(policy.maxAttempts)
      || policy.maxAttempts < AUTO_RETRY_LIMITS.minAttempts
      || policy.maxAttempts > AUTO_RETRY_LIMITS.maxAttempts) {
    throw new Error(`Maximum automatic retries must be a whole number from ${AUTO_RETRY_LIMITS.minAttempts} to ${AUTO_RETRY_LIMITS.maxAttempts}`);
  }
  return policy;
}

export function automaticRetryDueAt(failedAt, intervalDays, graceExpiresAt = null) {
  const failed = new Date(failedAt);
  if (Number.isNaN(failed.getTime())) throw new Error('automaticRetryDueAt: invalid failedAt');
  const due = new Date(failed.getTime() + Number(intervalDays) * 86_400_000);
  if (graceExpiresAt) {
    const grace = new Date(graceExpiresAt);
    if (!Number.isNaN(grace.getTime()) && due.getTime() >= grace.getTime()) return null;
  }
  return due;
}

async function loadPolicy(db, tenantId) {
  const { data, error } = await db
    .from('tenant_integrations')
    .select('credentials, is_enabled')
    .eq('tenant_id', tenantId)
    .eq('integration_type', 'gocardless')
    .maybeSingle();
  if (error) throw new Error(`load GoCardless retry policy failed: ${error.message}`);
  const credentials = data?.credentials || {};
  const policy = normalizeAutoRetryPolicy(credentials);
  // Automatic collection is never enabled by a setting on a disconnected or
  // disabled integration. This also prevents platform fallback credentials
  // from accidentally collecting for a tenant with no local connection.
  return {
    ...policy,
    enabled: policy.enabled && data?.is_enabled === true && !!credentials.access_token,
    configured: !!data,
  };
}

function result(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

async function updateAttempt(db, attemptId, update) {
  const { error } = await db
    .from('gocardless_payment_retry_attempts')
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq('id', attemptId);
  if (error) throw new Error(`update GoCardless retry attempt failed: ${error.message}`);
}

async function unlockPlan(db, planId, claimToken, update = {}) {
  const { error } = await db
    .from('membership_payment_plans')
    .update({ ...update, auto_retry_claimed_at: null, auto_retry_claim_token: null, updated_at: new Date().toISOString() })
    .eq('id', planId)
    .eq('auto_retry_claim_token', claimToken);
  if (error) throw new Error(`release GoCardless retry claim failed: ${error.message}`);
}

async function closePlanRetry(db, plan, outcome, errorMessage = null) {
  const update = {
    auto_retry_next_at: null,
    auto_retry_last_outcome: outcome,
    auto_retry_last_error: errorMessage,
    ...(outcome === 'attempt_limit_exhausted' || outcome === 'grace_expired'
      ? { auto_retry_exhausted_at: new Date().toISOString() }
      : {}),
  };
  const { error } = await db
    .from('membership_payment_plans')
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq('id', plan.id)
    .eq('tenant_id', plan.tenant_id);
  if (error) console.error('[gocardlessAutoRetry] close schedule failed:', error.message);
  return update;
}

/**
 * Schedule the next retry after a confirmed failed payment event.
 * The grace deadline is never changed and the due date must be strictly
 * before it. The policy is read at each failure, so a tenant can turn future
 * retries on/off without changing the agreement's grace contract.
 */
export async function scheduleAutomaticRetry({
  tenantId, plan, paymentId, failedAt = new Date(), db: dbArg,
} = {}) {
  const db = dbArg || supabase;
  if (!tenantId || !plan?.id || !paymentId) return result('missing-linkage');
  const policy = await loadPolicy(db, tenantId);
  if (!policy.enabled || policy.maxAttempts <= 0) {
    await closePlanRetry(db, plan, 'disabled_policy');
    return result('disabled_policy', { policy });
  }
  if (plan.status !== STATUS.PAYMENT_GRACE_PERIOD || isGraceExpired(plan, new Date(failedAt))) {
    await closePlanRetry(db, plan, 'grace_expired');
    return result('grace_expired', { policy });
  }

  const attempts = Number.isInteger(plan.auto_retry_attempts) ? plan.auto_retry_attempts : 0;
  if (attempts >= policy.maxAttempts) {
    await closePlanRetry(db, plan, 'attempt_limit_exhausted');
    return result('attempt_limit_exhausted', { policy, attempts });
  }
  const due = automaticRetryDueAt(failedAt, policy.intervalDays, plan.grace_expires_at);
  if (!due) {
    await closePlanRetry(db, plan, 'grace_expired');
    return result('grace_expired', { policy, attempts });
  }
  const update = {
    auto_retry_next_at: due.toISOString(),
    auto_retry_payment_id: paymentId,
    auto_retry_last_outcome: 'scheduled',
    auto_retry_last_error: null,
    auto_retry_exhausted_at: null,
  };
  const { error } = await db
    .from('membership_payment_plans')
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq('id', plan.id)
    .eq('tenant_id', tenantId);
  if (error) throw new Error(`schedule GoCardless retry failed: ${error.message}`);
  return { ok: true, dueAt: due.toISOString(), attemptNumber: attempts + 1, policy };
}

export async function clearAutomaticRetryForPlan(plan, { db: dbArg, outcome = 'recovered' } = {}) {
  const db = dbArg || supabase;
  if (!plan?.id) return;
  const { error } = await db
    .from('membership_payment_plans')
    .update({
      auto_retry_attempts: 0,
      auto_retry_next_at: null,
      auto_retry_payment_id: null,
      auto_retry_last_outcome: outcome,
      auto_retry_last_error: null,
      auto_retry_exhausted_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', plan.id);
  if (error) console.error('[gocardlessAutoRetry] clear plan retry state failed:', error.message);
  if (outcome === 'recovered') {
    const { error: attemptError } = await db
      .from('gocardless_payment_retry_attempts')
      .update({
        status: 'recovered',
        outcome: 'payment_recovered',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('plan_id', plan.id)
      .eq('status', 'requested');
    if (attemptError) console.error('[gocardlessAutoRetry] mark recovered attempts failed:', attemptError.message);
  }
}

async function loadOrCreatePayment(db, tenantId, plan, paymentId) {
  const { data: existing, error } = await db
    .from('gocardless_payments')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('gocardless_payment_id', paymentId)
    .maybeSingle();
  if (error) throw new Error(`load GoCardless payment failed: ${error.message}`);
  if (existing && existing.plan_id && existing.plan_id !== plan.id) {
    return { error: result('payment_belongs_to_another_plan') };
  }
  if (existing) return { payment: existing };
  if (plan.last_payment_id !== paymentId && plan.auto_retry_payment_id !== paymentId) {
    return { error: result('payment_not_linked_to_plan') };
  }
  const { data, error: insertError } = await db
    .from('gocardless_payments')
    .insert({
      tenant_id: tenantId,
      plan_id: plan.id,
      gocardless_payment_id: paymentId,
      gocardless_subscription_id: plan.gocardless_subscription_id || null,
      gocardless_mandate_id: plan.gocardless_mandate_id || null,
      status: 'failed',
    })
    .select('*');
  if (insertError) {
    // A concurrent webhook may have created the mirror. Reload it rather
    // than treating a harmless unique race as a retry failure.
    const { data: raced } = await db
      .from('gocardless_payments')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('gocardless_payment_id', paymentId)
      .maybeSingle();
    if (raced) return { payment: raced };
    throw new Error(`create GoCardless payment mirror failed: ${insertError.message}`);
  }
  return { payment: Array.isArray(data) ? data[0] : data };
}

/**
 * Shared retry entry point for automatic, member, and admin actions.
 * It verifies tenant ownership, mandate usability, grace/limit policy for
 * automatic mode, and the live provider payment after taking the plan claim.
 */
export async function retryPaymentSafely({
  tenantId, plan, agreement = null, paymentId, mode = 'manual', actor = null,
  db: dbArg, gc, now = new Date(),
} = {}) {
  const db = dbArg || supabase;
  if (!tenantId || !plan?.id || !paymentId || !gc) return result('missing-linkage');
  if (plan.tenant_id && plan.tenant_id !== tenantId) return result('tenant_mismatch');
  const policy = mode === 'automatic' ? await loadPolicy(db, tenantId) : null;
  const freshPlanResult = await db.from('membership_payment_plans').select('*')
    .eq('id', plan.id).eq('tenant_id', tenantId).maybeSingle();
  if (freshPlanResult.error) throw new Error(`load retry plan failed: ${freshPlanResult.error.message}`);
  const currentPlan = freshPlanResult.data || plan;
  if ([STATUS.PAYMENT_PLAN_CANCELLED, STATUS.EXPIRED, STATUS.MANDATE_PENDING].includes(currentPlan.status)) {
    return result('plan_not_retryable');
  }
  if (mode === 'automatic') {
    if (!policy.enabled) return result('disabled_policy', { policy });
    if (currentPlan.status !== STATUS.PAYMENT_GRACE_PERIOD || isGraceExpired(currentPlan, now)) {
      await closePlanRetry(db, currentPlan, 'grace_expired');
      return result('grace_expired', { policy });
    }
    const count = Number.isInteger(currentPlan.auto_retry_attempts) ? currentPlan.auto_retry_attempts : 0;
    if (count >= policy.maxAttempts) {
      await closePlanRetry(db, currentPlan, 'attempt_limit_exhausted');
      return result('attempt_limit_exhausted', { policy, attempts: count });
    }
    if (currentPlan.auto_retry_payment_id !== paymentId
        || !currentPlan.auto_retry_next_at
        || new Date(currentPlan.auto_retry_next_at).getTime() > now.getTime()) {
      return result('not_due', { policy });
    }
  }

  const linked = await loadOrCreatePayment(db, tenantId, currentPlan, paymentId);
  if (linked.error) return linked.error;
  const payment = linked.payment;
  const mandateId = currentPlan.gocardless_mandate_id || agreement?.gocardless_mandate_id;
  if (mandateId) {
    let mandate;
    try { mandate = await gc.getMandate(mandateId); } catch { mandate = null; }
    if (!['pending_submission', 'submitted', 'active'].includes(mandate?.status)) {
      return result('mandate_unusable', { mandateStatus: mandate?.status || null });
    }
  }

  let attemptNumber;
  if (mode === 'automatic') {
    attemptNumber = (Number.isInteger(currentPlan.auto_retry_attempts) ? currentPlan.auto_retry_attempts : 0) + 1;
  } else {
    const { data: latestManual, error: latestManualError } = await db
      .from('gocardless_payment_retry_attempts')
      .select('attempt_number')
      .eq('tenant_id', tenantId)
      .eq('plan_id', currentPlan.id)
      .eq('gocardless_payment_id', paymentId)
      .eq('mode', 'manual')
      .order('attempt_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestManualError) throw new Error(`load prior manual retries failed: ${latestManualError.message}`);
    attemptNumber = Number.isInteger(latestManual?.attempt_number) ? latestManual.attempt_number + 1 : 1;
  }
  const idempotencyKey = mode === 'automatic'
    ? buildIdempotencyKey('dd-auto-retry', tenantId, currentPlan.id, paymentId, String(attemptNumber))
    : buildIdempotencyKey('dd-manual-retry', tenantId, currentPlan.id, paymentId, String(attemptNumber));
  const claimToken = buildIdempotencyKey('dd-retry-claim', tenantId, currentPlan.id, paymentId, mode, String(attemptNumber));

  if (currentPlan.auto_retry_claimed_at) {
    if (String(currentPlan.auto_retry_claim_token || '').startsWith('cancel:')) {
      return result('cancellation_in_progress');
    }
    const claimedAt = new Date(currentPlan.auto_retry_claimed_at).getTime();
    const stale = Number.isFinite(claimedAt) && claimedAt <= now.getTime() - 30 * 60_000;
    if (!stale) return result('retry_in_progress');
    const { error: staleError } = await db
      .from('membership_payment_plans')
      .update({ auto_retry_claimed_at: null, auto_retry_claim_token: null, updated_at: now.toISOString() })
      .eq('id', currentPlan.id)
      .eq('tenant_id', tenantId)
      .eq('auto_retry_claim_token', currentPlan.auto_retry_claim_token);
    if (staleError) throw new Error(`release stale GoCardless retry claim failed: ${staleError.message}`);
  }

  // The plan claim is shared by manual and automatic modes. One successful
  // guarded update means cron/member/admin callers cannot overlap.
  const { data: claimed, error: claimError } = await db
    .from('membership_payment_plans')
    .update({
      auto_retry_claimed_at: now.toISOString(),
      auto_retry_claim_token: claimToken,
      auto_retry_last_outcome: 'claimed',
      updated_at: now.toISOString(),
    })
    .eq('id', currentPlan.id)
    .eq('tenant_id', tenantId)
    .is('auto_retry_claimed_at', null)
    .select('id');
  if (claimError) throw new Error(`claim GoCardless retry failed: ${claimError.message}`);
  if (!claimed || claimed.length === 0) return result('retry_in_progress');

  let attempt;
  try {
    const { data: inserted, error: attemptError } = await db
      .from('gocardless_payment_retry_attempts')
      .insert({
        tenant_id: tenantId,
        plan_id: currentPlan.id,
        gocardless_payment_id: paymentId,
        attempt_number: attemptNumber,
        mode,
        status: 'claimed',
        idempotency_key: idempotencyKey,
        claimed_at: now.toISOString(),
      })
      .select('*');
    if (attemptError) {
      const existingAttempt = await db.from('gocardless_payment_retry_attempts')
        .select('*').eq('idempotency_key', idempotencyKey).maybeSingle();
      if (existingAttempt.data?.status === 'requested') {
        await unlockPlan(db, currentPlan.id, claimToken, { auto_retry_last_outcome: 'requested' });
        return { ok: true, duplicate: true, attempt: existingAttempt.data };
      }
      if (existingAttempt.error || !existingAttempt.data) throw new Error(`claim retry attempt failed: ${attemptError.message}`);
      attempt = existingAttempt.data;
      await updateAttempt(db, attempt.id, { status: 'claimed', error_message: null, claimed_at: now.toISOString() });
    } else {
      attempt = Array.isArray(inserted) ? inserted[0] : inserted;
    }

    // Re-fetch immediately before the mutating provider call. Local failed
    // state is intentionally ignored for this never-double-charge decision.
    const livePayment = await gc.getPayment(paymentId);
    try {
      assertRetryablePayment(livePayment);
    } catch (err) {
      await updateAttempt(db, attempt.id, {
        status: 'refused',
        outcome: 'live_status_refused',
        provider_status: livePayment?.status || null,
        error_message: err.message,
        completed_at: now.toISOString(),
      });
      await unlockPlan(db, currentPlan.id, claimToken, {
        auto_retry_next_at: null,
        auto_retry_last_outcome: 'live_status_refused',
        auto_retry_last_error: err.message,
      });
      return result('live_status_refused', { gcStatus: livePayment?.status || null, error: err.message });
    }

    // Cancellation webhooks and admin cancellation actions invalidate this
    // claim. Revalidate after the remote reads and immediately before the
    // provider mutation so a terminal transition cannot race a retry request.
    if (mandateId) {
      const latestMandate = await gc.getMandate(mandateId).catch(() => null);
      if (!['pending_submission', 'submitted', 'active'].includes(latestMandate?.status)) {
        await updateAttempt(db, attempt.id, {
          status: 'refused',
          outcome: 'mandate_unusable',
          provider_status: latestMandate?.status || null,
          completed_at: now.toISOString(),
        });
        await unlockPlan(db, currentPlan.id, claimToken, {
          auto_retry_next_at: null,
          auto_retry_last_outcome: 'mandate_unusable',
        });
        return result('mandate_unusable', { mandateStatus: latestMandate?.status || null });
      }
    }
    const claimCheck = await db
      .from('membership_payment_plans')
      .select('status, grace_expires_at, auto_retry_claim_token')
      .eq('id', currentPlan.id)
      .eq('tenant_id', tenantId)
      .eq('auto_retry_claim_token', claimToken)
      .maybeSingle();
    if (claimCheck.error) throw new Error(`revalidate GoCardless retry claim failed: ${claimCheck.error.message}`);
    const claimedPlan = claimCheck.data;
    if (!claimedPlan
        || [STATUS.PAYMENT_PLAN_CANCELLED, STATUS.EXPIRED, STATUS.MANDATE_PENDING].includes(claimedPlan.status)
        || (mode === 'automatic'
          && (claimedPlan.status !== STATUS.PAYMENT_GRACE_PERIOD || isGraceExpired(claimedPlan, now)))) {
      await updateAttempt(db, attempt.id, {
        status: 'refused',
        outcome: 'claim_invalidated',
        completed_at: now.toISOString(),
      });
      return result('claim_invalidated');
    }
    if (mode === 'automatic') {
      const latestPolicy = await loadPolicy(db, tenantId);
      if (!latestPolicy.enabled || attemptNumber > latestPolicy.maxAttempts) {
        await updateAttempt(db, attempt.id, {
          status: 'refused',
          outcome: 'disabled_policy',
          completed_at: now.toISOString(),
        });
        await unlockPlan(db, currentPlan.id, claimToken, {
          auto_retry_next_at: null,
          auto_retry_last_outcome: 'disabled_policy',
        });
        return result('disabled_policy', { policy: latestPolicy });
      }
    }

    const retried = await gc.retryPayment(paymentId, { idempotencyKey });
    await updateAttempt(db, attempt.id, {
      status: 'requested',
      outcome: 'requested',
      provider_status: retried?.status || null,
      completed_at: now.toISOString(),
      error_message: null,
    });
    const planUpdate = mode === 'automatic'
      ? {
          auto_retry_attempts: attemptNumber,
          auto_retry_next_at: null,
          auto_retry_payment_id: paymentId,
          auto_retry_last_outcome: 'requested',
          auto_retry_last_error: null,
          auto_retry_exhausted_at: attemptNumber >= policy.maxAttempts ? now.toISOString() : null,
        }
      : { auto_retry_next_at: null, auto_retry_last_outcome: 'manual_requested', auto_retry_last_error: null };
    await unlockPlan(db, currentPlan.id, claimToken, planUpdate);
    return { ok: true, payment: retried, attempt: { ...attempt, status: 'requested' }, actor };
  } catch (err) {
    if (attempt?.id) {
      await updateAttempt(db, attempt.id, {
        status: 'failed',
        outcome: 'provider_error',
        error_message: err.message,
        completed_at: now.toISOString(),
      }).catch((updateError) => console.error('[gocardlessAutoRetry] record provider error failed:', updateError.message));
    }
    const due = mode === 'automatic'
      ? automaticRetryDueAt(
          now,
          policy?.intervalDays || DEFAULT_AUTO_RETRY_POLICY.intervalDays,
          currentPlan.grace_expires_at,
        )
      : null;
    await unlockPlan(db, currentPlan.id, claimToken, {
      auto_retry_next_at: due?.toISOString() || null,
      auto_retry_payment_id: paymentId,
      auto_retry_last_outcome: due ? 'provider_error' : 'grace_expired',
      auto_retry_last_error: err.message,
      ...(due ? {} : { auto_retry_exhausted_at: now.toISOString() }),
    });
    throw err;
  }
}

export async function closeAutomaticRetrySchedule(plan, reason, { db: dbArg } = {}) {
  const db = dbArg || supabase;
  return closePlanRetry(db, plan, reason);
}

export async function claimPlanForCancellation(plan, { db: dbArg, actor = 'system' } = {}) {
  const db = dbArg || supabase;
  if (!plan?.id || !plan?.tenant_id) return null;
  const token = `cancel:${buildIdempotencyKey('dd-cancel-claim', plan.tenant_id, plan.id, actor, new Date().toISOString())}`;
  const { data, error } = await db
    .from('membership_payment_plans')
    .update({
      auto_retry_next_at: null,
      auto_retry_claimed_at: new Date().toISOString(),
      auto_retry_claim_token: token,
      auto_retry_last_outcome: 'cancellation_in_progress',
      updated_at: new Date().toISOString(),
    })
    .eq('id', plan.id)
    .eq('tenant_id', plan.tenant_id)
    .is('auto_retry_claimed_at', null)
    .select('id');
  if (error) throw new Error(`claim plan cancellation failed: ${error.message}`);
  return data?.length ? token : null;
}

export async function releaseCancellationClaim(plan, token, { db: dbArg, outcome = 'cancellation_error' } = {}) {
  const db = dbArg || supabase;
  if (!plan?.id || !token) return;
  const { error } = await db
    .from('membership_payment_plans')
    .update({
      auto_retry_next_at: plan.auto_retry_next_at || null,
      auto_retry_claimed_at: null,
      auto_retry_claim_token: null,
      auto_retry_last_outcome: outcome,
      updated_at: new Date().toISOString(),
    })
    .eq('id', plan.id)
    .eq('tenant_id', plan.tenant_id)
    .eq('auto_retry_claim_token', token);
  if (error) throw new Error(`release plan cancellation claim failed: ${error.message}`);
}

export async function completeCancellationClaim(plan, token, { db: dbArg, outcome = 'cancelled' } = {}) {
  const db = dbArg || supabase;
  if (!plan?.id || !String(token || '').startsWith('cancel:')) return;
  const { error } = await db
    .from('membership_payment_plans')
    .update({
      auto_retry_next_at: null,
      auto_retry_claimed_at: null,
      auto_retry_claim_token: null,
      auto_retry_last_outcome: outcome,
      auto_retry_last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', plan.id)
    .eq('tenant_id', plan.tenant_id)
    .eq('auto_retry_claim_token', token);
  if (error) throw new Error(`complete plan cancellation claim failed: ${error.message}`);
}

export { loadPolicy as getAutoRetryPolicy };