export function normalizeAlertRecipients(value) {
  return [...new Set(value.split(/[\n,;]+/).map(email => email.trim().toLowerCase()).filter(Boolean))];
}

export function alertRecipientsError(enabled, recipients) {
  if (recipients.length > 20) return "You can add up to 20 recipients.";
  if (recipients.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    return "Enter a valid email address for every recipient.";
  }
  if (enabled && recipients.length === 0) return "Add at least one recipient to enable alerts.";
  return null;
}
