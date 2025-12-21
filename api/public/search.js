import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { q, limit = '20' } = req.query;
    
    if (!q || q.trim().length < 2) {
      return res.json({ results: [], query: q || '', total: 0 });
    }

    const searchTerm = q.trim();
    const searchPattern = `%${searchTerm}%`;
    const limitNum = Math.min(parseInt(limit) || 20, 50);

    const results = [];

    const [eventsResult, articlesResult, newsResult, resourcesResult, pagesResult] = await Promise.all([
      supabase
        .from('event')
        .select('id, title, description, start_date, end_date, image_url, status')
        .or(`title.ilike.${searchPattern},description.ilike.${searchPattern}`)
        .gte('start_date', new Date().toISOString())
        .limit(limitNum),
      
      supabase
        .from('blog_post')
        .select('id, title, summary, feature_image_url, published_date, slug')
        .or(`title.ilike.${searchPattern},summary.ilike.${searchPattern}`)
        .eq('status', 'published')
        .limit(limitNum),
      
      supabase
        .from('news_post')
        .select('id, title, summary, feature_image_url, published_date, slug')
        .or(`title.ilike.${searchPattern},summary.ilike.${searchPattern}`)
        .eq('status', 'published')
        .limit(limitNum),
      
      supabase
        .from('resource')
        .select('id, title, description, thumbnail_url, content_type')
        .or(`title.ilike.${searchPattern},description.ilike.${searchPattern}`)
        .eq('status', 'active')
        .limit(limitNum),
      
      supabase
        .from('i_edit_page')
        .select('id, title, slug, description, published_at')
        .or(`title.ilike.${searchPattern},description.ilike.${searchPattern},slug.ilike.${searchPattern}`)
        .eq('status', 'published')
        .limit(limitNum)
    ]);

    if (eventsResult.data) {
      eventsResult.data.forEach(event => {
        results.push({
          type: 'event',
          id: event.id,
          title: event.title,
          description: event.description?.substring(0, 150) || '',
          image: event.image_url,
          url: `/EventDetails?id=${event.id}`,
          date: event.start_date
        });
      });
    }

    if (articlesResult.data) {
      articlesResult.data.forEach(article => {
        results.push({
          type: 'article',
          id: article.id,
          title: article.title,
          description: article.summary?.substring(0, 150) || '',
          image: article.feature_image_url,
          url: `/ArticleView?slug=${article.slug || article.id}`,
          date: article.published_date
        });
      });
    }

    if (newsResult.data) {
      newsResult.data.forEach(news => {
        results.push({
          type: 'news',
          id: news.id,
          title: news.title,
          description: news.summary?.substring(0, 150) || '',
          image: news.feature_image_url,
          url: `/NewsView?slug=${news.slug || news.id}`,
          date: news.published_date
        });
      });
    }

    if (resourcesResult.data) {
      resourcesResult.data.forEach(resource => {
        results.push({
          type: 'resource',
          id: resource.id,
          title: resource.title,
          description: resource.description?.substring(0, 150) || '',
          image: resource.thumbnail_url,
          url: `/resources/${resource.id}`,
          date: null
        });
      });
    }

    if (pagesResult.data) {
      pagesResult.data.forEach(page => {
        results.push({
          type: 'page',
          id: page.id,
          title: page.title,
          description: page.description,
          image: null,
          url: `/${page.slug}`,
          date: page.published_at
        });
      });
    }

    results.sort((a, b) => {
      if (a.date && b.date) {
        return new Date(b.date) - new Date(a.date);
      }
      if (a.date) return -1;
      if (b.date) return 1;
      return 0;
    });

    return res.json({
      results: results.slice(0, limitNum),
      query: searchTerm,
      total: results.length
    });

  } catch (error) {
    console.error('Search error:', error);
    return res.status(500).json({ error: 'Search failed' });
  }
}
