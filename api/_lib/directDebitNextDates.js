import { readConsoleRows } from './directDebitConsoleEligibility.js';

const pending = ['pending_submission', 'submitted'];
const stopped = new Set(['cancelled', 'payment_plan_cancelled', 'completed', 'paused', 'expired', 'failed']);
const dateOnly = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

// Console presentation only. A cadence date is not evidence of a bank debit.
export function directDebitNextDates(plan, payments = [], today = new Date().toISOString().slice(0, 10)) {
  if (plan.metadata?.collection_mode !== 'dynamic') {
    return { dynamic: false, nextDueDate: plan.next_charge_date || null,
      bankScheduledDate: null, nextChargeDate: plan.next_charge_date || null, status: 'legacy' };
  }
  const inactive = stopped.has(plan.status) || !!plan.completed_at;
  const nextDueDate = inactive ? null : dateOnly(plan.dynamic_next_collection_date);
  const payment = inactive ? null : payments.filter(row =>
    row.tenant_id === plan.tenant_id && row.plan_id === plan.id
    && row.gocardless_payment_id && pending.includes(row.status)
    && row.environment === plan.environment
    && plan.gocardless_mandate_id && row.gocardless_mandate_id === plan.gocardless_mandate_id
    && (!row.billing_agreement_id || row.billing_agreement_id === plan.billing_agreement_id)
    && (!plan.gocardless_subscription_id || row.gocardless_subscription_id === plan.gocardless_subscription_id)
    && dateOnly(row.charge_date) && row.charge_date >= today
  ).sort((a, b) => a.charge_date.localeCompare(b.charge_date))[0];
  const bankScheduledDate = payment?.charge_date || null;
  return { dynamic: true, nextDueDate, bankScheduledDate, nextChargeDate: bankScheduledDate,
    status: inactive ? 'inactive' : bankScheduledDate ? 'provider_scheduled' : 'not_yet_scheduled' };
}

// Called after visibility/filtering/paging. Only canonical in-flight payment
// mirrors, in bounded tenant-scoped batches; no reservations or provider GETs.
export async function loadDirectDebitNextDates(db, tenantId, plans) {
  const dynamic = plans.filter(p => p.tenant_id === tenantId && p.metadata?.collection_mode === 'dynamic');
  const byPlan = new Map();
  for (let offset = 0; offset < dynamic.length; offset += 100) {
    const ids = dynamic.slice(offset, offset + 100).map(p => p.id);
    const payments = await readConsoleRows(() => db.from('gocardless_payments').select('*')
      .eq('tenant_id', tenantId).in('plan_id', ids).in('status', pending).order('id'));
    for (const payment of payments) {
      if (!byPlan.has(payment.plan_id)) byPlan.set(payment.plan_id, []);
      byPlan.get(payment.plan_id).push(payment);
    }
  }
  return new Map(plans.map(plan => [plan.id, directDebitNextDates(plan, byPlan.get(plan.id))]));
}