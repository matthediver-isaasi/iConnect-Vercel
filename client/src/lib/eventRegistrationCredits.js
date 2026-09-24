const CREDIT_STATUS_LABELS = {
  pending: 'Pending',
  failed: 'Failed',
  unavailable: 'Unavailable',
  mixed: 'Mixed / unavailable',
};

export function formatCreditMoney(amount, currency) {
  if (amount == null || amount === '' || !Number.isFinite(Number(amount))) return null;
  const code = currency
    ? String(currency).toUpperCase()
    : Number(amount) === 0 ? 'GBP' : null;
  if (!code) return null;
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: code,
    }).format(Number(amount));
  } catch {
    return `${code} ${Number(amount)}`;
  }
}

export function formatRegistrationCredits(credits) {
  if (!credits) return 'Unavailable';
  if (credits.status === 'confirmed' && credits.amount != null) {
    return formatCreditMoney(credits.amount, credits.currency) || 'Unavailable';
  }
  return CREDIT_STATUS_LABELS[credits.status] || 'Unavailable';
}

export function formatRegistrationCreditBreakdown(credits) {
  if (!Array.isArray(credits?.breakdown) || credits.breakdown.length === 0) return '';
  return credits.breakdown.map((entry) => {
    const type = entry.type === 'credit_note' ? 'Credit note' : 'Refund';
    const provider = entry.provider ? ` (${entry.provider})` : '';
    const amount = entry.amount == null
      ? CREDIT_STATUS_LABELS[entry.status] || 'Amount unavailable'
      : formatCreditMoney(entry.amount, entry.currency);
    const status = entry.status && entry.status !== 'confirmed' ? ` [${entry.status}]` : '';
    const reference = entry.providerId ? ` #${entry.providerId}` : '';
    return `${type}${provider}${reference}: ${amount || 'Amount unavailable'}${status}`;
  }).join('; ');
}

export function formatRegistrationCreditsExport(credits) {
  const amount = formatRegistrationCredits(credits);
  const breakdown = formatRegistrationCreditBreakdown(credits);
  const explanation = formatRegistrationCreditExplanation(credits);
  return [amount, breakdown, explanation].filter(Boolean).join(' — ');
}

export function formatRegistrationCreditExplanation(credits) {
  const explanations = {
    no_evidence: 'No verified reversal evidence was found. This does not establish a zero credit.',
    pending: 'The provider has not yet confirmed the reversal. Refresh again later.',
    ambiguous: 'The evidence cannot be allocated or combined reliably. Manual review is required; no amount has been assumed.',
    lookup_failure: 'Provider evidence could not be verified. Check the provider connection and retry.',
    storage_failure: 'Credit evidence storage could not be read. Ask an administrator to verify the evidence migration and database access, then retry.',
    provider_failed: 'The provider reports that the reversal failed. No confirmed credit amount is available.',
  };
  if (credits?.reasonCode && explanations[credits.reasonCode]) return explanations[credits.reasonCode];
  if (credits?.error) return explanations.storage_failure;
  if (credits?.status === 'confirmed' && credits.amount != null) return '';
  if (credits?.status === 'pending') return explanations.pending;
  if (credits?.status === 'failed') return explanations.provider_failed;
  if (credits?.status === 'mixed') return 'Some evidence remains unresolved. The total is not yet confirmed.';
  return credits?.breakdown?.length ? explanations.ambiguous : explanations.no_evidence;
}

export function summarizeRegistrationCredits(groups) {
  const totalsByCurrency = {};
  const unknownByStatus = {};
  for (const group of groups || []) {
    const credits = group?.credits;
    if (credits?.status === 'confirmed' && credits.amount != null) {
      const amount = Number(credits.amount);
      if (!Number.isFinite(amount) || amount === 0) continue;
      if (credits.currency) {
        const currency = String(credits.currency).toUpperCase();
        totalsByCurrency[currency] = (totalsByCurrency[currency] || 0) + amount;
      } else {
        unknownByStatus.unavailable = (unknownByStatus.unavailable || 0) + 1;
      }
    } else {
      const status = CREDIT_STATUS_LABELS[credits?.status] ? credits.status : 'unavailable';
      unknownByStatus[status] = (unknownByStatus[status] || 0) + 1;
    }
  }
  return { totalsByCurrency, unknownByStatus };
}

export function formatRegistrationCreditSummary(summary) {
  const totals = Object.entries(summary?.totalsByCurrency || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => formatCreditMoney(amount, currency));
  const unknown = Object.entries(summary?.unknownByStatus || {})
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${CREDIT_STATUS_LABELS[status] || 'Unavailable'}: ${count}`);
  return [...totals, ...unknown].join(' · ') || formatCreditMoney(0, 'GBP');
}