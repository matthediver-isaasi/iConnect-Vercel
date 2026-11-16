export const FORM_SUBMISSION_LINK_EXPIRY_KEY = 'form_submission_link_expiry_days';

export function isValidLinkExpiry(value) {
  return typeof value === 'string' && /^\d+$/.test(value) &&
    Number(value) >= 1 && Number(value) <= 365;
}

export function normalizeLinkExpiry(value) {
  return isValidLinkExpiry(value) ? String(Number(value)) : '7';
}
