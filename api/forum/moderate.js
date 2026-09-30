import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tenantCtx = await getTenantContext(req);
    if (!tenantCtx.isAuthenticated || !tenantCtx.tenantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { action, target_type, target_id, details } = req.body;

    if (!action || !target_type || !target_id) {
      return res.status(400).json({ error: 'Missing required fields: action, target_type, target_id' });
    }

    const validActions = ['pin', 'unpin', 'lock', 'unlock', 'hide', 'unhide', 'move', 'delete'];
    const validTargetTypes = ['thread', 'post', 'category'];

    if (!validActions.includes(action)) {
      return res.status(400).json({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` });
    }

    if (!validTargetTypes.includes(target_type)) {
      return res.status(400).json({ error: `Invalid target_type. Must be one of: ${validTargetTypes.join(', ')}` });
    }

    const performedBy = tenantCtx.memberId || tenantCtx.tenantUserId;
    if (!performedBy) {
      return res.status(403).json({ error: 'Could not determine acting user' });
    }

    const { data: logEntry, error } = await supabase
      .from('forum_moderation_log')
      .insert({
        tenant_id: tenantCtx.tenantId,
        action,
        target_type,
        target_id,
        performed_by: performedBy,
        details: details || null
      })
      .select()
      .single();

    if (error) {
      console.error('[ForumModerate] Error logging moderation action:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ success: true, log: logEntry });
  } catch (error) {
    console.error('[ForumModerate] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
