import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';

const VALID_ACTIONS = new Set(['mark_read', 'mark_unread', 'archive', 'unarchive']);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'PATCH' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.isAuthenticated || !tenantCtx.tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { itemId } = req.query;
  if (!itemId) {
    return res.status(400).json({ error: 'itemId is required' });
  }

  const action = req.body?.action;
  if (!VALID_ACTIONS.has(action)) {
    return res.status(400).json({ error: 'Invalid action. Expected one of: ' + Array.from(VALID_ACTIONS).join(', ') });
  }

  try {
    const now = new Date().toISOString();
    const updates = {};
    if (action === 'mark_read') updates.read_at = now;
    if (action === 'mark_unread') updates.read_at = null;
    if (action === 'archive') updates.archived_at = now;
    if (action === 'unarchive') updates.archived_at = null;

    const { data: updated, error: updateError } = await supabase
      .from('article_brief_inbox_item')
      .update(updates)
      .eq('id', itemId)
      .eq('tenant_id', tenantCtx.tenantId)
      .select('id, article_brief_id, event_type, metadata, read_at, archived_at, created_at')
      .maybeSingle();

    if (updateError) {
      console.error('[BriefInbox] Update error:', updateError);
      return res.status(500).json({ error: 'Failed to update inbox item' });
    }

    if (!updated) {
      return res.status(404).json({ error: 'Inbox item not found' });
    }

    return res.json({ success: true, item: updated });
  } catch (error) {
    console.error('[BriefInbox] Error:', error);
    return res.status(500).json({ error: 'Failed to update inbox item: ' + (error.message || 'Unknown error') });
  }
}
