import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const tenantCtx = await getTenantContext(req);
    if (!tenantCtx?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const memberId = tenantCtx.memberId;
    if (!memberId) {
      return res.status(401).json({ error: 'Member session required' });
    }

    const tenantId = tenantCtx.tenantId;
    const { type } = req.body;

    if (type === 'categories') {
      const { category_order } = req.body;
      if (!Array.isArray(category_order)) {
        return res.status(400).json({ error: 'category_order must be an array' });
      }

      const { error } = await supabase
        .from('member_bookmark_preferences')
        .upsert({
          tenant_id: tenantId,
          member_id: memberId,
          category_order,
          updated_at: new Date().toISOString()
        }, { onConflict: 'tenant_id,member_id' });

      if (error) {
        console.error('[Bookmarks Reorder] Category reorder error:', error);
        return res.status(500).json({ error: 'Failed to save category order' });
      }

      return res.json({ success: true });
    }

    if (type === 'items') {
      const { entity_type, ordered_ids } = req.body;
      if (!entity_type || !Array.isArray(ordered_ids)) {
        return res.status(400).json({ error: 'entity_type and ordered_ids array are required' });
      }

      const updates = ordered_ids.map((entityId, index) =>
        supabase
          .from('member_bookmark')
          .update({ sort_order: index })
          .eq('tenant_id', tenantId)
          .eq('member_id', memberId)
          .eq('entity_type', entity_type)
          .eq('entity_id', entityId)
      );

      const results = await Promise.all(updates);
      const failed = results.filter(r => r.error);
      if (failed.length > 0) {
        console.error('[Bookmarks Reorder] Item reorder errors:', failed.map(f => f.error));
        return res.status(500).json({ error: 'Failed to save item order' });
      }

      return res.json({ success: true });
    }

    return res.status(400).json({ error: 'type must be "categories" or "items"' });
  } catch (error) {
    console.error('[Bookmarks Reorder] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
