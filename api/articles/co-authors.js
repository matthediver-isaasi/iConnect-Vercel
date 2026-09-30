import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { resolveBlogPostAuthorsForPosts } from '../_lib/blogPostAuthors.js';

// Task #1225: batch co-author lookup for article list cards.
// GET /api/articles/co-authors?ids=<uuid>,<uuid>,...
// Returns { authors: { [blogPostId]: [authorCard, ...] } } where the array is
// the FULL ordered author list (primary first). The caller filters out the
// primary author for display. Tenant-scoped and public-safe (read-only).
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

  const idsParam = req.query.ids;
  const ids = (Array.isArray(idsParam) ? idsParam.join(',') : (idsParam || ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return res.json({ authors: {} });
  }

  try {
    const tenant = await resolveTenantFromRequest(req);

    let query = supabase
      .from('blog_post')
      .select('id, tenant_id, author_id, guest_writer_id')
      .in('id', ids);

    // Tenant isolation: only serve authors for posts in the resolved tenant.
    if (tenant?.id) {
      query = query.eq('tenant_id', tenant.id);
    }

    const { data: posts, error } = await query;
    if (error) {
      console.error('[Article Co-Authors] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch co-authors' });
    }

    const byPost = await resolveBlogPostAuthorsForPosts(supabase, posts || []);

    const authors = {};
    for (const [postId, cards] of byPost.entries()) {
      authors[postId] = cards;
    }

    return res.json({ authors });
  } catch (error) {
    console.error('[Article Co-Authors] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch co-authors' });
  }
}
