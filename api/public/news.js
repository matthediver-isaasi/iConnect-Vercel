import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

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
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const now = new Date().toISOString();

    const { data: news, error } = await supabase
      .from('news_post')
      .select(`
        id,
        title,
        slug,
        summary,
        feature_image_url,
        published_date,
        status,
        subcategories,
        tags
      `)
      .eq('tenant_id', tenant.id)
      .eq('status', 'published')
      .lte('published_date', now)
      .order('published_date', { ascending: false });

    if (error) {
      console.error('[Public News] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch news' });
    }

    res.json(news || []);
  } catch (error) {
    console.error('[Public News] Error:', error);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
}
