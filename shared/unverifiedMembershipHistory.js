const retired = new Set(['cancelled', 'canceled', 'void', 'voided', 'expired_checkout']);

function personal(row) {
  return row && !row.organization_id && row.membership_source !== 'organisation';
}

function date(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function year(row) {
  const match = /^(\d{4})(?:$|[/-])/.exec(String(row.membership_year || ''));
  return match ? Number(match[1]) : null;
}

function laterVerifiedPurchase(candidate, unknown) {
  if (!personal(candidate) || retired.has(candidate.status)
      || candidate.tenant_id !== unknown.tenant_id || candidate.member_id !== unknown.member_id) return false;
  const settled = candidate.payment_status === 'paid';
  const ongoing = candidate.payment_status === 'partial' && candidate.status === 'active'
    && candidate.billing_agreement_id && date(candidate.term_start_date);
  if (!settled && !ongoing) return false;
  if (candidate.previous_term_id === unknown.id) return true;
  const start = date(candidate.term_start_date);
  const unknownStart = date(unknown.term_start_date);
  const unknownEnd = date(unknown.term_end_date);
  if (start && unknownEnd && start > unknownEnd) return true;
  if (start && unknownStart) return start > unknownStart;
  if (start && unknownEnd) return false;
  const candidateYear = year(candidate), unknownYear = year(unknown);
  // Labels establish ordering only: never turn them into term/expiry dates.
  return candidateYear !== null && unknownYear !== null && candidateYear > unknownYear;
}

/**
 * Old uncertain history stays visible but is not an owner-wide permanent lock.
 * Only an independently evidenced later purchase can supersede its hold.
 * An explicitly selected unknown predecessor/target always requires review.
 */
export function findUnresolvedUnverifiedHistory(history = [], { previousTerm, targetYear, historyId } = {}) {
  if (personal(previousTerm) && previousTerm.payment_status === 'unverified') return previousTerm;
  const unknown = history.filter(row => personal(row) && row.payment_status === 'unverified'
    && !retired.has(row.status));
  return unknown.find(row => row.id === historyId || (targetYear && row.membership_year === targetYear)
    || !history.some(candidate => laterVerifiedPurchase(candidate, row))) || null;
}
