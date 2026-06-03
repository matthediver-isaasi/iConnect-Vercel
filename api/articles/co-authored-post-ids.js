import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

// Task #1225: list the blog post ids an author CO-authored (i.e. appears in the
// blog_post_author join table but is NOT necessarily the primary author).
// GET /api/articles/co-authored-post-ids?type=member|guest_writer&id=<uuid>
// Returns { postIds: [...] }. Used by the author listing page so a member's
// page also surfaces articles they only co-authored. Tenant-scoped, read-only.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const { type, id } = req.query;
  if (!id || (type !== 'member' && type !== 'guest_writer')) {
    return res.status(400).json({ error: 'type (member|guest_writer) and id are required' });
  }

  try {
    const tenant = await resolveTenantFromRequest(req);

    let query = supabase
      .from('blog_post_author')
      .select('blog_post_id');

    if (type === 'member') {
      query = query.eq('author_id', id);
    } else {
      query = query.eq('guest_writer_id', id);
    }

    if (tenant?.id) {
      query = query.eq('tenant_id', tenant.id);
    }

    const { data, error } = await query;
    if (error) {
      console.error('[Co-Authored Post Ids] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch co-authored posts' });
    }

    const postIds = [...new Set((data || []).map((r) => r.blog_post_id).filter(Boolean))];
    return res.json({ postIds });
  } catch (error) {
    console.error('[Co-Authored Post Ids] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch co-authored posts' });
  }
}
