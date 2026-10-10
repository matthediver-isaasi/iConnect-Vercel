// Mirrors classify_email_delivery in the database, which remains authoritative.
export function classifyEmailDelivery(event) {
  if (event.event === 'delivered') return 'delivered';
  if (!['failed', 'bounced'].includes(event.event)) return null;
  const code = Number(event['delivery-status']?.code);
  if (event.severity === 'temporary') return 'soft_bounce';
  if (event.severity === 'permanent' && ((code >= 400 && code < 500) ||
    /(expired|retry.*exhaust|too.old)/i.test(event.reason || ''))) return 'delivery_failed';
  if (event.severity === 'permanent' || (code >= 500 && code < 600)) return 'hard_bounce';
  if (code >= 400 && code < 500) return 'soft_bounce';
  return 'delivery_failed';
}
