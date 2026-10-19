// The timings endpoint returns evidence, not inferred dates. Keep missing values
// visible and never substitute updated_at or the last recipient timestamp.
export function formatCampaignTimestamp(value, timeZone) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'medium', timeZone,
  }).format(new Date(value));
}

export function formatCampaignDuration(milliseconds) {
  if (milliseconds == null || !Number.isFinite(milliseconds) || milliseconds < 0) return 'Not available';
  if (milliseconds < 1000) return 'Less than 1 second';
  const seconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  return [
    days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`,
    (remainder || (!days && !hours && !minutes)) && `${remainder}s`,
  ].filter(Boolean).join(' ');
}

export function validateCampaignTimings(data, campaignId) {
  // Reject the ordinary campaign response: older servers ignore unknown query
  // parameters. Rendering it as timing evidence would hide a missing endpoint.
  if (!data?.timings || String(data.campaign?.id) !== String(campaignId)) {
    throw new Error('Campaign timing details are not available from the server yet.');
  }
  const timings = { ...data.timings, notes: Array.isArray(data.timings.notes) ? [...data.timings.notes] : [] };
  const finished = Date.parse(timings.completed_at);
  const start = Date.parse(timings.started_at);
  const created = Date.parse(data.campaign.created_at);
  const ongoing = ['draft', 'scheduled', 'preparing', 'sending', 'paused'].includes(data.campaign.status);
  const invalidFinish = Number.isFinite(finished) &&
    ((Number.isFinite(start) && finished < start) || (Number.isFinite(created) && finished < created));
  if (ongoing || invalidFinish) {
    timings.completed_at = null;
    timings.send_duration_ms = null;
    timings.overall_duration_ms = null;
    if (invalidFinish) timings.notes.push('The recorded completion predates the current campaign start or creation and has been ignored.');
  }
  return { ...data, timings };
}
