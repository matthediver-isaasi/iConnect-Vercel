import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

const MAX_PAGE_SIZE = 200;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.isAuthenticated || !tenantCtx.tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!tenantCtx.memberId) {
    return res.status(403).json({ error: 'Member context required' });
  }

  // GET /api/support/inbox — list inbox items for the current member
  if (req.method === 'GET') {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, MAX_PAGE_SIZE);
    const unreadOnly = req.query.unread === 'true';

    try {
      let query = supabase
        .from('support_inbox_item')
        .select('id, ticket_id, event_type, metadata, read_at, created_at')
        .eq('tenant_id', tenantCtx.tenantId)
        .eq('recipient_member_id', tenantCtx.memberId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (unreadOnly) {
        query = query.is('read_at', null);
      }

      const { data: items, error: itemsError } = await query;

      if (itemsError) {
        if (itemsError.code === '42P01' || /does not exist/i.test(itemsError.message || '')) {
          return res.json({ items: [], unread_count: 0 });
        }
        console.error('[SupportInbox] Error fetching items:', itemsError);
        return res.status(500).json({ error: 'Failed to fetch inbox items' });
      }

      // Fetch ticket subjects for listed items
      const ticketIds = [...new Set((items || []).map(i => i.ticket_id).filter(Boolean))];
      let ticketMap = {};
      if (ticketIds.length > 0) {
        const { data: tickets } = await supabase
          .from('support_ticket')
          .select('id, subject, type, status')
          .in('id', ticketIds)
          .eq('tenant_id', tenantCtx.tenantId);
        for (const t of tickets || []) {
          ticketMap[t.id] = t;
        }
      }

      const { count: unreadCount, error: countError } = await supabase
        .from('support_inbox_item')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantCtx.tenantId)
        .eq('recipient_member_id', tenantCtx.memberId)
        .is('read_at', null);

      if (countError) {
        console.error('[SupportInbox] Error counting unread:', countError);
      }

      const normalised = (items || []).map(row => ({
        id: row.id,
        ticket_id: row.ticket_id,
        ticket_subject: ticketMap[row.ticket_id]?.subject || row.metadata?.ticket_subject || null,
        ticket_type: ticketMap[row.ticket_id]?.type || row.metadata?.ticket_type || null,
        ticket_status: ticketMap[row.ticket_id]?.status || null,
        event_type: row.event_type,
        metadata: row.metadata || {},
        read_at: row.read_at,
        created_at: row.created_at,
      }));

      return res.json({ items: normalised, unread_count: unreadCount || 0 });
    } catch (err) {
      console.error('[SupportInbox] GET error:', err);
      return res.status(500).json({ error: 'Failed to fetch inbox: ' + (err.message || 'Unknown error') });
    }
  }

  // POST /api/support/inbox — mark item(s) as read
  if (req.method === 'POST') {
    const { item_ids, mark_all_read } = req.body || {};

    try {
      const now = new Date().toISOString();

      if (mark_all_read) {
        const { error } = await supabase
          .from('support_inbox_item')
          .update({ read_at: now })
          .eq('tenant_id', tenantCtx.tenantId)
          .eq('recipient_member_id', tenantCtx.memberId)
          .is('read_at', null);

        if (error) {
          console.error('[SupportInbox] Error marking all read:', error);
          return res.status(500).json({ error: 'Failed to mark items as read' });
        }
        return res.json({ success: true });
      }

      if (!Array.isArray(item_ids) || item_ids.length === 0) {
        return res.status(400).json({ error: 'item_ids must be a non-empty array' });
      }

      const { error } = await supabase
        .from('support_inbox_item')
        .update({ read_at: now })
        .eq('tenant_id', tenantCtx.tenantId)
        .eq('recipient_member_id', tenantCtx.memberId)
        .in('id', item_ids)
        .is('read_at', null);

      if (error) {
        console.error('[SupportInbox] Error marking items read:', error);
        return res.status(500).json({ error: 'Failed to mark items as read' });
      }

      return res.json({ success: true });
    } catch (err) {
      console.error('[SupportInbox] POST error:', err);
      return res.status(500).json({ error: 'Failed to update inbox: ' + (err.message || 'Unknown error') });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
