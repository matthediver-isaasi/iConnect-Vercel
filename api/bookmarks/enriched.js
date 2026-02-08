import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
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

    const { data: bookmarks, error } = await supabase
      .from('member_bookmark')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('member_id', memberId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });

    const { data: prefs } = await supabase
      .from('member_bookmark_preferences')
      .select('category_order')
      .eq('tenant_id', tenantId)
      .eq('member_id', memberId)
      .maybeSingle();

    if (error) {
      console.error('[Bookmarks Enriched] GET error:', error);
      return res.status(500).json({ error: 'Failed to fetch bookmarks' });
    }

    if (!bookmarks || bookmarks.length === 0) {
      return res.json({ bookmarks: [] });
    }

    const grouped = {};
    for (const bm of bookmarks) {
      if (!grouped[bm.entity_type]) grouped[bm.entity_type] = [];
      grouped[bm.entity_type].push(bm.entity_id);
    }

    const entityData = {};

    const tableMap = {
      blog_post: { table: 'blog_post', fields: 'id, title, slug, published_date, author_id' },
      resource: { table: 'resource', fields: 'id, title, description' },
      news_post: { table: 'news_post', fields: 'id, title, slug, published_date' },
      event: { table: 'event', fields: 'id, title, start_date' },
      forum_thread: { table: 'forum_thread', fields: 'id, title, slug, created_at, post_count' }
    };

    for (const [entityType, ids] of Object.entries(grouped)) {
      const config = tableMap[entityType];
      if (!config) continue;

      try {
        const { data: entities, error: fetchError } = await supabase
          .from(config.table)
          .select(config.fields)
          .in('id', ids)
          .eq('tenant_id', tenantId);

        if (fetchError) {
          console.error(`[Bookmarks Enriched] Error fetching ${entityType}:`, fetchError);
        }

        if (entities) {
          for (const entity of entities) {
            entityData[`${entityType}:${entity.id}`] = entity;
          }
        }
      } catch (lookupErr) {
        console.error(`[Bookmarks Enriched] Exception fetching ${entityType}:`, lookupErr);
      }
    }

    const enriched = bookmarks.map(bm => ({
      ...bm,
      entity: entityData[`${bm.entity_type}:${bm.entity_id}`] || null
    }));

    const categoryOrder = prefs?.category_order || null;
    return res.json({ bookmarks: enriched, category_order: categoryOrder });
  } catch (error) {
    console.error('[Bookmarks Enriched] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
