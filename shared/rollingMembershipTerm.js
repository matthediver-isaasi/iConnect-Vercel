const PERIOD_MONTHS = Object.freeze({ annual: 12, quarterly: 3, monthly: 1 });

/** Strict date-only arithmetic; never depend on the browser/server timezone. */
export function rollingDateString(value) {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('A valid membership date is required');
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error(`Invalid membership date: ${text}`);
  }
  return text;
}

export function billingPeriodMonths(period) {
  const months = PERIOD_MONTHS[period];
  if (!months) throw new Error(`Unsupported membership billing period: ${period}`);
  return months;
}

export function addCalendarMonths(value, months, anchorDate = value) {
  if (!Number.isInteger(months) || months < 0) throw new Error('Calendar months must be a non-negative integer');
  const date = new Date(`${rollingDateString(value)}T00:00:00.000Z`);
  const anchorDay = Number(rollingDateString(anchorDate).slice(8, 10));
  const targetMonth = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(date.getUTCFullYear(), targetMonth, Math.min(anchorDay, lastDay))).toISOString().slice(0, 10);
}

export function buildRollingTerm({ startDate, billingPeriod, anchorDate, previousTerm = null }) {
  if (previousTerm && !isRollingCommitment(previousTerm)) throw new Error('Previous rolling term is incomplete');
  const start = rollingDateString(previousTerm?.membership_renewal_date || startDate);
  if (previousTerm && startDate && rollingDateString(startDate) !== start) {
    throw new Error('A renewed term must start on the previous renewal date');
  }
  const anchor = rollingDateString(previousTerm?.term_anchor_date || anchorDate || start);
  if (anchor > start) throw new Error('Membership anchor cannot be after the term start');
  const months = billingPeriodMonths(billingPeriod);
  const renewal = addCalendarMonths(start, months, anchor);
  const end = new Date(`${renewal}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return {
    term_start_date: start,
    term_end_date: end.toISOString().slice(0, 10),
    membership_renewal_date: renewal,
    term_duration_months: months,
    term_anchor_date: anchor,
    term_key: `rolling:${start}`,
    previous_term_id: previousTerm?.id || null,
  };
}

export function isRollingCommitment(record) {
  return !!(record?.term_key?.startsWith('rolling:')
    && record.term_start_date && record.term_end_date && record.membership_renewal_date
    && [1, 3, 12].includes(Number(record.term_duration_months)) && record.term_anchor_date);
}

export function rollingTermIdentity(record) {
  return isRollingCommitment(record) ? record.term_key : record?.membership_year || null;
}