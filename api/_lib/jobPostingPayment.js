export const DEFAULT_JOB_POSTING_PRICE = 50;

export function resolveConfiguredJobPostingPrice(
  settingValue,
  fallback = DEFAULT_JOB_POSTING_PRICE,
) {
  if (settingValue == null || String(settingValue).trim() === '') {
    return fallback;
  }

  const amount = Number(settingValue);
  return Number.isFinite(amount) && amount > 0 ? amount : fallback;
}

export function resolveStoredJobPostingAmount(jobPosting) {
  if (jobPosting?.amount_paid == null || jobPosting.amount_paid === '') {
    throw new Error('Job posting payment amount is not configured');
  }

  const amount = Number(jobPosting?.amount_paid);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Job posting payment amount is not configured');
  }

  return amount;
}