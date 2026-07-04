import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../../_lib/tenantContext.js';

const INBOX_FEATURE = 'communication.inbox';

async function memberHasInboxAccess(roleId) {
  if (!roleId) return true;
  return hasFeatureAccess(roleId, INBOX_FEATURE);
}

// Resolve the most recent unread message for a member. Returns { subject,
// recipientId, sentAt } or null. Builds the set of "suppressed" (read or
// archived) recipient ids, then walks delivered recipients newest-first and
// returns the first one not in that set. Breaks as soon as one is found so the
// common case (an unread message near the top) costs a single small page.
async function resolveLatestUnread(memberId, tenantId) {
  const suppressed = new Set();
  {
    const pageSize = 1000;
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from('member_inbox_message_state')
        .select('recipient_id')
        .eq('tenant_id', tenantId)
        .eq('member_id', memberId)
        .or('is_read.eq.true,is_archived.eq.true')
        .range(from, from + pageSize - 1);
      if (error) throw error;
      const batch = data || [];
      for (const s of batch) suppressed.add(s.recipient_id);
      if (batch.length < pageSize) break;
      from += pageSize;
    }
  }

  const pageSize = 200;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('email_campaign_recipient')
      .select('id, sent_at, email_campaign!inner(tenant_id, subject)')
      .eq('member_id', memberId)
      .eq('email_campaign.tenant_id', tenantId)
      .not('sent_at', 'is', null)
      .order('sent_at', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = data || [];
    for (const r of batch) {
      if (!suppressed.has(r.id)) {
        return {
          subject: r.email_campaign?.subject || '',
          recipientId: r.id,
          sentAt: r.sent_at || null,
        };
      }
    }
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return null;
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

    // When there is at least one unread message, resolve the most recent one so
    // the login popup can preview its subject and use its sent_at as a
    // "don't remind me" watermark. A message is unread when its state row is
    // absent OR (is_read=false AND is_archived=false); we build the set of
    // suppressed (read-or-archived) recipient ids and walk delivered recipients
    // newest-first until we hit one that is not suppressed.
    let latest = null;
    if (unreadCount > 0) {
      latest = await resolveLatestUnread(memberId, tenantId);
    }

    return res.json({
      unreadCount,
      latestSubject: latest?.subject || null,
      latestMessageId: latest?.recipientId || null,
      latestSentAt: latest?.sentAt || null,
    });
  } catch (error) {
    console.error('[Inbox] unread-count Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
