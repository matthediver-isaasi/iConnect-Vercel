// Positive provider evidence only. Missing events never authorize a resend.
export function acceptedCampaignEvidence(events, campaign, recipient) {
  const normalize = id => String(id || '').replace(/^<|>$/g, '');
  const matches = events.filter(e => e.event === 'accepted'
    && e['user-variables']?.iconn_campaign_id === campaign.id
    && e.recipient?.toLowerCase() === recipient.email.toLowerCase()
    && typeof recipient.delivery_is_test === 'boolean'
    && e.flags?.['is-test-mode'] === recipient.delivery_is_test
    && e.id && normalize(e.message?.headers?.['message-id'])
    && Number.isFinite(e.timestamp)
    && e.timestamp * 1000 >= Date.parse(campaign.sent_at));
  if (!matches.length || new Set(matches.map(e => normalize(e.message.headers['message-id']))).size !== 1) return null;
  const evidence = matches.sort((a,b) => a.timestamp-b.timestamp)[0];
  if (recipient.mailgun_message_id && normalize(recipient.mailgun_message_id) !== normalize(evidence.message.headers['message-id'])) return null;
  return evidence;
}

export async function recoverCampaignAcceptance(db, campaign, domain, fetchEvents, deadline) {
  const {data: rows,error} = await db.rpc('campaign_acceptance_candidates', {
    p_campaign_id:campaign.id,p_tenant_id:campaign.tenant_id,
  });
  if (error) throw error;
  let recovered=0;
  for (const row of rows || []) {
    if (Date.now()+6000>=deadline) break;
    const response=await fetchEvents(domain,{event:'accepted',recipient:row.email,
      begin:Math.floor(Date.parse(campaign.sent_at)/1000),end:Math.floor(Date.now()/1000),limit:300,ascending:'yes'});
    if (!Array.isArray(response.items)) throw new Error('Invalid provider evidence');
    // Never reconcile from a truncated recipient event history.
    const evidence=response.items.length<300 ? acceptedCampaignEvidence(response.items,campaign,row) : null;
    const {error:auditError}=await db.from('campaign_acceptance_check').upsert({
      recipient_id:row.id,checked_at:new Date().toISOString(),
      ...(evidence ? {provider_evidence:evidence} : {}),
    },{onConflict:'recipient_id'});
    if(auditError)throw auditError;
    if (!evidence) continue;
    const {data:changed,error:writeError}=await db.from('email_campaign_recipient').update({
      status:'sent',sent_at:new Date(evidence.timestamp*1000).toISOString(),
      mailgun_message_id:evidence.message.headers['message-id'],
    }).eq('id',row.id).eq('campaign_id',campaign.id).eq('status','processing')
      .eq('delivery_is_test',row.delivery_is_test).is('sent_at',null).is('mailgun_message_id',null).select('id');
    if(writeError)throw writeError;
    recovered+=changed?.length || 0;
  }
  return recovered;
}
