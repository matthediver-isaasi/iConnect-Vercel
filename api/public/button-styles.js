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

    const { data: buttonStyles, error } = await supabase
      .from('button_style')
      .select(`
        id,
        name,
        is_active,
        background_color,
        text_color,
        border_color,
        border_width,
        border_radius,
        hover_background_color,
        hover_text_color,
        hover_border_color,
        font_family,
        font_weight,
        letter_spacing,
        padding_x,
        padding_y
      `)
      .eq('tenant_id', tenant.id)
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (error) {
      console.error('[Public ButtonStyles] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch button styles' });
    }

    return res.status(200).json(buttonStyles || []);
  } catch (error) {
    console.error('[Public ButtonStyles] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
