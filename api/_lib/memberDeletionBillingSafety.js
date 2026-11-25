// Read-only lifecycle gate. Never cancel providers or alter financial evidence here.
const TERMINAL = new Set(['payment_plan_cancelled', 'cancelled', 'canceled', 'completed', 'finished', 'expired', 'incomplete_expired']);
const TABLES = ['membership_billing_agreements', 'membership_payment_plans'];
const PLAN_COLUMNS = 'id,status,provider,billing_agreement_id,stripe_subscription_id,gocardless_subscription_id';
const SUBSCRIPTION_COLUMN = { stripe: 'stripe_subscription_id', gocardless: 'gocardless_subscription_id' };
export const BILLING_DELETION_WARNING = 'Removing membership access does not cancel Stripe or GoCardless payments. Resolve recurring agreements separately with explicit cancellation authority, then retry. Financial history will be retained.';

export async function checkMemberDeletionBilling(db, { memberId, organizationId, tenantId }) {
  const blockers = [];
  const failures = [];
  const agreementIds = [];
  const openProviderAgreements = [];
  const plans = new Map();
  function inspect(row, table) {
    if (table === TABLES[1]) {
      if (plans.has(row.id)) return;
      plans.set(row.id, row);
    }
    if (TERMINAL.has(String(row.status || '').toLowerCase())) return;
    const blocker = {
      id: row.id, kind: table === TABLES[0] ? 'agreement' : 'payment plan',
      provider: row.provider === 'stripe' ? 'Stripe' : row.provider === 'gocardless' ? 'GoCardless' : 'Recurring payment',
      status: row.status || 'unknown',
    };
    // A Stripe card agreement keeps its own status after Stripe ends the
    // subscription, and a GoCardless agreement stays active while its mandate
    // does after a subscription-only stop. Decide them only after their linked
    // plans are known.
    if (table === TABLES[0] && SUBSCRIPTION_COLUMN[row.provider]) openProviderAgreements.push({ ...blocker, providerKey: row.provider });
    else blockers.push(blocker);
  }
  // Do not treat missing tables/columns or denied reads as an empty account.
  for (const table of TABLES) {
    try {
      let query = db.from(table).select(table === TABLES[1] ? PLAN_COLUMNS : 'id,status,provider', { count: 'exact' })
        .eq(organizationId ? 'organization_id' : 'member_id', organizationId || memberId);
      if (tenantId) query = query.eq('tenant_id', tenantId);
      const { data, error, count } = await query;
      if (error || !Array.isArray(data) || (count != null && count > data.length)) {
        failures.push(table);
        continue;
      }
      for (const row of data) {
        if (table === TABLES[0]) agreementIds.push(row.id);
        inspect(row, table);
      }
    } catch {
      failures.push(table);
    }
  }
  // Legacy plans may carry only the agreement link, not member_id.
  for (let offset = 0; offset < agreementIds.length; offset += 100) {
    try {
      let query = db.from(TABLES[1]).select(PLAN_COLUMNS, { count: 'exact' })
        .in('billing_agreement_id', agreementIds.slice(offset, offset + 100));
      if (tenantId) query = query.eq('tenant_id', tenantId);
      const { data, error, count } = await query;
      if (error || !Array.isArray(data) || (count != null && count > data.length)) {
        failures.push('linked_payment_plans');
      } else {
        data.forEach(row => inspect(row, TABLES[1]));
      }
    } catch {
      failures.push('linked_payment_plans');
    }
  }
  // Resolved only by provider-confirmed cancellation of every linked
  // subscription plan: the plan was moved to payment_plan_cancelled by a
  // provider webhook or reconciliation, never by a local/admin status edit
  // alone. Plans without a provider subscription (for example dynamic Direct
  // Debit collections) are never inferred stopped.
  for (const { providerKey, ...agreement } of openProviderAgreements) {
    const linked = [...plans.values()].filter(plan => plan.billing_agreement_id === agreement.id);
    const cancelled = linked.length > 0 && linked.every(plan => plan.provider === providerKey
      && plan.status === 'payment_plan_cancelled' && plan[SUBSCRIPTION_COLUMN[providerKey]]);
    if (!cancelled || failures.length) { blockers.push(agreement); continue; }
    try {
      let query = db.from('membership_payment_status_history').select('entity_id')
        .eq('entity_type', 'payment_plan').eq('to_status', 'payment_plan_cancelled')
        .in('source', ['webhook', 'reconciliation']).in('entity_id', linked.map(plan => plan.id));
      if (tenantId) query = query.eq('tenant_id', tenantId);
      const { data, error } = await query;
      if (error || !Array.isArray(data)) {
        failures.push('stripe_cancellation_evidence');
        continue;
      }
      const confirmed = new Set(data.map(row => row.entity_id));
      if (!linked.every(plan => confirmed.has(plan.id))) blockers.push(agreement);
    } catch {
      failures.push('stripe_cancellation_evidence');
    }
  }
  return {
    success: failures.length === 0 && blockers.length === 0,
    status: failures.length ? 503 : blockers.length ? 409 : 200,
    code: failures.length ? 'BILLING_CHECK_INCOMPLETE' : blockers.length ? 'RECURRING_BILLING_UNRESOLVED' : null,
    error: failures.length
      ? `Recurring payment checks could not be completed. No deletion was started. ${BILLING_DELETION_WARNING}`
      : blockers.length ? `${blockers.length} unresolved recurring payment record(s) prevent deletion. ${BILLING_DELETION_WARNING}` : null,
    blockers, failures, warning: BILLING_DELETION_WARNING,
  };
}
