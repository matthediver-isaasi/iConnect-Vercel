const ORDINARY_MEMBERSHIP_YEAR = /^\d{4}(?:[/-](?:\d{2}|\d{4}))?$/;
const ROLLING_TERM_KEY = /^rolling(?::|$)/i;

const DIRECT_DEBIT_METHODS = new Set([
  'direct_debit',
  'direct-debit',
  'dd',
  'gocardless',
  'go_cardless',
  'gocardless_monthly',
  'gocardless_monthly_dd',
  'monthly_direct_debit',
  'direct_debit_monthly',
]);

const CARD_METHODS = new Set([
  'card',
  'stripe',
  'card_payment',
  'stripe_card',
  'monthly_card',
  'card_monthly',
  'stripe_monthly_card',
]);

const MONTHLY_METHODS = new Set([
  'gocardless_monthly',
  'gocardless_monthly_dd',
  'monthly_direct_debit',
  'direct_debit_monthly',
  'monthly_card',
  'card_monthly',
  'stripe_monthly_card',
]);

function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '') ?? null;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Validate a retained calendar date without allowing Date to normalise invalid
 * values such as 2026-02-30. Time-bearing values are accepted only when the
 * complete timestamp and its leading calendar date are both valid.
 */
export function retainedHistoryDate(value) {
  if (typeof value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
  if (value.includes('T') && !Number.isFinite(Date.parse(value))) return null;

  const day = value.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === day
    ? day
    : null;
}

export function historyScheduleDateLabel(value) {
  const day = retainedHistoryDate(value);
  if (!day) return null;
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function normaliseToken(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/\s+/g, '_')
    : '';
}

function durationLabel(value) {
  const duration = typeof value === 'string' && value.trim() !== ''
    ? Number(value)
    : value;
  if (!Number.isInteger(duration) || duration <= 0) return null;
  return `${duration} ${duration === 1 ? 'month' : 'months'}`;
}

/**
 * Produce display-only membership schedule data exclusively from values saved
 * with the history row. No current pricing/configuration or inferred dates are
 * consulted.
 */
export function getMembershipHistorySchedule(record) {
  const row = object(record);
  const snapshot = object(row.commitment_snapshot);

  const rawStart = firstPresent(row.term_start_date, snapshot.term_start_date);
  const rawEnd = firstPresent(row.term_end_date, snapshot.term_end_date);
  const rawRenewal = firstPresent(
    row.membership_renewal_date,
    snapshot.membership_renewal_date,
  );
  let start = retainedHistoryDate(rawStart);
  let end = retainedHistoryDate(rawEnd);
  let renewal = retainedHistoryDate(rawRenewal);

  // A range is trustworthy only when all retained boundaries agree. Do not
  // partially present a contradictory agreement.
  const invalidRange = (start && end && end < start)
    || (start && renewal && renewal <= start)
    || (end && renewal && renewal <= end);
  if (invalidRange) {
    start = null;
    end = null;
    renewal = null;
  }

  const membershipYear = typeof row.membership_year === 'string'
    ? row.membership_year.trim()
    : '';
  const termKey = normaliseToken(firstPresent(row.term_key, snapshot.term_key));
  const isRolling = ROLLING_TERM_KEY.test(termKey)
    || ROLLING_TERM_KEY.test(membershipYear)
    || normaliseToken(snapshot.start_mode) === 'rolling';

  let heading = 'Membership';
  if (ORDINARY_MEMBERSHIP_YEAR.test(membershipYear)) {
    heading = `Membership ${membershipYear}`;
  } else if (isRolling && start) {
    heading = `Membership from ${historyScheduleDateLabel(start)}`;
  }

  const method = normaliseToken(firstPresent(row.payment_method, snapshot.payment_method));
  const frequency = normaliseToken(firstPresent(
    row.payment_frequency,
    snapshot.payment_frequency,
    snapshot.collection_frequency,
  ));
  const isDirectDebit = DIRECT_DEBIT_METHODS.has(method);
  const isCard = CARD_METHODS.has(method);
  const monthly = frequency === 'monthly' || MONTHLY_METHODS.has(method);

  let paymentLabel;
  if (isCard) paymentLabel = monthly ? 'Monthly card payments' : 'Card payment';
  else if (method === 'invoice' || method === 'bank_transfer') paymentLabel = 'Invoiced';

  const duration = firstPresent(
    row.term_duration_months,
    snapshot.term_duration_months,
  );
  const retainedDuration = durationLabel(duration);
  const scheduleParts = [];
  if (isDirectDebit) scheduleParts.push('Ongoing — Direct Debit');
  if (start) scheduleParts.push(`From ${historyScheduleDateLabel(start)}`);
  if (retainedDuration) scheduleParts.push(retainedDuration);

  return {
    heading,
    schedule: scheduleParts.length > 0 ? scheduleParts.join(' · ') : null,
    renewalDate: isDirectDebit ? null : historyScheduleDateLabel(renewal),
    endDate: historyScheduleDateLabel(end),
    ...(paymentLabel ? { paymentLabel } : {}),
  };
}

export default getMembershipHistorySchedule;