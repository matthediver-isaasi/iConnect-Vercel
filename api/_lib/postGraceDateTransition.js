import { isDeepStrictEqual } from 'node:util';
import { planPostGraceRecordDates } from './postGraceRenewal.js';

const dateKeys = [
  'term_start_date', 'term_end_date', 'membership_renewal_date',
  'term_duration_months', 'term_anchor_date', 'term_key', 'previous_term_id',
];

function replaceDates(record, dates) {
  return { ...structuredClone(record), ...Object.fromEntries(dateKeys.map(key => [key, dates[key]])) };
}

function commitmentMetadata(metadata, dates) {
  const result = structuredClone(metadata || {});
  // These are the documented canonical commitment locations. Do not recursively
  // rewrite arbitrary dates: original consent and quote evidence must survive.
  if (result.commitment) result.commitment = replaceDates(result.commitment, dates);
  for (const key of ['card', 'dd']) {
    if (result[key]?.commitment) {
      result[key].commitment = replaceDates(result[key].commitment, dates);
    }
    if (result[key]) {
      for (const [field, value] of Object.entries({
        membership_year_start: dates.term_start_date,
        membership_year_end: dates.term_end_date,
        membership_renewal_date: dates.membership_renewal_date,
      })) {
        if (Object.hasOwn(result[key], field)) result[key][field] = value;
      }
    }
  }
  return result;
}

/**
 * Exact compare-and-swap inputs for a database transaction, not independent
 * REST updates. The before images fence concurrent activation, cancellation,
 * repricing, ownership changes and a second successful payment.
 *
 * This function deliberately does not infer provider collection dates or
 * change status to active. A mandate/checkout completion is not entitlement.
 */
export function buildPostGraceDateTransition(input) {
  const decision = planPostGraceRecordDates(input);
  const { history, agreement, plan } = input;
  const { dates } = decision;
  if (!history.commitment_snapshot
      || (agreement && !isDeepStrictEqual(
        history.commitment_snapshot, agreement.commitment_snapshot,
      ))) {
    throw new Error('Matching purchased commitment snapshots are required');
  }
  if (agreement && dateKeys.some(key => (history[key] ?? null) !== (agreement[key] ?? null))) {
    throw new Error('Pending membership and agreement dates disagree');
  }
  if (plan && (plan.member_id !== input.reservation.memberId || plan.organization_id)) {
    throw new Error('Monthly plan owner does not match post-grace reservation');
  }
  const before = structuredClone({ history, agreement, plan });
  const nextHistory = replaceDates(history, dates);
  const nextAgreement = agreement ? replaceDates(agreement, dates) : null;
  if (nextAgreement) {
    nextAgreement.metadata = commitmentMetadata(agreement.metadata, dates);
  }
  const nextPlan = plan ? {
    ...structuredClone(plan),
    start_date: dates.term_start_date,
    metadata: commitmentMetadata(plan.metadata, dates),
  } : null;
  // Never rewrite a saved commitment's price, VAT, discounts, voucher
  // allocations, payment frequency, config snapshot, or accepted-at value.
  return {
    ...decision,
    before,
    after: { history: nextHistory, agreement: nextAgreement, plan: nextPlan },
    releaseCollectionHold: false,
  };
}
