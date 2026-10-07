export const FORM_ALERT_MAX_RECIPIENTS = 20;
export const FORM_ALERT_EXPIRY_DAYS = 7;

export function normalizeFormAlertSettings(input) {
  if (!input || typeof input.enabled !== 'boolean' || !Array.isArray(input.recipients)) {
    throw new Error('Provide an enabled flag and a recipient list.');
  }
  if (input.recipients.length > FORM_ALERT_MAX_RECIPIENTS) {
    throw new Error(`Use at most ${FORM_ALERT_MAX_RECIPIENTS} recipients.`);
  }
  const recipients = [];
  for (const value of input.recipients) {
    if (typeof value !== 'string') throw new Error('Every recipient must be an email address.');
    const email = value.trim().toLowerCase();
    if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(email)) {
      throw new Error('Every recipient must be a valid email address.');
    }
    if (!recipients.includes(email)) recipients.push(email);
  }
  if (input.enabled && !recipients.length) throw new Error('Add at least one recipient before enabling alerts.');
  return { enabled: input.enabled, recipients };
}
