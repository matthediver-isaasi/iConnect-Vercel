// Cache candidate IDs, never delivery authority. Every recipient still needs
// its own pending -> processing CAS and the caller's fresh send-time gates.
// A worker crash therefore leaves unread candidates pending, not stranded.
export function createCampaignRecipientClaimer(db, campaignId, {
  pageSize = 50, deadline, now = Date.now,
} = {}) {
  const parsed = Number(pageSize);
  const size = Number.isFinite(parsed) ? Math.max(1, Math.min(100, Math.floor(parsed))) : 50;
  let candidates = [];
  const metrics = { candidatePageSize: size, candidateReads: 0, claimWrites: 0, claimCollisions: 0 };
  const expired = () => deadline != null && now() >= deadline;

  // Admissions are serialized by campaignDrain. Independent workers may read
  // overlapping pages; only the winner of the conditional update may send.
  async function claim() {
    if (expired()) return [];
    if (!candidates.length) {
      metrics.candidateReads++;
      const { data, error } = await db.from('email_campaign_recipient')
        .select('id').eq('campaign_id', campaignId).eq('status', 'pending')
        .order('id', { ascending: true }).limit(size);
      if (error) throw error;
      candidates = (data || []).map(row => row.id);
    }
    // Never spin through repeated pages on contention. Yield after this page.
    while (candidates.length && !expired()) {
      const id = candidates.shift();
      metrics.claimWrites++;
      const { data, error } = await db.from('email_campaign_recipient')
        .update({ status: 'processing' }).eq('campaign_id', campaignId)
        .eq('id', id).eq('status', 'pending').select();
      if (error) throw error;
      if (data?.length) return data;
      metrics.claimCollisions++;
    }
    return [];
  }
  return { claim, metrics };
}
