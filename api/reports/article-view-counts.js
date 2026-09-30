import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { tenantId } = tenantContext;
    const pageSize = 1000;

    let articleIds = [];
    let from = 0;
    while (true) {
      const { data: batch, error: postsError } = await supabase
        .from('blog_post')
        .select('id')
        .eq('tenant_id', tenantId)
        .range(from, from + pageSize - 1);

      if (postsError) {
        console.error('Error fetching tenant blog posts:', postsError);
        return res.status(500).json({ error: 'Failed to fetch tenant articles' });
      }
      if (!batch || batch.length === 0) break;
      articleIds = articleIds.concat(batch.map(p => p.id));
      if (batch.length < pageSize) break;
      from += pageSize;
    }

    if (articleIds.length === 0) {
      return res.status(200).json({ counts: {} });
    }

    const chunkSize = 200;
    let allViewRecords = [];

    for (let c = 0; c < articleIds.length; c += chunkSize) {
      const idChunk = articleIds.slice(c, c + chunkSize);
      let viewFrom = 0;
      while (true) {
        const { data: page, error: pageErr } = await supabase
          .from('article_view')
          .select('article_id, user_identifier')
          .in('article_id', idChunk)
          .range(viewFrom, viewFrom + pageSize - 1);

        if (pageErr) {
          console.error('Error fetching view records:', pageErr);
          break;
        }
        if (!page || page.length === 0) break;
        allViewRecords = allViewRecords.concat(page);
        if (page.length < pageSize) break;
        viewFrom += pageSize;
      }
    }

    const counts = {};
    const seen = {};
    for (const v of allViewRecords) {
      const key = `${v.article_id}::${v.user_identifier}`;
      if (!seen[key]) {
        seen[key] = true;
        counts[v.article_id] = (counts[v.article_id] || 0) + 1;
      }
    }

    return res.status(200).json({ counts });
  } catch (error) {
    console.error('Error in article-view-counts:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
