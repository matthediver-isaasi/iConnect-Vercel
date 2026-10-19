// A post-send unsubscribe is engagement history, not an unsent exclusion.
export function isExcludedCampaignRecipient(row) {
  return row.status === 'cancelled' ||
    (row.status === 'unsubscribed' && !row.sent_at && !row.mailgun_message_id);
}

export function campaignRecipientLabel(row) {
  if (isExcludedCampaignRecipient(row)) {
    if (/hard.bounced address/i.test(row.error_message || '')) return 'Skipped — hard-bounce suppression';
    if (row.status === 'unsubscribed') return 'Skipped — consent exclusion';
    return 'Skipped — not sent';
  }
  if (row.status === 'processing') return 'Awaiting reconciliation';
  if (row.status === 'pending') return 'Queued';
  return row.status;
}

export const RECONCILIATION_GUIDANCE = 'Check the recipient list and provider delivery logs with an administrator. Reconcile existing message evidence before any resend; do not resume, duplicate or retry these recipients to resolve uncertainty.';

// Legacy recipients have no claim timestamp. This is explicitly a campaign-age
// warning, NOT a claim that every processing row has been idle for 30 minutes.
export function campaignReconciliationAlert(campaign, processing, now = Date.now()) {
  if (!processing) return null;
  const start = Date.parse(campaign.sent_at);
  const created = Date.parse(campaign.created_at);
  const validStart = Number.isFinite(start) && (!Number.isFinite(created) || start >= created) && start <= now;
  const attention = !validStart || now - start >= 30 * 60 * 1000 ||
    ['sent', 'failed', 'cancelled', 'paused'].includes(campaign.status);
  if (!attention) return null;
  return {
    count: processing,
    basis: validStart ? 'campaign_age' : 'unknown_start',
    message: validStart
      ? `${processing} recipients await reconciliation. Campaign started ${new Date(start).toISOString()}; individual processing start times are not recorded.`
      : `${processing} recipients await reconciliation; a reliable campaign start time is unavailable.`,
  };
}
