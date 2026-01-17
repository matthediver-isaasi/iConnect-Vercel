import { createClient } from '@supabase/supabase-js';

function getTenantSlugFromHost(host) {
  if (!host) return null;
  const hostname = host.split(':')[0];
  const parts = hostname.split('.');
  if (parts.length >= 2) {
    return parts[0];
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
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const tenantSlug = req.query.tenant || getTenantSlugFromHost(host);

    if (!tenantSlug) {
      return res.status(400).json({ error: 'Tenant not specified' });
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

    const { data: settings } = await supabase
      .from('system_settings')
      .select('setting_key, setting_value')
      .eq('tenant_id', tenant.id)
      .in('setting_key', [
        'article_allow_public_comments',
        'article_show_author_bio',
        'article_show_about_author_label',
        'article_show_author_photo',
        'article_show_thumbs_up',
        'article_show_thumbs_down',
        'article_display_name'
      ]);

    const settingsMap = {};
    if (settings) {
      settings.forEach(s => {
        settingsMap[s.setting_key] = s.setting_value;
      });
    }

    res.json({
      allowPublicComments: settingsMap['article_allow_public_comments'] === 'true',
      showAuthorBio: settingsMap['article_show_author_bio'] !== 'false',
      showAboutAuthorLabel: settingsMap['article_show_about_author_label'] !== 'false',
      showAuthorPhoto: settingsMap['article_show_author_photo'] !== 'false',
      showThumbsUp: settingsMap['article_show_thumbs_up'] !== 'false',
      showThumbsDown: settingsMap['article_show_thumbs_down'] !== 'false',
      displayName: settingsMap['article_display_name'] || 'Articles'
    });
  } catch (error) {
    console.error('[Public Article Settings] Error:', error);
    res.status(500).json({ error: 'Failed to fetch article settings' });
  }
}
