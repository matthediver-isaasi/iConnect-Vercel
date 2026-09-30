// No live clients: these are the actual reconciliation decisions used by cron
// and preview. Effect interpreters own all writes and lifecycle continuations.
import { isDryRunEffectBoundary } from './directDebitDryRunRuntime.js';

const checked = result => { if (result.error) throw new Error(result.error.message); return result.data; };
const cutoff = (now, days) => new Date(now.getTime() - days * 86400000).toISOString();
const perInstalment = agreement => (agreement?.metadata?.dd || agreement?.metadata?.card)?.invoicing_mode === 'per_instalment';
const emit = (ctx, stage, reason) => ctx.trace?.({ stage, status: 'skipped', reason });
const effect = (ctx, stage, type, description, payload, extra = {}) =>
  ctx.effects.perform({ stage, type, description, payload, ...extra });

// Apply the same database predicates to global batches and tenant/plan previews.
export function reconciliationSelection(db, stage, now) {
  switch (stage) {
    case 'stale-agreements': return db.from('membership_billing_agreements').select('*')
      .in('status', ['mandate_pending', 'payment_setup_required']).eq('needs_attention', false)
      .not('gocardless_billing_request_id', 'is', null).lt('updated_at', cutoff(now, 3));
    case 'missing-subscription': return db.from('membership_payment_plans').select('*')
      .is('gocardless_subscription_id', null).not('gocardless_mandate_id', 'is', null)
      .in('status', ['mandate_pending', 'first_payment_pending']).eq('needs_attention', false)
      .lt('updated_at', cutoff(now, 2));
    case 'subscription-drift': return db.from('membership_payment_plans').select('*')
      .not('gocardless_subscription_id', 'is', null)
      .in('status', ['first_payment_pending', 'active', 'payment_grace_period', 'payment_overdue'])
      .lt('updated_at', cutoff(now, 1));
    case 'pending-payments': return db.from('gocardless_payments').select('*')
      .in('status', ['pending_submission', 'submitted']).lt('updated_at', cutoff(now, 10));
    case 'confirmed-payments': return db.from('gocardless_payments').select('*')
      .in('status', ['confirmed', 'paid_out']).lt('updated_at', cutoff(now, 15 / 1440));
    case 'accounting-retry': return db.from('gocardless_payments').select('*')
      .or(`accounting_sync_status.in.(failed,invoice_unpaid),and(accounting_sync_status.eq.posting,updated_at.lt.${cutoff(now, 15 / 1440)})`)
      .in('status', ['confirmed', 'paid_out']);
    default: throw new Error(`Unknown reconciliation selection ${stage}`);
  }
}

const update = (ctx, stage, table, row, values, filters = []) => effect(ctx, stage, 'reconciliation.update',
  `Update ${table} (${row.id}): ${Object.keys(values).join(', ')}`,
  { table, values, filters: [['id', row.id], ['tenant_id', row.tenant_id], ...filters] });
const transition = (ctx, stage, entityType, row, toStatus, reason) =>
  effect(ctx, stage, 'reconciliation.transition', `Change ${entityType} status to ${toStatus}`,
    { entityType, entityId: row.id, toStatus, reason, source: 'reconciliation' });
const replay = (ctx, stage, event) => effect(ctx, stage, 'reconciliation.replay',
  `Replay ${event.resource_type} ${event.action}; membership, accounting and collection follow-ons depend on lifecycle processing`,
  { event, tenantId: ctx.tenantId }, { conditional: true });

export async function reconcileAgreement(ctx, agreement) {
  const stage = 'stale-agreements';
  if (agreement.status === 'payment_setup_required' && new Date(agreement.updated_at) > new Date(cutoff(ctx.now, 7))) {
    emit(ctx, stage, 'Payment setup required has not reached its seven-day window'); return { skipped: 1 };
  }
  const gc = await ctx.getGc(agreement.tenant_id);
  const br = await gc.getBillingRequest(agreement.gocardless_billing_request_id);
  if (!br?.status) throw new Error('Provider billing request returned no status');
  const mandateId = br.links?.mandate_request_mandate;
  if (br.status === 'fulfilled' && mandateId) {
    const mandate = await gc.getMandate(mandateId);
    if (!mandate?.status) throw new Error('Provider mandate returned no status');
    if (['active', 'reinstated'].includes(mandate.status)) {
      const outcome = await replay({ ...ctx, tenantId: agreement.tenant_id }, stage, {
        id: `reconcile:billing-request:${agreement.gocardless_billing_request_id}`,
        resource_type: 'billing_requests', action: 'fulfilled',
        links: { billing_request: agreement.gocardless_billing_request_id, mandate_request_mandate: mandateId,
          customer: br.links?.customer || agreement.gocardless_customer_id || null,
          payment_request_payment: br.links?.payment_request_payment || null },
      });
      if (!outcome.handled || outcome.retryable) throw new Error(outcome.detail || 'fulfilled billing request reconciliation was not handled');
      return { repaired: 1 };
    }
    const customerId = br.links?.customer;
    if (agreement.gocardless_mandate_id && agreement.gocardless_mandate_id !== mandateId) throw new Error('reconciliation mandate conflicts with existing agreement identity');
    if (customerId && agreement.gocardless_customer_id && agreement.gocardless_customer_id !== customerId) throw new Error('reconciliation customer conflicts with existing agreement identity');
    const values = {
      ...(!agreement.gocardless_mandate_id ? { gocardless_mandate_id: mandateId } : {}),
      ...(!agreement.gocardless_customer_id && customerId ? { gocardless_customer_id: customerId } : {}),
    };
    if (!Object.keys(values).length) { emit(ctx, stage, 'Pending mandate identity already attached'); return { skipped: 1 }; }
    await update(ctx, stage, 'membership_billing_agreements', agreement, { ...values, updated_at: ctx.now.toISOString() });
    return { repaired: 1 };
  }
  if (['cancelled', 'failed'].includes(br.status)) {
    const result = await transition(ctx, stage, 'billing_agreement', agreement, 'payment_setup_required', `reconciliation: billing request ${br.status}`);
    return result.applied ? { repaired: 1 } : { skipped: 1 };
  }
  await update(ctx, stage, 'membership_billing_agreements', agreement, { needs_attention: true,
    attention_reason: `Billing request ${agreement.gocardless_billing_request_id} still '${br.status}' after 3+ days`, updated_at: ctx.now.toISOString() });
  return { flagged: 1 };
}

export async function reconcileMissingSubscription(ctx, plan) {
  const stage = 'missing-subscription';
  if (plan.metadata?.collection_mode === 'dynamic') { emit(ctx, stage, 'Dynamic plans deliberately have no subscription'); return { skipped: 1 }; }
  const mandate = await (await ctx.getGc(plan.tenant_id)).getMandate(plan.gocardless_mandate_id);
  if (!mandate?.status) throw new Error('Provider mandate returned no status');
  if (mandate.status === 'active') {
    await update(ctx, stage, 'membership_payment_plans', plan, { needs_attention: true,
      attention_reason: `Mandate ${plan.gocardless_mandate_id} active but no subscription created after 2+ days`, updated_at: ctx.now.toISOString() });
    return { flagged: 1 };
  }
  if (['cancelled', 'failed', 'expired'].includes(mandate.status)) {
    const result = await transition(ctx, stage, 'payment_plan', plan, 'payment_plan_cancelled', `reconciliation: mandate ${mandate.status}`);
    return result.applied ? { repaired: 1 } : { skipped: 1 };
  }
  emit(ctx, stage, `Mandate remains ${mandate.status}`); return { skipped: 1 };
}

export async function reconcileSubscription(ctx, plan) {
  const stage = 'subscription-drift';
  const remote = await (await ctx.getGc(plan.tenant_id)).getSubscription(plan.gocardless_subscription_id);
  if (!remote?.status) throw new Error('Provider subscription returned no status');
  if (['cancelled', 'finished'].includes(remote.status)) {
    const result = await transition(ctx, stage, 'payment_plan', plan,
      remote.status === 'finished' ? 'expired' : 'payment_plan_cancelled',
      remote.status === 'finished' ? 'reconciliation: subscription finished' : 'reconciliation: subscription cancelled remotely');
    return result.applied ? { repaired: 1 } : { skipped: 1 };
  }
  emit(ctx, stage, `Subscription is ${remote.status}; no terminal drift`); return { skipped: 1 };
}

async function paymentAgreement(db, payment) {
  if (!payment.plan_id) return {};
  const plan = checked(await db.from('membership_payment_plans').select('*')
    .eq('id', payment.plan_id).eq('tenant_id', payment.tenant_id).maybeSingle());
  if (!plan?.billing_agreement_id) return {};
  const agreement = checked(await db.from('membership_billing_agreements').select('*')
    .eq('id', plan.billing_agreement_id).eq('tenant_id', payment.tenant_id).maybeSingle());
  return { plan, agreement };
}

async function unfinished(payment, db) {
  const { plan, agreement } = await paymentAgreement(db, payment);
  if (agreement?.metadata?.dd?.kind !== 'monthly_direct_debit') return false;
  if ([plan.status, agreement.status].some(status => ['expired', 'payment_plan_cancelled'].includes(status))) return false;
  if ([plan.status, agreement.status].some(status => ['mandate_pending', 'first_payment_pending'].includes(status))
    || (agreement.metadata.gocardless_initial_payment?.id === payment.gocardless_payment_id
      && !agreement.metadata.gocardless_initial_payment.finalized_at)) return true;
  const table = agreement.member_id ? 'member_membership_history' : agreement.organization_id ? 'organisation_membership_history' : null;
  if (table) {
    const history = checked(await db.from(table).select('status, payment_status')
      .eq('billing_agreement_id', agreement.id).eq('tenant_id', payment.tenant_id).maybeSingle());
    if (history && ((agreement.metadata.dd.activation_rule !== 'manual' && history.status !== 'active')
      || !['partial', 'paid'].includes(history.payment_status))) return true;
  }
  return perInstalment(agreement) && !payment.accounting_sync_status;
}

export const markReconciliationFresh = (ctx, payment) => update(ctx, 'stale-payments', 'gocardless_payments', payment,
  { updated_at: ctx.now.toISOString() }, [['status', payment.status], ['updated_at', payment.updated_at]]);

export async function reconcilePayment(ctx, payment) {
  const stage = 'stale-payments';
  const remote = await (await ctx.getGc(payment.tenant_id)).getPayment(payment.gocardless_payment_id);
  if (!remote?.status) throw new Error('Provider payment returned no status');
  const unchangedConfirmed = ['confirmed', 'paid_out'].includes(payment.status) && remote.status === payment.status;
  if ((unchangedConfirmed && !(await unfinished(payment, ctx.db)))
    || (!unchangedConfirmed && remote.status === payment.status)) {
    emit(ctx, stage, 'Provider state unchanged and no unfinished confirmation obligations');
    await markReconciliationFresh(ctx, payment); return { skipped: 1 };
  }
  const action = unchangedConfirmed && remote.status === 'paid_out' ? 'confirmed'
    : remote.status === 'pending_submission' ? 'created' : remote.status;
  if (['created', 'submitted', 'confirmed', 'paid_out', 'failed', 'cancelled', 'charged_back'].includes(action)) {
    const outcome = await replay({ ...ctx, tenantId: payment.tenant_id }, stage, {
      id: `reconcile:payment:${payment.gocardless_payment_id}:${action}`, resource_type: 'payments', action,
      links: { payment: payment.gocardless_payment_id,
        subscription: remote.links?.subscription || payment.gocardless_subscription_id || null,
        mandate: remote.links?.mandate || payment.gocardless_mandate_id || null,
        payout: remote.links?.payout || payment.gocardless_payout_id || null },
    });
    if (!outcome.handled || outcome.retryable) throw new Error(outcome.detail || `payment ${action} reconciliation was not handled`);
  } else await update(ctx, stage, 'gocardless_payments', payment, { status: remote.status, updated_at: ctx.now.toISOString() });
  await markReconciliationFresh(ctx, payment);
  return { repaired: 1 };
}

export async function reconcileAccounting(ctx, payment) {
  const stage = 'accounting-retry';
  const { agreement } = await paymentAgreement(ctx.db, payment);
  if (!agreement || !perInstalment(agreement)) { emit(ctx, stage, 'Only linked per-instalment agreements are retried; annual application is excluded'); return { skipped: 1 }; }
  const outcome = await effect(ctx, stage, 'reconciliation.accounting',
    'Claim/reclaim per-instalment posting, then resume idempotent invoice and payment posting',
    { agreement, paymentRow: payment, reclaimStale: true },
    { amountMinor: payment.amount_minor, currency: payment.currency, date: payment.charge_date, conditional: true });
  return outcome.status === 'posted' ? { repaired: 1 } : { skipped: 1 };
}

export const reconciliationStages = [
  { id: 'stale-agreements', run: reconcileAgreement, selectors: ['stale-agreements'], scope: 'agreement',
    gate: 'Requires mandate_pending/payment_setup_required, needs_attention=false, a billing request, and updated_at older than three days (seven for payment setup)' },
  { id: 'missing-subscription', run: reconcileMissingSubscription, selectors: ['missing-subscription'], scope: 'plan',
    gate: 'Requires no subscription, a mandate, mandate_pending/first_payment_pending, needs_attention=false, and updated_at older than two days' },
  { id: 'subscription-drift', run: reconcileSubscription, selectors: ['subscription-drift'], scope: 'plan',
    gate: 'Requires a subscription, first_payment_pending/active/payment_grace_period/payment_overdue, and updated_at older than one day' },
  { id: 'stale-payments', run: reconcilePayment, selectors: ['pending-payments', 'confirmed-payments'], scope: 'payment',
    gate: 'Requires pending/submitted payment older than ten days, or confirmed/paid_out payment older than fifteen minutes' },
  { id: 'accounting-retry', run: reconcileAccounting, selectors: ['accounting-retry'], scope: 'payment',
    gate: 'Requires confirmed/paid_out payment with failed/invoice_unpaid posting, or a posting claim older than fifteen minutes' },
];

export async function runReconciliationStage(ctx, stage) {
  let count = 0;
  for (const selector of stage.selectors) {
    let query = reconciliationSelection(ctx.db, selector, ctx.now).eq('tenant_id', ctx.plan.tenant_id);
    query = stage.scope === 'agreement' ? query.eq('id', ctx.agreement.id)
      : stage.scope === 'plan' ? query.eq('id', ctx.plan.id) : query.eq('plan_id', ctx.plan.id);
    const rows = checked(await query.order('updated_at', { ascending: true }).limit(100));
    for (const row of rows || []) { count++; await stage.run(ctx, row); }
  }
  if (!count) emit(ctx, stage.id, `Not selected. ${stage.gate}`);
}

export async function runReconciliation(ctx) {
  for (const stage of reconciliationStages) {
    try { await runReconciliationStage(ctx, stage); }
    catch (error) {
      if (isDryRunEffectBoundary(error)) {
        ctx.trace?.({ stage: stage.id, status: 'conditional',
          reason: 'Stopped before effect; follow-on work depends on its real result.',
          operations: [{ ...error.operation, conditional: true }] });
      } else ctx.trace?.({ stage: stage.id, status: 'error', reason: error.message });
    }
  }
}