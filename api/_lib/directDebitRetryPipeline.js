// Capability-only retry orchestration. No production clients or effectful imports.
// The claim is the uncertainty boundary: provider payment validation MUST still
// happen after a real claim; recording cannot pretend that claim succeeded.
import { createHash } from 'node:crypto';

const refused = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const terminal = ['payment_plan_cancelled', 'expired', 'mandate_pending'];
const key = (...parts) => createHash('sha256').update(parts.join('|')).digest('hex');

export function selectDueRetries(query, now) {
  return query.eq('status', 'payment_grace_period')
    .not('auto_retry_next_at', 'is', null).lte('auto_retry_next_at', now.toISOString());
}

export function isRetryDue(plan, now) {
  return plan.status === 'payment_grace_period' && !!plan.auto_retry_next_at
    && new Date(plan.auto_retry_next_at).getTime() <= now.getTime();
}

export async function readRetryPolicy(db, tenantId) {
  const { data, error } = await db.from('tenant_integrations').select('credentials, is_enabled')
    .eq('tenant_id', tenantId).eq('integration_type', 'gocardless').maybeSingle();
  if (error) throw new Error(`load GoCardless retry policy failed: ${error.message}`);
  const c = data?.credentials || {};
  return {
    enabled: (c.enabled === true || c.auto_retry_enabled === true)
      && data?.is_enabled === true && !!c.access_token,
    intervalDays: Number.isInteger(c.intervalDays) ? c.intervalDays
      : Number.isInteger(c.auto_retry_interval_days) ? c.auto_retry_interval_days : 3,
    maxAttempts: Number.isInteger(c.maxAttempts) ? c.maxAttempts
      : Number.isInteger(c.auto_retry_max_attempts) ? c.auto_retry_max_attempts : 3,
    configured: !!data,
  };
}

export async function runRetry({
  db, plan, agreement = null, now, gc, effects,
  tenantId = plan?.tenant_id, paymentId = plan?.auto_retry_payment_id,
  mode = 'automatic', actor = null,
}) {
  if (!tenantId || !plan?.id || !paymentId || !gc) return refused('missing-linkage');
  if (plan.tenant_id && plan.tenant_id !== tenantId) return refused('tenant_mismatch');
  const policy = mode === 'automatic' ? await readRetryPolicy(db, tenantId) : null;
  const fresh = await db.from('membership_payment_plans').select('*')
    .eq('id', plan.id).eq('tenant_id', tenantId).maybeSingle();
  if (fresh.error) throw new Error(`load retry plan failed: ${fresh.error.message}`);
  const currentPlan = fresh.data || plan;
  if (terminal.includes(currentPlan.status)) return refused('plan_not_retryable');
  const close = async (reason, extra = {}) => {
    await effects.perform({ type: 'retry.close_schedule', description: `Close automatic retry schedule: ${reason}`,
      payload: { plan: currentPlan, reason } });
    return refused(reason, { policy, ...extra });
  };
  if (mode === 'automatic') {
    if (!policy.enabled) return refused('disabled_policy', { policy });
    if (currentPlan.status !== 'payment_grace_period'
      || (currentPlan.grace_expires_at && new Date(currentPlan.grace_expires_at).getTime() <= now.getTime())) {
      return close('grace_expired');
    }
    const count = Number.isInteger(currentPlan.auto_retry_attempts) ? currentPlan.auto_retry_attempts : 0;
    if (count >= policy.maxAttempts) return close('attempt_limit_exhausted', { attempts: count });
    if (currentPlan.auto_retry_payment_id !== paymentId || !currentPlan.auto_retry_next_at
      || new Date(currentPlan.auto_retry_next_at).getTime() > now.getTime()) return refused('not_due', { policy });
  }

  const paymentResult = await db.from('gocardless_payments').select('*')
    .eq('tenant_id', tenantId).eq('gocardless_payment_id', paymentId).maybeSingle();
  if (paymentResult.error) throw new Error(`load GoCardless payment failed: ${paymentResult.error.message}`);
  let payment = paymentResult.data;
  if (payment?.plan_id && payment.plan_id !== currentPlan.id) return refused('payment_belongs_to_another_plan');
  if (!payment) {
    if (currentPlan.last_payment_id !== paymentId && currentPlan.auto_retry_payment_id !== paymentId) {
      return refused('payment_not_linked_to_plan');
    }
    payment = await effects.perform({
      type: 'retry.create_payment_mirror',
      description: 'Create missing payment mirror before mandate validation and retry claim; later retry is conditional.',
      conditional: true,
      payload: { tenantId, plan: currentPlan, paymentId, insert: {
        tenant_id: tenantId, plan_id: currentPlan.id, gocardless_payment_id: paymentId,
        gocardless_subscription_id: currentPlan.gocardless_subscription_id || null,
        gocardless_mandate_id: currentPlan.gocardless_mandate_id || null, status: 'failed',
      } },
    });
  }
  const mandateId = currentPlan.gocardless_mandate_id || agreement?.gocardless_mandate_id;
  if (mandateId) {
    // Provider errors are unknown outcomes, not a cached/empty mandate.
    const mandate = await gc.getMandate(mandateId);
    if (!['pending_submission', 'submitted', 'active'].includes(mandate?.status)) {
      return refused('mandate_unusable', { mandateStatus: mandate?.status || null });
    }
  }

  let attemptNumber;
  if (mode === 'automatic') {
    attemptNumber = (Number.isInteger(currentPlan.auto_retry_attempts) ? currentPlan.auto_retry_attempts : 0) + 1;
  } else {
    const latest = await db.from('gocardless_payment_retry_attempts').select('attempt_number')
      .eq('tenant_id', tenantId).eq('plan_id', currentPlan.id).eq('gocardless_payment_id', paymentId)
      .eq('mode', 'manual').order('attempt_number', { ascending: false }).limit(1).maybeSingle();
    if (latest.error) throw new Error(`load prior manual retries failed: ${latest.error.message}`);
    attemptNumber = Number.isInteger(latest.data?.attempt_number) ? latest.data.attempt_number + 1 : 1;
  }
  const idempotencyKey = key(mode === 'automatic' ? 'dd-auto-retry' : 'dd-manual-retry',
    tenantId, currentPlan.id, paymentId, String(attemptNumber));
  const claimToken = key('dd-retry-claim', tenantId, currentPlan.id, paymentId, mode, String(attemptNumber));
  const priorAttempt = await db.from('gocardless_payment_retry_attempts').select('status')
    .eq('tenant_id', tenantId).eq('idempotency_key', idempotencyKey).maybeSingle();
  if (priorAttempt.error) throw new Error(`load prior retry attempt failed: ${priorAttempt.error.message}`);
  if (currentPlan.auto_retry_claimed_at) {
    if (String(currentPlan.auto_retry_claim_token || '').startsWith('cancel:')) return refused('cancellation_in_progress');
    const claimedAt = new Date(currentPlan.auto_retry_claimed_at).getTime();
    if (!(Number.isFinite(claimedAt) && claimedAt <= now.getTime() - 30 * 60_000)) return refused('retry_in_progress');
    await effects.perform({
      type: 'retry.release_stale_claim',
      description: 'Release stale retry claim using its existing token before attempting a new claim.',
      payload: { tenantId, planId: currentPlan.id, claimToken: currentPlan.auto_retry_claim_token,
        update: { auto_retry_claimed_at: null, auto_retry_claim_token: null, updated_at: now.toISOString() } },
    });
  }
  return effects.perform({
    type: 'retry.claim',
    description: priorAttempt.data?.status === 'requested'
      ? 'A requested attempt already exists. Attempt the normal exclusive claim to reconcile that duplicate; no new retry is inferred.'
      : 'Attempt exclusive retry claim. Only after winning it: reserve an idempotent attempt, read live payment and mandate, revalidate claim/policy, then retry the failed payment and update the retry ledger. None of that continuation is guaranteed.',
    conditional: true, amountMinor: payment?.amount_minor ?? currentPlan.amount_minor,
    currency: payment?.currency || currentPlan.currency, date: currentPlan.auto_retry_next_at || null,
    payload: { tenantId, currentPlan, paymentId, mode, actor, policy, mandateId: mandateId || null,
      attemptNumber, idempotencyKey, claimToken, now: now.toISOString(),
      update: { auto_retry_claimed_at: now.toISOString(), auto_retry_claim_token: claimToken,
        auto_retry_last_outcome: 'claimed', updated_at: now.toISOString() } },
  });
}

export async function runRetries({ db, plan, agreement, now, getGc, effects, trace }) {
  now = new Date(now);
  const finish = outcome => {
    if (typeof trace === 'function') trace({ stage: 'automatic-retries', status: outcome.ok ? 'completed' : 'skipped', reason: outcome.reason || 'requested' });
    return outcome;
  };
  if (!isRetryDue(plan, now)) return finish(refused('not_due'));
  if (!plan.auto_retry_payment_id) {
    await effects.perform({ type: 'retry.close_schedule', description: 'Close retry schedule because no payment is linked.',
      payload: { plan, reason: 'missing_payment' } });
    return finish(refused('missing_payment'));
  }
  if (agreement === undefined && plan.billing_agreement_id) {
    const loaded = await db.from('membership_billing_agreements').select('*')
      .eq('id', plan.billing_agreement_id).eq('tenant_id', plan.tenant_id).maybeSingle();
    if (loaded.error) throw new Error(`load agreement failed: ${loaded.error.message}`);
    agreement = loaded.data;
  }
  const gc = await getGc(plan.tenant_id);
  return finish(await runRetry({ db, plan, agreement, now, gc, effects }));
}