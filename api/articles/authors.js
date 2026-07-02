import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { resolveBlogPostAuthors } from '../_lib/blogPostAuthors.js';

// Task #1222: ordered author list (primary + co-authors) for a blog post.
// Tenant-scoped via the request host; read-only and public-safe. Used by the
// article editor to rehydrate the co-author selectors and by the authenticated
// article view to render an author card per author.
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

  const blogPostId = req.query.blog_post_id || req.query.article_id;
  if (!blogPostId) {
    return res.status(400).json({ error: 'blog_post_id is required' });
  }

  try {
    const tenant = await resolveTenantFromRequest(req);

    const { data: post, error: postError } = await supabase
      .from('blog_post')
      .select('id, tenant_id, author_id, guest_writer_id')
      .eq('id', blogPostId)
      .single();

    if (postError || !post) {
      return res.status(404).json({ error: 'Article not found' });
    }

    // Tenant isolation: only serve authors for posts in the resolved tenant.
    if (tenant?.id && post.tenant_id && post.tenant_id !== tenant.id) {
      return res.status(404).json({ error: 'Article not found' });
    }

    const authors = await resolveBlogPostAuthors(supabase, post);
    return res.json({ authors });
  } catch (error) {
    console.error('[Article Authors] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch authors' });
  }
}
