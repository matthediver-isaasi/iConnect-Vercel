// Read-only lifecycle gate. Never cancel providers or alter financial evidence here.
const TERMINAL = new Set(['payment_plan_cancelled', 'cancelled', 'canceled', 'completed', 'finished', 'expired', 'incomplete_expired']);
const TABLES = ['membership_billing_agreements', 'membership_payment_plans'];
export const BILLING_DELETION_WARNING = 'Removing membership access does not cancel Stripe or GoCardless payments. Resolve recurring agreements separately with explicit cancellation authority, then retry. Financial history will be retained.';

export async function checkMemberDeletionBilling(db, { memberId, organizationId, tenantId }) {
  const blockers = [];
  const failures = [];
  const agreementIds = [];
  const seenPlans = new Set();
  function inspect(row, table) {
    if (table === TABLES[1]) {
      if (seenPlans.has(row.id)) return;
      seenPlans.add(row.id);
    }
    if (!TERMINAL.has(String(row.status || '').toLowerCase())) {
      blockers.push({
        id: row.id, kind: table === TABLES[0] ? 'agreement' : 'payment plan',
        provider: row.provider === 'stripe' ? 'Stripe' : row.provider === 'gocardless' ? 'GoCardless' : 'Recurring payment',
        status: row.status || 'unknown',
      });
    }
  }
  // Do not treat missing tables/columns or denied reads as an empty account.
  for (const table of TABLES) {
    try {
      let query = db.from(table).select('id,status,provider', { count: 'exact' })
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
      let query = db.from(TABLES[1]).select('id,status,provider', { count: 'exact' })
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
