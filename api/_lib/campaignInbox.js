// The service-only database view owns the delivered/non-test predicate.
// Never fall back to the base table if the migration has not been applied.
export function campaignInboxRecipients(db) {
  return db.from('campaign_inbox_recipient');
}

export async function campaignInboxUnreadSummary(db, memberId, tenantId) {
  const { data, error } = await db.rpc('campaign_inbox_unread_summary', {
    p_tenant: tenantId, p_member: memberId,
  });
  if (error) throw error;
  const summary = data?.[0];
  if (!summary) throw new Error('Campaign inbox summary unavailable');
  return {
    count: Number(summary.unread_count),
    latest: summary.latest_recipient_id ? {
      subject: summary.latest_subject || '',
      recipientId: summary.latest_recipient_id,
      sentAt: summary.latest_sent_at,
    } : null,
  };
}

// Bound URL size and avoid silently truncating ownership checks at the
// PostgREST row cap. Complete validation precedes every state mutation.
export async function verifyCampaignInboxRecipients(db, ids, memberId, tenantId) {
  const owned = [];
  for (let start = 0; start < ids.length; start += 100) {
    const chunk = ids.slice(start, start + 100);
    const { data, error } = await campaignInboxRecipients(db)
      .select('id, email_campaign!inner(tenant_id)')
      .in('id', chunk).eq('member_id', memberId)
      .eq('email_campaign.tenant_id', tenantId);
    if (error) throw error;
    if (data?.length !== chunk.length) {
      throw Object.assign(new Error('Message not found'), { status: 404 });
    }
    owned.push(...data.map(r => r.id));
  }
  return owned;
}
