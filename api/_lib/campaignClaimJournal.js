export async function transitionCampaignClaims(db, recipients, action) {
  const tokens = recipients.map(row => row._claim_token).filter(Boolean);
  if (!tokens.length) return; // Legacy rows are never eligible for automatic recovery.
  if (tokens.length !== recipients.length) throw new Error('Mixed journal ownership');
  const { data, error } = await db.rpc('campaign_transition_batch_claims', {
    p_tokens: tokens, p_action: action,
  });
  if (error) throw error;
  if (data !== tokens.length) throw new Error('Incomplete campaign claim transition');
}

export async function recoverUnsubmittedCampaignClaims(db, campaignId) {
  const { data, error } = await db.rpc('campaign_recover_unsubmitted_claims', { p_campaign_id: campaignId });
  // Old deployments cannot recover ambiguous legacy claims. Do not infer safety.
  if (error && ['42883', 'PGRST202'].includes(error.code)) return 0;
  if (error) throw error;
  return data;
}

export async function finalizeCampaignDelivery(db, campaignId, tenantId) {
  const { data, error } = await db.rpc('campaign_finalize_delivery', {
    p_campaign_id: campaignId, p_tenant_id: tenantId,
  });
  if (error) throw error;
  if (!data || typeof data.complete !== 'boolean') throw new Error('Invalid campaign completion result');
  return data;
}
