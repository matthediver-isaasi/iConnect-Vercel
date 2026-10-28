// sent_at is also set at preparation start; it is evidence only for legacy
// campaigns without a preparation generation. Queued/failed counts prove nothing.
export function canDownloadCampaignPdf(campaign) {
  if (!campaign || ['draft', 'scheduled', 'preparing'].includes(campaign.status)) return false;
  if (['sending', 'sent'].includes(campaign.status)) return true;
  if (!['paused', 'failed', 'cancelled'].includes(campaign.status)) return false;
  return ['sent_count', 'delivered_count', 'opened_count', 'clicked_count'].some(key => Number(campaign[key]) > 0)
    || Number(campaign.delivery_summary?.sent) > 0
    || (!campaign.preparation_generation && !!campaign.sent_at && Number.isFinite(Date.parse(campaign.sent_at)))
    || campaign.preparation?.phase === 'complete';
}

export function campaignPdfFilename(campaign) {
  const safe = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
  return `campaign-${safe(campaign.name || campaign.subject) || 'email'}-${safe(campaign.id).slice(0, 36) || 'export'}.pdf`;
}
