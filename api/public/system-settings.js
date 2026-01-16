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

const PUBLIC_SETTINGS_WHITELIST = [
  'page_visibility',
  'articles_slug',
  'articles_public_slug',
  'articles_view_slug',
  'articles_my_slug',
  'articles_editor_slug',
  'button_styles_enabled',
  'border_radius',
  'portal_logo',
  'search_enabled',
  'event_booking_terms',
  'speaker_module_name',
  'newsletter_form_id',
  'floater_config',
  'article_display_name',
  'social_icons_config',
  'footer_config',
  'newsletter_signup_form_id'
];

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

  const supabaseUrl = process.env.DEV_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;

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

    const { key } = req.query;

    // Note: system_settings table is global (no tenant_id column)
    // Filter by whitelist to only expose safe settings publicly
    let query = supabase
      .from('system_settings')
      .select('id, setting_key, setting_value');

    if (key) {
      if (!PUBLIC_SETTINGS_WHITELIST.includes(key)) {
        return res.status(403).json({ error: 'Setting not accessible publicly' });
      }
      query = query.eq('setting_key', key);
    } else {
      query = query.in('setting_key', PUBLIC_SETTINGS_WHITELIST);
    }

    const { data: settings, error } = await query;

    if (error) {
      console.error('[Public SystemSettings] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch settings' });
    }

    return res.status(200).json(settings || []);
  } catch (error) {
    console.error('[Public SystemSettings] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
