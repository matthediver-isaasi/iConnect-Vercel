const timestamp = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const duration = (start, end) => start && end && Date.parse(end) >= Date.parse(start)
  ? Date.parse(end) - Date.parse(start) : null;

export function campaignTimingEvidence(campaign, preparation, first, last) {
  const notes = [];
  const created = timestamp(campaign.created_at);
  const valid = value => {
    const at = timestamp(value);
    return at && (!created || at >= created) ? at : null;
  };
  const started = ['draft', 'scheduled'].includes(campaign.status) ? null : valid(campaign.sent_at);
  let completed = ['sent', 'failed', 'cancelled'].includes(campaign.status) ? valid(campaign.completed_at) : null;
  if (completed && started && completed < started) completed = null;
  if (campaign.completed_at && !completed) notes.push('The saved completion does not establish a finish for this campaign run and has been ignored.');
  let prepEnd = preparation?.phase === 'complete' ? valid(preparation.completed_at) : null;
  if (prepEnd && started && prepEnd < started) prepEnd = null;
  if (preparation?.phase === 'complete' && !prepEnd) notes.push('This preparation has no recorded completion timestamp; its last update is not used as an estimate.');
  const recipientTime = value => {
    const at = valid(value);
    return at && (!started || at >= started) ? at : null;
  };
  const firstSent = recipientTime(first), lastSent = recipientTime(last);
  notes.push('Send duration and overall duration both run from the first recorded successful send to the last recorded successful send, regardless of campaign status. Preparation and time after the last successful send are excluded; gaps between successful sends remain included.');
  return {
    scheduled_at: timestamp(campaign.scheduled_at), started_at: started,
    preparation_started_at: preparation ? started : null,
    preparation_completed_at: prepEnd,
    first_recipient_sent_at: firstSent, last_recipient_sent_at: lastSent,
    completed_at: completed,
    preparation_duration_ms: duration(preparation ? started : null, prepEnd),
    send_duration_ms: duration(firstSent, lastSent),
    overall_duration_ms: duration(firstSent, lastSent), notes,
  };
}

// On-demand read only. Parent tenant authorization precedes all child evidence.
export async function readCampaignTimings(db, id, tenantId) {
  const { data: campaign, error } = await db.from('email_campaign')
    .select('id,status,created_at,scheduled_at,sent_at,completed_at,preparation_generation,is_test_mode')
    .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
  if (error) throw error;
  if (!campaign) return null;
  const recipient = ascending => db.from('email_campaign_recipient').select('sent_at')
    .eq('campaign_id', id).not('sent_at', 'is', null)
    .order('sent_at', { ascending }).limit(1).maybeSingle();
  const [prep, first, last] = await Promise.all([
    campaign.preparation_generation
      ? db.from('campaign_preparation').select('phase,last_error,completed_at')
        .eq('id', campaign.preparation_generation).eq('campaign_id', id).eq('tenant_id', tenantId).maybeSingle()
      : { data: null },
    recipient(true), recipient(false),
  ]);
  for (const result of [prep, first, last]) if (result.error) throw result.error;
  return { campaign: { ...campaign, preparation: prep.data },
    timings: campaignTimingEvidence(campaign, prep.data, first.data?.sent_at, last.data?.sent_at) };
}
