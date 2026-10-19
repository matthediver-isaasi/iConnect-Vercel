import { campaignReconciliationAlert } from '../../shared/campaignDeliverySummary.js';

// Exact counts avoid the PostgREST row cap and never mutate delivery history.
export async function readCampaignDeliverySummary(db, campaign, now = Date.now()) {
  const count = async filter => {
    const query = db.from('email_campaign_recipient').select('*', { count: 'exact', head: true })
      .eq('campaign_id', campaign.id);
    const { count: value, error } = await filter(query);
    if (error) throw error;
    return value || 0;
  };
  const [sent, cancelled, unsubscribedBeforeSend, failed, queued, processing] = await Promise.all([
    count(q => q.in('status', ['sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained'])),
    count(q => q.eq('status', 'cancelled')),
    count(q => q.eq('status', 'unsubscribed').is('sent_at', null).is('mailgun_message_id', null)),
    count(q => q.eq('status', 'failed')),
    count(q => q.eq('status', 'pending')),
    count(q => q.eq('status', 'processing')),
  ]);
  const unsubscribedAfterSend = await count(q => q.eq('status', 'unsubscribed')
    .or('sent_at.not.is.null,mailgun_message_id.not.is.null'));
  return {
    sent: sent + unsubscribedAfterSend,
    excluded: cancelled + unsubscribedBeforeSend,
    failed, queued, processing, awaitingReconciliation: processing,
    reconciliationAlert: campaignReconciliationAlert(campaign, processing, now),
  };
}
