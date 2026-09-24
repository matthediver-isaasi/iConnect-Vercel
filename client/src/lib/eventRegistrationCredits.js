const CREDIT_STATUS_LABELS = {
  pending: 'Pending',
  failed: 'Failed',
  unavailable: 'Unavailable',
  mixed: 'Mixed / unavailable',
};

export function formatCreditMoney(amount, currency) {
  if (!Number.isFinite(Number(amount))) return null;
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
  return breakdown ? `${amount} — ${breakdown}` : amount;
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