import { createClient } from '@supabase/supabase-js';

function getTenantSlugFromHost(host) {
  if (!host) return null;
  
  const parts = host.split('.');
  if (parts.length >= 2) {
    const subdomain = parts[0];
    if (subdomain && subdomain !== 'www' && subdomain !== 'iconn' && subdomain !== 'localhost') {
      return subdomain;
    }
  }
  return null;
}

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

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[Public NewsPost] Missing Supabase credentials');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const tenantSlug = req.query.tenant || getTenantSlugFromHost(host);
    const newsId = req.query.id;
    const newsSlug = req.query.slug;

    if (!tenantSlug) {
      return res.status(400).json({ error: 'Tenant not specified' });
    }

    if (!newsId && !newsSlug) {
      return res.status(400).json({ error: 'News post ID or slug not specified' });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from('tenant')
      .select('id, name')
      .eq('slug', tenantSlug)
      .eq('status', 'active')
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const now = new Date().toISOString();

    let query = supabase
      .from('news_post')
      .select(`
        id,
        title,
        slug,
        author_id,
        author_name,
        summary,
        content,
        featured_image_url,
        status,
        category,
        tags,
        published_date,
        created_at,
        updated_at,
        is_featured,
        views_count,
        subcategories,
        feature_image_url,
        seo_title,
        seo_description
      `)
      .eq('tenant_id', tenant.id)
      .eq('status', 'published')
      .lte('published_date', now);

    if (newsId) {
      query = query.eq('id', newsId);
    } else if (newsSlug) {
      query = query.eq('slug', newsSlug);
    }

    const { data: newsPost, error } = await query.single();

    if (error || !newsPost) {
      return res.status(404).json({ error: 'News post not found' });
    }

    return res.status(200).json(newsPost);
  } catch (error) {
    console.error('[Public NewsPost] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
