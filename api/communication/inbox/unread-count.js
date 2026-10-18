import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../../_lib/tenantContext.js';
import { projectUnreadSummary } from '../../_lib/projectMainInbox.js';
import { campaignInboxUnreadSummary } from '../../_lib/campaignInbox.js';

const INBOX_FEATURE = 'communication.inbox';

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  try {
    const ctx = await getTenantContext(req);
    if (!ctx?.tenantId) return res.status(401).json({ error: 'Unauthorized' });
    const { memberId, tenantId } = ctx;
    if (!memberId) return res.status(401).json({ error: 'Member session required' });
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    if (ctx.roleId && !await hasFeatureAccess(ctx.roleId, INBOX_FEATURE)) {
      return res.status(403).json({ error: 'You do not have access to the inbox' });
    }

    // Campaign count + preview come from one database snapshot and the same
    // eligibility relation used by list/search/detail/state checks.
    const [campaign, txnCount, txnLatest, project] = await Promise.all([
      campaignInboxUnreadSummary(supabase, memberId, tenantId),
      supabase.from('member_transactional_message')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).eq('member_id', memberId)
        .eq('is_read', false).eq('is_archived', false),
      supabase.from('member_transactional_message')
        .select('id, subject, sent_at')
        .eq('tenant_id', tenantId).eq('member_id', memberId)
        .eq('is_read', false).eq('is_archived', false)
        .order('sent_at', { ascending: false }).limit(1),
      projectUnreadSummary(supabase, ctx),
    ]);
    if (txnCount.error) throw txnCount.error;
    if (txnLatest.error) throw txnLatest.error;
    const txn = txnLatest.data?.[0];
    const latest = [
      campaign.latest, project.latest,
      txn ? { subject: txn.subject, recipientId: txn.id, sentAt: txn.sent_at } : null,
    ].filter(Boolean).sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))[0];
    return res.json({
      unreadCount: campaign.count + (txnCount.count || 0) + project.count,
      latestSubject: latest?.subject || null,
      latestMessageId: latest?.recipientId || null,
      latestSentAt: latest?.sentAt || null,
    });
  } catch (error) {
    console.error('[Inbox] unread-count Error:', error);
    return res.status(500).json({ error: 'Failed to compute unread count' });
  }
}
