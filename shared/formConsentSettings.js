export const FORM_PRIVACY_SETTINGS_KEY = 'form_privacy_settings_url';

// Absolute HTTP(S) only. Reject credentials and control characters rather than
// relying on the browser's forgiving URL parser to repair malformed input.
export function safeFormPrivacyUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed) || /[\u0000-\u0020\u007f\\]/.test(trimmed)) return '';
  try {
    const url = new URL(trimmed);
    return url.hostname && !url.username && !url.password ? trimmed : '';
  } catch {
    return '';
  }
}
