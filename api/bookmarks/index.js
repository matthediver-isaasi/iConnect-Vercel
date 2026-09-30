import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
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

    if (req.method === 'GET') {
      const { entity_type } = req.query;

      let query = supabase
        .from('member_bookmark')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('member_id', memberId)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: false });

      if (entity_type) {
        query = query.eq('entity_type', entity_type);
      }

      const { data: bookmarks, error } = await query;

      if (error) {
        console.error('[Bookmarks] GET error:', error);
        return res.status(500).json({ error: 'Failed to fetch bookmarks' });
      }

      return res.json({ bookmarks: bookmarks || [] });
    }

    if (req.method === 'POST') {
      const { entity_type, entity_id } = req.body;

      if (!entity_type || !entity_id) {
        return res.status(400).json({ error: 'entity_type and entity_id are required' });
      }

      const validTypes = ['blog_post', 'resource', 'news_post', 'event', 'forum_thread', 'form'];
      if (!validTypes.includes(entity_type)) {
        return res.status(400).json({ error: `entity_type must be one of: ${validTypes.join(', ')}` });
      }

      const { data: maxRow } = await supabase
        .from('member_bookmark')
        .select('sort_order')
        .eq('tenant_id', tenantId)
        .eq('member_id', memberId)
        .eq('entity_type', entity_type)
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle();

      const nextSortOrder = (maxRow?.sort_order ?? -1) + 1;

      const { data: bookmark, error } = await supabase
        .from('member_bookmark')
        .upsert({
          tenant_id: tenantId,
          member_id: memberId,
          entity_type,
          entity_id,
          sort_order: nextSortOrder
        }, { onConflict: 'tenant_id,member_id,entity_type,entity_id' })
        .select()
        .single();

      if (error) {
        console.error('[Bookmarks] POST error:', error);
        return res.status(500).json({ error: 'Failed to create bookmark' });
      }

      return res.status(201).json({ bookmark });
    }

    if (req.method === 'DELETE') {
      const { entity_type, entity_id } = req.body;

      if (!entity_type || !entity_id) {
        return res.status(400).json({ error: 'entity_type and entity_id are required' });
      }

      const { error } = await supabase
        .from('member_bookmark')
        .delete()
        .eq('tenant_id', tenantId)
        .eq('member_id', memberId)
        .eq('entity_type', entity_type)
        .eq('entity_id', entity_id);

      if (error) {
        console.error('[Bookmarks] DELETE error:', error);
        return res.status(500).json({ error: 'Failed to remove bookmark' });
      }

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Bookmarks] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
