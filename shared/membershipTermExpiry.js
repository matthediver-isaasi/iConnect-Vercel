// Calendar-only presentation: never convert a membership date to local time.
export function validTermDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function formatMembershipTermEnd(value) {
  return validTermDate(value) ? value.split('-').reverse().join('/') : '—';
}

// Shared by the overview and the paged CRM projection. No pricing, providers,
// grace extension, or organisation entitlement participates in this selection.
export function overviewTermExpiry(data, today = new Date().toISOString().slice(0, 10)) {
  const current = (data?.currentCommitments || []).filter(row =>
    row.source === 'personal' && row.lifecycle === 'current'
    && (!row.paymentStatus || row.paymentStatus === 'paid')
    && (!row.status || ['active', 'paid', 'expired'].includes(row.status)),
  );
  if (current.length > 1) return null;
  if (current.length === 1) return validTermDate(current[0].endDate) ? current[0].endDate : null;
  if (data?.legacyCurrentMembership) {
    return validTermDate(data.legacyCurrentMembership.endDate) ? data.legacyCurrentMembership.endDate : null;
  }
  const paid = (data?.history || []).filter(row =>
    row.membership_source === 'personal' && row.payment_status === 'paid'
    && ['active', 'paid', 'expired'].includes(row.status)
    && (!row.term_start_date || (validTermDate(row.term_start_date) && row.term_start_date <= today)),
  ).sort((a, b) => String(b.term_end_date || '').localeCompare(String(a.term_end_date || '')));
  return validTermDate(paid[0]?.term_end_date) ? paid[0].term_end_date : null;
}
