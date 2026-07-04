import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../../_lib/tenantContext.js';

const INBOX_FEATURE = 'communication.inbox';

async function memberHasInboxAccess(roleId) {
  if (!roleId) return true;
  return hasFeatureAccess(roleId, INBOX_FEATURE);
}

// Lightweight unread badge count for the nav / dashboard. Uses head:true count
// queries so it never pulls message rows.
//
//   unread = deliveredTotal - archivedStates - readNonArchivedStates
//
// A delivered message with no state row counts as unread (not read, not
// archived), which this arithmetic captures without enumerating rows.
export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const ctx = await getTenantContext(req);
    if (!ctx?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const memberId = ctx.memberId;
    if (!memberId) {
      return res.status(401).json({ error: 'Member session required' });
    }
    const tenantId = ctx.tenantId;

    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!(await memberHasInboxAccess(ctx.roleId))) {
      return res.status(403).json({ error: 'You do not have access to the inbox' });
    }

    const [deliveredRes, archivedRes, readNonArchivedRes] = await Promise.all([
      supabase
        .from('email_campaign_recipient')
        .select('id, email_campaign!inner(tenant_id)', { count: 'exact', head: true })
        .eq('member_id', memberId)
        .eq('email_campaign.tenant_id', tenantId)
        .not('sent_at', 'is', null),
      supabase
        .from('member_inbox_message_state')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('member_id', memberId)
        .eq('is_archived', true),
      supabase
        .from('member_inbox_message_state')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('member_id', memberId)
        .eq('is_read', true)
        .eq('is_archived', false),
    ]);

    if (deliveredRes.error || archivedRes.error || readNonArchivedRes.error) {
      console.error('[Inbox] unread-count error:', deliveredRes.error || archivedRes.error || readNonArchivedRes.error);
      return res.status(500).json({ error: 'Failed to compute unread count' });
    }

    const delivered = deliveredRes.count || 0;
    const archived = archivedRes.count || 0;
    const readNonArchived = readNonArchivedRes.count || 0;
    const unreadCount = Math.max(0, delivered - archived - readNonArchived);

    return res.json({ unreadCount });
  } catch (error) {
    console.error('[Inbox] unread-count Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
