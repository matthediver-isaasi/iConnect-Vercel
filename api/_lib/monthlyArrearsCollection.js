// Provider-neutral monthly post-grace debt contract.  Access/escalation is
// intentionally not considered here: dd_arrears_policy remains authoritative.
import { randomUUID } from 'node:crypto';
export const MONTHLY_POST_GRACE_COLLECTION_POLICIES = Object.freeze([
  'stop_collecting', 'continue_catch_up',
]);

export function resolveMonthlyPostGraceCollectionPolicy(value) {
  return MONTHLY_POST_GRACE_COLLECTION_POLICIES.includes(value) ? value : 'stop_collecting';
}

export function collectionPolicyForAgreement(agreement) {
  const terms = agreement?.metadata?.dd || agreement?.metadata?.card || {};
  return resolveMonthlyPostGraceCollectionPolicy(terms.monthly_post_grace_collection_policy);
}

export function projectNextCollection({ monthlyAmountMinor, openPeriods = [], nextDate = null, policy }) {
  const openAmountMinor = openPeriods.reduce((total, period) => total + (Number(period.amount_minor) || 0), 0);
  const stopped = resolveMonthlyPostGraceCollectionPolicy(policy) === 'stop_collecting';
  return {
    arrearsCount: openPeriods.length,
    arrearsAmountMinor: openAmountMinor,
    nextCollectionAmountMinor: stopped ? null : (Number(monthlyAmountMinor) || 0) + openAmountMinor,
    nextCollectionDate: stopped ? null : nextDate,
    collectionStopped: stopped,
  };
}

// Allocation is exact and oldest-first. Partial money is intentionally left
// unallocated: monthly periods are indivisible for instalment accounting.
export function allocateOldestFirst({ amountMinor, openPeriods = [] }) {
  let remaining = Number(amountMinor) || 0;
  const settled = [];
  for (const period of [...openPeriods].sort((a, b) => String(a.due_period).localeCompare(String(b.due_period)))) {
    const amount = Number(period.amount_minor) || 0;
    if (amount > 0 && remaining >= amount) {
      settled.push(period);
      remaining -= amount;
    }
  }
  return { settled, settledAmountMinor: (Number(amountMinor) || 0) - remaining, remainingAmountMinor: remaining };
}

// Renewal and completion callers use this fail-closed guard: an unavailable
// ledger is not permission to start a new membership year.
export async function assertNoOpenMonthlyArrears({ tenantId, planId, db }) {
  const { count, error } = await db.from('membership_monthly_arrears_period')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId).eq('plan_id', planId).is('settled_at', null);
  if (error) throw new Error(`open monthly arrears check failed: ${error.message}`);
  if ((count || 0) > 0) throw new Error('unresolved monthly arrears block renewal');
  return true;
}

/**
 * Durable per-period accounting fan-out for a confirmed catch-up collection.
 * `postPeriod` is rail-specific and must use the supplied deterministic
 * external reference. A posted row is never sent again; failed rows are
 * reclaimed on webhook/reconciliation replay.
 */
export async function postSettledArrearsPeriods({
  tenantId, planId, providerReference, agreement, db, postPeriod,
}) {
  const terms = agreement?.metadata?.dd || agreement?.metadata?.card || {};
  if (terms.invoicing_mode !== 'per_instalment') return { skipped: 'annual', posted: 0 };
  const { data: periods, error } = await db.from('membership_monthly_arrears_period')
    .select('*').eq('tenant_id', tenantId).eq('plan_id', planId)
    .eq('settlement_reference', providerReference).not('settled_at', 'is', null);
  if (error) throw new Error(`load settled arrears accounting periods failed: ${error.message}`);
  let posted = 0;
  for (const period of periods || []) {
    const { data: row, error: claimError } = await db.from('membership_monthly_arrears_accounting')
      .upsert({
        tenant_id: tenantId, plan_id: planId, arrears_period_id: period.id,
        provider_payment_reference: providerReference, amount_minor: period.amount_minor,
      }, { onConflict: 'tenant_id,arrears_period_id,provider_payment_reference' }).select().maybeSingle();
    if (claimError) throw new Error(`claim arrears accounting row failed: ${claimError.message}`);
    if (row?.accounting_status === 'posted') continue;
    const { data: claimed, error: accountingClaimError } = await db
      .from('membership_monthly_arrears_accounting')
      .update({ accounting_status: 'posting', updated_at: new Date().toISOString() })
      .eq('id', row.id).in('accounting_status', ['pending', 'failed'])
      .select('*').maybeSingle();
    if (accountingClaimError) throw new Error(`claim arrears accounting posting failed: ${accountingClaimError.message}`);
    if (!claimed) continue;
    try {
      const outcome = await postPeriod({
        period,
        amountMinor: period.amount_minor,
        externalReference: `${providerReference}:arrears:${period.id}`,
      });
      const { error: postedError } = await db.from('membership_monthly_arrears_accounting')
        .update({ accounting_status: 'posted', accounting_invoice_id: outcome?.invoiceId || null, updated_at: new Date().toISOString() })
        .eq('id', claimed.id);
      if (postedError) throw postedError;
      posted++;
    } catch (err) {
      await db.from('membership_monthly_arrears_accounting')
        .update({ accounting_status: 'failed', updated_at: new Date().toISOString() }).eq('id', claimed.id);
      throw err;
    }
  }
  return { posted };
}

export async function completeMonthlyCollectionIntent({ plan, intent: immutableIntent, providerReference, status = 'completed', db }) {
  const intent = immutableIntent;
  if (!plan?.id || !plan?.tenant_id || !intent) throw new Error('plan and immutable collection intent are required');
  if (intent.tenant_id !== plan.tenant_id || intent.plan_id !== plan.id || intent.provider_reference !== providerReference) {
    throw new Error('immutable collection intent does not match tenant, plan, or provider reference');
  }
  const intentKey = intent.intent_key;
  if (!intentKey) throw new Error('immutable collection intent key is required');
  const { data: transitioned, error } = await db.from('membership_monthly_collection_intent').update({
    status, updated_at: new Date().toISOString(),
  }).eq('tenant_id', plan.tenant_id).eq('plan_id', plan.id)
    .eq('intent_key', intentKey).eq('provider_reference', providerReference)
    .in('status', ['created', 'completed']);
  if (error && !['42P01', '42703'].includes(error.code)) throw new Error(`complete collection intent failed: ${error.message}`);
  const { data: currentPlan, error: loadError } = await db.from('membership_payment_plans')
    .select('id, tenant_id, metadata').eq('id', plan.id).eq('tenant_id', plan.tenant_id).maybeSingle();
  if (loadError) throw new Error(`load current collection intent pointer failed: ${loadError.message}`);
  const pointer = currentPlan?.metadata?.catch_up_intent;
  if ((pointer?.intent_key || pointer?.key) === intentKey && pointer?.provider_reference === providerReference) {
    const { error: pointerError } = await db.from('membership_payment_plans').update({
      metadata: { ...(currentPlan.metadata || {}), catch_up_intent: { ...pointer, status } },
      updated_at: new Date().toISOString(),
    }).eq('id', plan.id).eq('tenant_id', plan.tenant_id)
      // This is the authoritative race guard. A newer pointer written after
      // the read makes this UPDATE affect zero rows and is never overwritten.
      .filter('metadata->catch_up_intent->>key', 'eq', intentKey)
      .filter('metadata->catch_up_intent->>provider_reference', 'eq', providerReference);
    if (pointerError) throw new Error(`complete current collection intent pointer failed: ${pointerError.message}`);
  }
  return { updated: !error };
}

export async function failMonthlyCollectionIntent({
  plan, intent, providerReference, providerOutcome = 'failed', errorMessage = null, db,
}) {
  if (!plan?.id || !plan?.tenant_id || !intent?.intent_key
    || intent.tenant_id !== plan.tenant_id || intent.plan_id !== plan.id
    || intent.provider_reference !== providerReference) {
    throw new Error('immutable collection intent does not match failure tenant, plan, or provider reference');
  }
  const { data: transitioned, error } = await db.from('membership_monthly_collection_intent').update({
    status: 'failed', last_error: String(errorMessage || providerOutcome).slice(0, 500),
    provider_outcome: providerOutcome, lease_owner: null, lease_expires_at: null,
    updated_at: new Date().toISOString(),
  }).eq('tenant_id', plan.tenant_id).eq('plan_id', plan.id)
    .eq('intent_key', intent.intent_key).eq('provider_reference', providerReference)
    .eq('status', 'created').select('id').maybeSingle();
  if (error) throw new Error(`fail collection intent failed: ${error.message}`);
  if (!transitioned) return { updated: false };
  const pointer = plan.metadata?.catch_up_intent;
  if ((pointer?.key || pointer?.intent_key) === intent.intent_key && pointer?.provider_reference === providerReference) {
    const { error: pointerError } = await db.from('membership_payment_plans').update({
      metadata: { ...(plan.metadata || {}), catch_up_intent: {
        ...pointer, status: 'failed', provider_outcome: providerOutcome,
        last_error: String(errorMessage || providerOutcome).slice(0, 500),
      } }, updated_at: new Date().toISOString(),
    }).eq('id', plan.id).eq('tenant_id', plan.tenant_id)
      .filter('metadata->catch_up_intent->>key', 'eq', intent.intent_key)
      .filter('metadata->catch_up_intent->>provider_reference', 'eq', providerReference);
    if (pointerError) throw new Error(`fail current collection intent pointer failed: ${pointerError.message}`);
  }
  return { updated: true };
}

export async function accrueFailedMonthlyPeriod({ tenantId, plan, duePeriod, paymentReference = null, db }) {
  if (!tenantId || !plan?.id || !duePeriod) throw new Error('tenantId, plan and duePeriod are required');
  // Existing deployments and lightweight webhook fakes may predate the
  // ledger. Do not break a payment webhook there; production RPC failures
  // remain hard failures.
  if (typeof db?.rpc !== 'function') return { created: false, skipped: 'ledger-unavailable' };
  const { data, error } = await db.rpc('accrue_membership_monthly_arrears_period', {
    p_tenant_id: tenantId, p_plan_id: plan.id, p_due_period: duePeriod,
    p_amount_minor: plan.amount_minor, p_currency: plan.currency, p_payment_reference: paymentReference,
  });
  if (error?.code === '42883' || error?.code === '42P01') return { created: false, skipped: 'ledger-unavailable' };
  if (error) throw new Error(`accrue monthly arrears period failed: ${error.message}`);
  return Array.isArray(data) ? data[0] : data;
}

export async function settleMonthlyArrears({ tenantId, planId, amountMinor, settlementReference, periodIds = null, db }) {
  if (typeof db?.rpc !== 'function') return { settled_count: 0, settled_amount_minor: 0, skipped: 'ledger-unavailable' };
  const { data, error } = await db.rpc('settle_membership_monthly_arrears', {
    p_tenant_id: tenantId, p_plan_id: planId, p_amount_minor: amountMinor,
    p_settlement_reference: settlementReference, p_period_ids: periodIds,
  });
  if (error?.code === '42883' || error?.code === '42P01') return { settled_count: 0, settled_amount_minor: 0, skipped: 'ledger-unavailable' };
  if (error) throw new Error(`settle monthly arrears failed: ${error.message}`);
  return Array.isArray(data) ? data[0] : data;
}

/**
 * Fence and create one provider collection intent. The caller supplies only a
 * tenant-bound provider client; no platform credentials are ever used here.
 * `metadata.catch_up_intent` is durable before the remote call, while its
 * deterministic key makes a crash/reconcile retry safe at the provider too.
 */
export async function executePostGraceCollection({ plan, agreement, db, gc = null, stripe = null }) {
  const policy = collectionPolicyForAgreement(agreement);
  if (!plan?.id || !plan.tenant_id) throw new Error('tenant-bound plan required');
  const { data: periods, error } = await db.from('membership_monthly_arrears_period')
    .select('*').eq('tenant_id', plan.tenant_id).eq('plan_id', plan.id).is('settled_at', null)
    .order('due_period', { ascending: true });
  if (error) throw new Error(`load open arrears periods failed: ${error.message}`);
  const projection = projectNextCollection({
    monthlyAmountMinor: plan.amount_minor, openPeriods: periods || [], nextDate: plan.next_charge_date, policy,
  });
  let intentKey = `monthly-catch-up:${plan.id}:${(periods || []).map((p) => p.id).join(',')}`;
  const existing = plan.metadata?.catch_up_intent;
  if ((existing?.key === intentKey || existing?.key?.startsWith(`${intentKey}:retry:`))
    && existing.provider_reference && existing.status === 'created') {
    return { created: false, intent: existing, projection };
  }
  if ((existing?.key === intentKey || existing?.key?.startsWith(`${intentKey}:retry:`))
    && existing.provider_reference && existing.status === 'failed') {
    intentKey = `${intentKey}:retry:${(Number(existing.retry_generation) || 0) + 1}`;
  }
  if (policy === 'stop_collecting') {
    const stopKey = `monthly-stop:${plan.id}`;
    const leaseOwner = randomUUID();
    const { data: stopRows, error: stopClaimError } = await db.rpc('claim_membership_monthly_collection_intent', {
      p_tenant_id: plan.tenant_id, p_plan_id: plan.id, p_intent_key: stopKey, p_policy: policy,
      p_period_ids: [], p_arrears_amount_minor: 0, p_planned_amount_minor: null, p_lease_owner: leaseOwner,
    });
    if (stopClaimError) throw new Error(`claim stopped collection failed: ${stopClaimError.message}`);
    const stopClaim = Array.isArray(stopRows) ? stopRows[0] : stopRows;
    if (!stopClaim) return { created: false, skipped: 'already-claimed', projection };
    try {
    const { data: currentPlan, error: revalidateError } = await db.from('membership_payment_plans')
      .select('*').eq('id', plan.id).eq('tenant_id', plan.tenant_id).maybeSingle();
    if (revalidateError) throw new Error(`revalidate stopped collection failed: ${revalidateError.message}`);
    if (!currentPlan) throw new Error('tenant-owned plan disappeared after stop claim');
    if (currentPlan.collection_stopped_at || ['cancelled', 'expired'].includes(currentPlan.status)) {
      const { error: terminalError } = await db.from('membership_monthly_collection_intent').update({
        status: 'manual_resolution', lease_owner: null, lease_expires_at: null,
        last_error: null, updated_at: new Date().toISOString(),
      }).eq('id', stopClaim.id).eq('lease_owner', leaseOwner);
      if (terminalError) throw new Error(`terminalize stopped collection intent failed: ${terminalError.message}`);
      const pointer = currentPlan.metadata?.catch_up_intent;
      if ((pointer?.key || pointer?.intent_key) === stopKey) {
        const { error: pointerError } = await db.from('membership_payment_plans').update({
          metadata: { ...(currentPlan.metadata || {}), catch_up_intent: { ...pointer, status: 'manual_resolution' } },
          updated_at: new Date().toISOString(),
        }).eq('id', plan.id).eq('tenant_id', plan.tenant_id)
          .filter('metadata->catch_up_intent->>key', 'eq', stopKey);
        if (pointerError) throw new Error(`sync stopped collection pointer failed: ${pointerError.message}`);
      }
      return { created: false, stopped: true, idempotent: true, projection };
    }
    // Provider cancellation is revalidated at execution time. A remotely
    // cancelled subscription is harmless; any other non-active state refuses
    // to mutate a potentially revived plan.
    if (plan.provider === 'stripe' && stripe && plan.stripe_subscription_id) {
      const sub = await stripe.subscriptions.retrieve(plan.stripe_subscription_id);
      if (['active', 'past_due', 'unpaid'].includes(sub?.status)) {
        await stripe.subscriptions.cancel(plan.stripe_subscription_id);
      } else if (sub?.status !== 'canceled') {
        throw new Error(`Stripe subscription is ${sub?.status}; stop refused`);
      }
    }
    if (plan.provider !== 'stripe' && gc && plan.gocardless_subscription_id) {
      const sub = await gc.getSubscription(plan.gocardless_subscription_id);
      if (sub?.status === 'active') await gc.cancelSubscription(plan.gocardless_subscription_id);
      else if (sub?.status !== 'cancelled') throw new Error(`GoCardless subscription is ${sub?.status}; stop refused`);
    }
    const { error: stopError } = await db.from('membership_payment_plans').update({
      collection_stopped_at: new Date().toISOString(), collection_stop_reason: 'post_grace_stop_collecting',
      metadata: { ...(currentPlan.metadata || {}), catch_up_intent: { key: stopKey, status: 'manual_resolution' } },
    }).eq('id', plan.id).eq('tenant_id', plan.tenant_id).is('collection_stopped_at', null);
    if (stopError) throw new Error(`persist stopped collection failed: ${stopError.message}`);
    await db.from('membership_monthly_collection_intent').update({
      status: 'manual_resolution', lease_owner: null, lease_expires_at: null, updated_at: new Date().toISOString(),
    }).eq('id', stopClaim.id).eq('lease_owner', leaseOwner);
    return { created: false, stopped: true, projection };
    } catch (stopError) {
      await db.from('membership_monthly_collection_intent').update({
        status: 'failed', last_error: String(stopError.message || stopError).slice(0, 500),
        lease_owner: null, lease_expires_at: null, updated_at: new Date().toISOString(),
      }).eq('id', stopClaim.id).eq('lease_owner', leaseOwner);
      throw stopError;
    }
  }
  if (plan.collection_stopped_at || ['cancelled', 'expired'].includes(plan.status)) {
    return { created: false, skipped: 'plan-not-collectible', projection };
  }
  if (!projection.arrearsAmountMinor) return { created: false, skipped: 'no-open-arrears', projection };
  const intent = {
    key: intentKey, status: 'creating', retry_generation: Number(existing?.retry_generation || 0) + (intentKey.includes(':retry:') ? 1 : 0),
    amount_minor: projection.nextCollectionAmountMinor,
    arrears_amount_minor: projection.arrearsAmountMinor,
    period_ids: (periods || []).map((period) => period.id), created_at: new Date().toISOString(),
  };
  const leaseOwner = randomUUID();
  const { data: claimedRows, error: claimError } = await db.rpc('claim_membership_monthly_collection_intent', {
    p_tenant_id: plan.tenant_id, p_plan_id: plan.id, p_intent_key: intentKey, p_policy: policy,
    p_period_ids: intent.period_ids, p_arrears_amount_minor: intent.arrears_amount_minor,
    p_planned_amount_minor: projection.nextCollectionAmountMinor, p_lease_owner: leaseOwner,
  });
  if (claimError) throw new Error(`claim catch-up intent failed: ${claimError.message}`);
  const intentRow = Array.isArray(claimedRows) ? claimedRows[0] : claimedRows;
  if (!intentRow) return { created: false, skipped: 'already-claimed', projection };
  const { data: claimed, error: pointerError } = await db.from('membership_payment_plans').update({
    metadata: { ...(plan.metadata || {}), catch_up_intent: intent, catch_up_intent_id: intentRow?.id },
    updated_at: new Date().toISOString(),
  }).eq('id', plan.id).eq('tenant_id', plan.tenant_id).is('collection_stopped_at', null).select('*').maybeSingle();
  if (pointerError) throw new Error(`persist catch-up intent pointer failed: ${pointerError.message}`);
  if (!claimed) return { created: false, skipped: 'plan-not-collectible', projection };

  let reference;
  let providerChargeDate = null;
  try {
  // Revalidate local cancellation after obtaining the lease.
  const { data: currentPlan, error: currentPlanError } = await db.from('membership_payment_plans')
    .select('*').eq('id', plan.id).eq('tenant_id', plan.tenant_id).maybeSingle();
  if (currentPlanError) throw new Error(`revalidate collection plan failed: ${currentPlanError.message}`);
  if (!currentPlan || currentPlan.collection_stopped_at || ['cancelled', 'expired'].includes(currentPlan.status)) {
    throw new Error('plan became non-collectible after intent claim');
  }
  if (plan.provider === 'stripe') {
    if (!stripe || !plan.stripe_subscription_id) throw new Error('Stripe client and subscription required');
    const sub = await stripe.subscriptions.retrieve(plan.stripe_subscription_id);
    if (!['active', 'past_due'].includes(sub?.status)) throw new Error(`Stripe subscription is ${sub?.status}; catch-up refused`);
    const item = await stripe.invoiceItems.create({
      // The normal subscription invoice already contains the current month.
      customer: sub.customer, subscription: plan.stripe_subscription_id, amount: projection.arrearsAmountMinor,
      currency: plan.currency.toLowerCase(), description: 'Membership arrears catch-up',
      metadata: { membership_plan_id: plan.id, catch_up_intent_key: intentKey },
    }, { idempotencyKey: intentKey });
    reference = item.id;
  } else {
    if (!gc || !plan.gocardless_mandate_id) throw new Error('GoCardless client and mandate required');
    if (plan.gocardless_subscription_id) {
      const sub = await gc.getSubscription(plan.gocardless_subscription_id);
      if (sub?.status !== 'active') throw new Error(`GoCardless subscription is ${sub?.status}; catch-up refused`);
    }
    const payment = await gc.createPayment({
      // Keep the fixed subscription: it supplies the current instalment.
      mandateId: plan.gocardless_mandate_id, amountMinor: projection.arrearsAmountMinor, currency: plan.currency,
      description: 'Membership arrears catch-up',
      metadata: {
        membership_plan_id: plan.id, tenant_id: plan.tenant_id, plan_id: plan.id,
        catch_up_intent_key: intentKey,
        arrears_amount_minor: String(projection.arrearsAmountMinor),
        arrears_period_ids: intent.period_ids.join(','),
      },
      idempotencyKey: intentKey,
    });
    reference = payment.id;
    providerChargeDate = payment.charge_date || null;
  }
  } catch (providerError) {
    await db.from('membership_monthly_collection_intent').update({
      status: 'failed', last_error: String(providerError.message || providerError).slice(0, 500),
      lease_owner: null, lease_expires_at: null, updated_at: new Date().toISOString(),
    }).eq('id', intentRow.id).eq('lease_owner', leaseOwner);
    throw providerError;
  }
  // This is deliberately outside provider-error handling: a provider success
  // plus local persistence outage remains a recoverable creating lease, so a
  // stale reclaim replays the same provider idempotency key rather than
  // creating a replacement charge/item.
  const { error: persistError } = await db.rpc('record_membership_monthly_collection_provider_ref', {
    p_tenant_id: plan.tenant_id, p_plan_id: plan.id, p_intent_key: intentKey,
    p_lease_owner: leaseOwner, p_provider_reference: reference,
    p_provider_charge_date: providerChargeDate,
  });
  if (persistError) throw new Error(`record catch-up provider reference failed: ${persistError.message}`);
  return { created: true, intent: { ...intent, provider_reference: reference, provider_charge_date: providerChargeDate }, projection };
}