// Only expose the current generation of campaigns already authorized by the caller.
// A historical failure must not appear after a campaign has been restarted.
export async function enrichCampaignPreparationList(db, tenantId, campaigns) {
  const generations = [...new Set(campaigns
    .filter(campaign => campaign.preparation_generation && campaign.status !== 'sent')
    .map(campaign => campaign.preparation_generation))];
  if (!generations.length) return campaigns;

  const { data, error } = await db.from('campaign_preparation')
    .select('id,campaign_id,phase,last_error')
    .eq('tenant_id', tenantId)
    .in('id', generations);
  if (error) throw error;

  const byGeneration = new Map((data || []).map(row => [row.id, row]));
  return campaigns.map(campaign => {
    const preparation = byGeneration.get(campaign.preparation_generation);
    if (!preparation || preparation.campaign_id !== campaign.id || campaign.status === 'sent') return campaign;
    return { ...campaign, preparation: {
      phase: preparation.phase,
      last_error: preparation.phase === 'failed' ? preparation.last_error : null,
    } };
  });
}