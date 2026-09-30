const TERMINAL_PLAN_STATUSES = new Set(['payment_plan_cancelled', 'expired']);

function newestFirst(a, b) {
  return String(b?.created_at || '').localeCompare(String(a?.created_at || ''))
    || String(b?.id || '').localeCompare(String(a?.id || ''));
}

export function formatGocardlessMandateStatus(status) {
  if (!status) return null;
  return String(status)
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Resolve a member-owned mandate only. The newest direct agreement is the
 * current setup journey; within it, a non-terminal newest plan wins. A plan's
 * replacement mandate takes precedence over the agreement's original one.
 */
export function selectCurrentMemberMandate({ memberId, agreements = [], plans = [], mandates = [] }) {
  const directAgreements = agreements
    .filter(row =>
      String(row.member_id || '') === String(memberId)
      && row.agreement_type === 'member'
      && !row.organization_id
    )
    .sort(newestFirst);
  const agreement = directAgreements[0] || null;
  if (!agreement) return { mandateId: null, status: null, statusLabel: null };

  const agreementPlans = plans
    .filter(row =>
      String(row.billing_agreement_id || '') === String(agreement.id)
      && !row.organization_id
    )
    .sort((a, b) => {
      const aTerminal = TERMINAL_PLAN_STATUSES.has(a.status) ? 1 : 0;
      const bTerminal = TERMINAL_PLAN_STATUSES.has(b.status) ? 1 : 0;
      return aTerminal - bTerminal || newestFirst(a, b);
    });
  const mandateId = agreementPlans[0]?.gocardless_mandate_id
    || agreement.gocardless_mandate_id
    || null;
  if (!mandateId) return { mandateId: null, status: null, statusLabel: null };

  const mirror = mandates.find(row =>
    String(row.gocardless_mandate_id) === String(mandateId)
    && String(row.tenant_id) === String(agreement.tenant_id)
  );
  const status = mirror?.status || null;
  return { mandateId, status, statusLabel: formatGocardlessMandateStatus(status) };
}