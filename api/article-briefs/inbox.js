import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

const VALID_FOLDERS = new Set(['inbox', 'archive']);
const MAX_PAGE_SIZE = 200;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.isAuthenticated || !tenantCtx.tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const folder = VALID_FOLDERS.has(req.query.folder) ? req.query.folder : 'inbox';
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, MAX_PAGE_SIZE);

  try {
    const baseColumns = 'id, article_brief_id, event_type, metadata, read_at, archived_at, created_at';
    const buildQuery = (selectStr) => {
      let q = supabase
        .from('article_brief_inbox_item')
        .select(selectStr)
        .eq('tenant_id', tenantCtx.tenantId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (folder === 'archive') {
        q = q.not('archived_at', 'is', null);
      } else {
        q = q.is('archived_at', null);
      }
      return q;
    };

    // Try the embedded brief lookup first; fall back to fetching items without
    // the embed and resolving brief titles in a separate query if PostgREST
    // can't resolve the relation (e.g. environment provisioned without FK
    // metadata).
    let { data: items, error: itemsError } = await buildQuery(
      `${baseColumns}, brief:article_brief(id, title)`
    );
    let usedFallback = false;

    if (itemsError) {
      // Gracefully handle missing table (migration not yet applied)
      if (itemsError.code === '42P01' || /does not exist/i.test(itemsError.message || '')) {
        console.warn('[BriefInbox] article_brief_inbox_item table missing; returning empty inbox');
        return res.json({ items: [], unread_count: 0 });
      }
      // Fallback: relation embed couldn't be resolved
      const isRelationError = /could not find a relationship|relationship .* not found|schema cache/i.test(
        itemsError.message || ''
      ) || itemsError.code === 'PGRST200';
      if (isRelationError) {
        console.warn('[BriefInbox] Brief relation embed failed; falling back to manual title lookup:', itemsError.message);
        const fallback = await buildQuery(baseColumns);
        if (fallback.error) {
          console.error('[BriefInbox] Fallback fetch error:', fallback.error);
          return res.status(500).json({ error: 'Failed to fetch inbox items' });
        }
        items = fallback.data;
        usedFallback = true;
      } else {
        console.error('[BriefInbox] Error fetching items:', itemsError);
        return res.status(500).json({ error: 'Failed to fetch inbox items' });
      }
    }

    // Resolve brief titles separately when the embed wasn't available
    let titleByBriefId = null;
    if (usedFallback && items && items.length > 0) {
      const briefIds = Array.from(new Set(items.map((i) => i.article_brief_id).filter(Boolean)));
      if (briefIds.length > 0) {
        const { data: briefs, error: briefsError } = await supabase
          .from('article_brief')
          .select('id, title')
          .in('id', briefIds)
          .eq('tenant_id', tenantCtx.tenantId);
        if (briefsError) {
          console.error('[BriefInbox] Failed to fetch brief titles in fallback:', briefsError);
        } else {
          titleByBriefId = new Map((briefs || []).map((b) => [b.id, b.title]));
        }
      }
    }

    const { count: unreadCount, error: countError } = await supabase
      .from('article_brief_inbox_item')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantCtx.tenantId)
      .is('read_at', null)
      .is('archived_at', null);

    if (countError) {
      console.error('[BriefInbox] Error counting unread:', countError);
    }

    const normalised = (items || []).map((row) => ({
      id: row.id,
      article_brief_id: row.article_brief_id,
      brief_title: titleByBriefId
        ? (titleByBriefId.get(row.article_brief_id) || null)
        : (row.brief?.title || null),
      event_type: row.event_type,
      metadata: row.metadata || {},
      read_at: row.read_at,
      archived_at: row.archived_at,
      created_at: row.created_at,
    }));

    return res.json({
      items: normalised,
      unread_count: unreadCount || 0,
    });
  } catch (error) {
    console.error('[BriefInbox] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch inbox: ' + (error.message || 'Unknown error') });
  }
}
