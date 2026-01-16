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

    console.log('[Public NewsPost] Query params:', {
      tenantId: tenant.id,
      tenantSlug,
      newsId,
      newsSlug,
      now
    });

    // Debug: Check if post exists without filters (server-side logging only)
    let debugQuery = supabase
      .from('news_post')
      .select('id, slug, status, published_date')
      .eq('tenant_id', tenant.id);
    
    if (newsId) {
      debugQuery = debugQuery.eq('id', newsId);
    } else if (newsSlug) {
      debugQuery = debugQuery.eq('slug', newsSlug);
    }
    
    const { data: debugPost } = await debugQuery.maybeSingle();
    
    if (debugPost) {
      console.log('[Public NewsPost] Post found in DB (pre-filter):', {
        id: debugPost.id,
        slug: debugPost.slug,
        status: debugPost.status,
        published_date: debugPost.published_date,
        statusMatch: debugPost.status === 'published',
        dateMatch: !debugPost.published_date || debugPost.published_date <= now
      });
    } else {
      console.log('[Public NewsPost] Post not found in DB for tenant/slug');
    }

    // Production query with proper security filters
    // Select only columns that exist in the news_post table (verified from schema)
    // Note: share_password is intentionally excluded from public API for security
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
        status,
        tags,
        published_date,
        subcategories,
        feature_image_url,
        seo_title,
        seo_description,
        tenant_id
      `)
      .eq('tenant_id', tenant.id)
      .eq('status', 'published');

    if (newsId) {
      query = query.eq('id', newsId);
    } else if (newsSlug) {
      query = query.eq('slug', newsSlug);
    }

    const { data: newsPost, error } = await query.single();

    if (error || !newsPost) {
      // Log detailed info server-side for debugging
      console.log('[Public NewsPost] Query failed:', {
        error: error?.message || 'No error message',
        errorCode: error?.code,
        errorDetails: error?.details,
        errorHint: error?.hint,
        hasData: !!newsPost,
        debugPostExists: !!debugPost,
        debugStatus: debugPost?.status
      });
      return res.status(404).json({ error: 'News post not found' });
    }
    
    // Check published_date in JavaScript to avoid Supabase query encoding issues
    // Post is accessible if: no published_date set OR published_date is in the past
    if (newsPost.published_date && new Date(newsPost.published_date) > new Date(now)) {
      console.log('[Public NewsPost] Post has future published_date, blocking access:', {
        published_date: newsPost.published_date,
        now
      });
      return res.status(404).json({ error: 'News post not found' });
    }

    return res.status(200).json(newsPost);
  } catch (error) {
    console.error('[Public NewsPost] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
