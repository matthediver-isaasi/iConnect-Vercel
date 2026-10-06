// The report's canonical totalAfterDiscount is source-aware: standard code
// discounts are separate; complex ticket prices already include them. It is
// booking value BEFORE voucher/fund/account settlement, not total_paid.
// This report is GBP-only. Never convert foreign credit evidence implicitly.
function pennies(value) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  const result = Math.round((number + Number.EPSILON) * 100);
  return Number.isSafeInteger(result) ? result : null;
}

export function registrationGroupRevenue(group) {
  const payment = group?.groupPayment;
  const base = pennies(payment?.totalAfterDiscount);
  if (base === null) return { amount: null, reason: 'missing_base' };
  if (payment?.currency && String(payment.currency).toUpperCase() !== 'GBP') {
    return { amount: null, reason: 'currency' };
  }
  const credits = group?.credits;
  const credit = pennies(credits?.amount);
  if (credits?.status !== 'confirmed' || credit === null) {
    return { amount: null, reason: 'unverified_credits' };
  }
  if ((credits.currency && String(credits.currency).toUpperCase() !== 'GBP')
    || (!credits.currency && credit !== 0)) {
    return { amount: null, reason: 'currency' };
  }
  // Consume the authoritative projection, never sum its overlapping legs.
  return { amount: Math.max(0, base - credit) / 100, reason: null };
}

export function summarizeRegistrationRevenue(groups = []) {
  let total = 0;
  let unavailableGroups = 0;
  const reasons = {};
  for (const group of groups) {
    const result = registrationGroupRevenue(group);
    if (result.reason) {
      unavailableGroups++;
      reasons[result.reason] = (reasons[result.reason] || 0) + 1;
    } else {
      total += pennies(result.amount);
    }
  }
  if (!Number.isSafeInteger(total)) {
    reasons.amount_range = 1;
  }
  const unavailable = unavailableGroups > 0 || !!reasons.amount_range;
  return {
    totalRevenue: unavailable ? null : total / 100,
    hasUnavailableRevenue: unavailable,
    revenueUnavailableGroups: unavailableGroups,
    revenueUnavailableReasons: reasons,
  };
}

export function registrationRevenueExplanation(summary) {
  const labels = {
    missing_base: 'missing booking value',
    unverified_credits: 'unverified or unresolved Credits',
    currency: 'incompatible or missing currency',
    amount_range: 'amount exceeds the supported range',
  };
  return Object.entries(summary?.revenueUnavailableReasons || {})
    .map(([reason, count]) => `${count}: ${labels[reason] || 'unavailable evidence'}`).join('; ');
}
