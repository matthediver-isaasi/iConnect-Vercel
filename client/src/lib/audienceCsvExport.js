import { rowsToCsv } from './csvExport.js';

// Opt-in protection for this export only; keep unrelated CSV exports unchanged.
function safeRecipientCell(value) {
  const text = String(value ?? '');
  return /^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text)
    ? `'${text}`
    : text;
}

export function audiencePreviewToCsv(data) {
  if (data?.success !== true || data.error || !Array.isArray(data.recipients)
    || !Number.isInteger(data.totalCount) || data.totalCount !== data.recipients.length
    || data.recipients.some(recipient => !recipient
      || typeof recipient.email !== 'string' || !recipient.email.trim()
      || ['first_name', 'last_name'].some(key => recipient[key] != null && typeof recipient[key] !== 'string'))) {
    throw new Error('Unable to download the complete audience. Please try again.');
  }
  if (data.totalCount === 0) return null;
  return rowsToCsv([
    ['First name', 'Last name', 'Email'],
    ...data.recipients.map(recipient =>
      [recipient.first_name, recipient.last_name, recipient.email].map(safeRecipientCell)),
  ]);
}