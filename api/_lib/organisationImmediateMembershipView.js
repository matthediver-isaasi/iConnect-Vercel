const retired = new Set(['cancelled', 'canceled', 'void', 'replaced', 'cancelled_by_request', 'expired_checkout']);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value)) ? value : null;

// Read-only organisation presentation. Never manufacture purchased dates from
// creation timestamps, year labels, or today's date.
export function organisationImmediateMembershipView(config, history, today = new Date().toISOString().slice(0, 10)) {
  if (config.start_mode !== 'immediate' || config.structure_scope_type !== 'organization') return null;
  const records = history.filter(row => !retired.has(row.status));
  const dated = records.filter(row => date(row.term_start_date) && date(row.term_end_date)
    && row.term_start_date <= row.term_end_date);
  const current = dated.filter(row => row.term_start_date <= today && row.term_end_date >= today
    && row.status !== 'expired');
  const scheduled = dated.filter(row => row.term_start_date > today)
    .sort((a, b) => a.term_start_date.localeCompare(b.term_start_date));
  const undated = records.filter(row => !dated.includes(row));
  const ambiguous = current.length > 1 || undated.length > 1 || (current.length && undated.length);
  const selected = ambiguous ? null : current[0] || undated[0]
    || [...dated].sort((a, b) => b.term_start_date.localeCompare(a.term_start_date))[0] || null;
  const summary = row => row ? {
    id: row.id, membershipYear: row.membership_year, startDate: date(row.term_start_date),
    endDate: date(row.term_end_date), renewalDate: date(row.membership_renewal_date),
    structureName: row.structure_name || row.config_name || config.name,
    tierLabel: row.tier_label || null, currency: row.currency || config.currency,
    finalCost: row.total_with_vat ?? row.final_cost ?? null,
    paymentStatus: row.payment_status, status: row.status,
  } : null;
  return {
    current: summary(selected), scheduled: summary(scheduled[0]),
    state: ambiguous ? 'review_required' : !selected ? 'not_recorded'
      : !dated.includes(selected) ? 'dates_missing'
        : selected.term_start_date > today ? 'scheduled'
          : current.includes(selected) ? 'current' : 'past',
  };
}
