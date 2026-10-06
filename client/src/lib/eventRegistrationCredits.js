const CREDIT_STATUS_LABELS = {
  pending: 'Pending provider',
  failed: 'Provider failed',
  unavailable: 'Not verified',
  mixed: 'Mixed / unresolved',
};

const REASON_LABELS = {
  no_evidence: 'Not verified',
  verified_empty: 'Checked — no credits found',
  pending: 'Pending provider',
  ambiguous: 'Needs review — ambiguous',
  lookup_failure: 'Provider lookup failed',
  storage_failure: 'Storage unavailable',
  provider_failed: 'Provider failed',
  missing_reference: 'Missing provider reference',
  unsupported_route: 'Unsupported payment route',
  incomplete_coverage: 'Incomplete provider coverage',
};

function isVerifiedEmpty(credits) {
  return credits?.status === 'confirmed' && Number(credits.amount) === 0
    && credits.amount != null && credits.reasonCode === 'verified_empty'
    && !!credits.verifiedAt && Array.isArray(credits.coverage) && credits.coverage.length > 0
    && credits.coverage.every(scope => scope?.allApplicableScopes === true && scope?.paginationComplete === true);
}

function hasConfirmedInstrument(credits) {
  return Array.isArray(credits?.breakdown) && credits.breakdown.some(entry =>
    entry.status === 'confirmed' && (entry.type === 'refund' || entry.type === 'credit_note')
    && entry.amount != null && Number.isFinite(Number(entry.amount)) && !!entry.currency);
}

function confirmedAmount(credits) {
  return credits?.status === 'confirmed' && credits.amount != null
    && Number.isFinite(Number(credits.amount))
    && (Number(credits.amount) !== 0 || isVerifiedEmpty(credits)
      || (credits.reasonCode !== 'verified_empty' && hasConfirmedInstrument(credits)));
}

function unresolvedLabel(credits) {
  if (credits?.reasonCode === 'verified_empty') return REASON_LABELS.no_evidence;
  return REASON_LABELS[credits?.reasonCode] || CREDIT_STATUS_LABELS[credits?.status] || 'Not verified';
}

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
  if (isVerifiedEmpty(credits)) return `${formatCreditMoney(0, credits.currency)} (checked — no credits found)`;
  if (confirmedAmount(credits)) {
    return formatCreditMoney(credits.amount, credits.currency) || 'Not verified';
  }
  return unresolvedLabel(credits);
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
    verified_empty: 'Provider lookup completed with no post-booking credits found within the recorded coverage.',
    pending: 'The provider has not yet confirmed the reversal. Refresh again later.',
    ambiguous: 'The evidence cannot be allocated or combined reliably. Manual review is required; no amount has been assumed.',
    lookup_failure: 'Provider evidence could not be verified. Check the provider connection and retry.',
    storage_failure: 'Credit evidence storage could not be read. Ask an administrator to verify the evidence migration and database access, then retry.',
    provider_failed: 'The provider reports that the reversal failed. No confirmed credit amount is available.',
    missing_reference: 'No provider reference is available. Verify the booking reference before retrying.',
    unsupported_route: 'This payment route cannot yet be fully verified. Review the provider records.',
    incomplete_coverage: 'Only part of the applicable provider scope was checked. Complete the lookup before relying on this value.',
  };
  if (isVerifiedEmpty(credits)) return explanations.verified_empty;
  if (credits?.reasonCode === 'verified_empty') return explanations.no_evidence;
  if (credits?.reasonCode && explanations[credits.reasonCode]) return explanations[credits.reasonCode];
  if (credits?.error) return explanations.storage_failure;
  if (confirmedAmount(credits) && !formatCreditMoney(credits.amount, credits.currency)) {
    return 'The confirmed amount has no usable currency; verify the provider evidence before using this value.';
  }
  if (confirmedAmount(credits)) return '';
  if (credits?.status === 'pending') return explanations.pending;
  if (credits?.status === 'failed') return explanations.provider_failed;
  if (credits?.status === 'mixed') return 'Some evidence remains unresolved. The total is not yet confirmed.';
  return credits?.breakdown?.length ? explanations.ambiguous : explanations.no_evidence;
}

export function summarizeRegistrationCredits(groups) {
  const totalsByCurrency = {};
  const unknownByStatus = {};
  let confirmedGroups = 0;
  for (const group of groups || []) {
    const credits = group?.credits;
    if (confirmedAmount(credits)) {
      const amount = Number(credits.amount);
      if (amount !== 0 && !credits.currency) {
        unknownByStatus['Not verified'] = (unknownByStatus['Not verified'] || 0) + 1;
        continue;
      }
      confirmedGroups++;
      if (!Number.isFinite(amount) || amount === 0) continue;
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
    .map(([status, count]) => `${REASON_LABELS[status] || CREDIT_STATUS_LABELS[status] || status}: ${count} booking group${count === 1 ? '' : 's'}`);
  const prefix = unknown.length ? 'Confirmed subtotal' : 'Confirmed credits';
  const amount = totals.length ? `${prefix}: ${totals.join(' · ')}` : summary?.confirmedGroups
    ? `${prefix}: ${formatCreditMoney(0, 'GBP')}` : 'No confirmed credit amounts';
  return [amount, ...unknown].join(' · ');
}