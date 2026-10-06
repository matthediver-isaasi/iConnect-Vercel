const REASONS = {
  no_recorded_credits: 'No credits recorded in iConnect',
  amount_not_recorded: 'Amount not recorded',
  ambiguous: 'Needs review — allocation or overlap unknown',
  unresolved_record: 'Recorded credit status unresolved',
  storage_failure: 'Storage unavailable',
};

function confirmedAmount(credits) {
  return credits?.status === 'confirmed' && credits.amount != null
    && credits.amount !== '' && Number.isFinite(Number(credits.amount))
    && Number(credits.amount) >= 0
    && (Number(credits.amount) === 0 || !!credits.currency);
}

function unresolvedLabel(credits) {
  return REASONS[credits?.reasonCode] || 'Amount unavailable';
}

export function formatCreditMoney(amount, currency) {
  if (amount == null || amount === '' || !Number.isFinite(Number(amount))) return null;
  const code = currency ? String(currency).toUpperCase() : Number(amount) === 0 ? 'GBP' : null;
  if (!code) return null;
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: code }).format(Number(amount));
  } catch {
    return null;
  }
}

export function formatRegistrationCredits(credits) {
  return confirmedAmount(credits)
    ? formatCreditMoney(credits.amount, credits.currency) || 'Amount unavailable'
    : unresolvedLabel(credits);
}

export function formatRegistrationCreditBreakdown(credits) {
  return (credits?.breakdown || []).map(entry => {
    const type = entry.type === 'credit_note' ? 'Credit note' : 'Refund';
    const provider = entry.provider ? ` (${entry.provider})` : '';
    const reference = entry.providerId ? ` #${entry.providerId}` : '';
    const amount = entry.status === 'confirmed'
      ? formatCreditMoney(entry.amount, entry.currency) || 'Amount not recorded'
      : `${entry.status === 'pending' ? 'Pending' : entry.status === 'failed' ? 'Failed' : 'Unresolved'} — not counted as an applied credit`;
    return `${type}${provider}${reference}: ${amount}`;
  }).join('; ');
}

export function formatRegistrationCreditExplanation(credits) {
  const explanations = {
    no_recorded_credits: 'No credits recorded in iConnect.',
    amount_not_recorded: 'A credit reference is recorded in iConnect, but its monetary amount is not recorded. No amount has been assumed.',
    ambiguous: 'Recorded credits cannot be allocated or combined reliably. Manual review is required; no complete total has been assumed.',
    unresolved_record: 'A credit is recorded in iConnect, but its outcome is unresolved. No complete credit or revenue total has been assumed.',
    storage_failure: 'Local credit records could not be read. Retry the report; contact support if the problem continues.',
  };
  if (explanations[credits?.reasonCode]) return explanations[credits.reasonCode];
  if (confirmedAmount(credits)) return '';
  return 'Local credit amount is unavailable.';
}

export function formatRegistrationCreditsExport(credits) {
  return [formatRegistrationCredits(credits), formatRegistrationCreditBreakdown(credits),
    formatRegistrationCreditExplanation(credits)].filter(Boolean).join(' — ');
}

export function summarizeRegistrationCredits(groups) {
  const totalsByCurrency = {};
  const unknownByStatus = {};
  let confirmedGroups = 0;
  for (const { credits } of groups || []) {
    if (confirmedAmount(credits)) {
      confirmedGroups++;
      const amount = Number(credits.amount);
      if (!amount) continue;
      const currency = String(credits.currency).toUpperCase();
      totalsByCurrency[currency] = (totalsByCurrency[currency] || 0) + amount;
    } else {
      const label = unresolvedLabel(credits);
      unknownByStatus[label] = (unknownByStatus[label] || 0) + 1;
    }
  }
  return { totalsByCurrency, unknownByStatus, confirmedGroups };
}

export function formatRegistrationCreditSummary(summary) {
  const totals = Object.entries(summary?.totalsByCurrency || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => formatCreditMoney(amount, currency));
  const unknown = Object.entries(summary?.unknownByStatus || {})
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status}: ${count} booking group${count === 1 ? '' : 's'}`);
  const prefix = unknown.length ? 'Recorded subtotal' : 'Recorded credits';
  const amount = totals.length ? `${prefix}: ${totals.join(' · ')}` : summary?.confirmedGroups
    ? `${prefix}: ${formatCreditMoney(0, 'GBP')}` : 'No recorded credit amounts available';
  return [amount, ...unknown].join(' · ');
}
