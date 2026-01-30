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
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[Public Typography] Missing Supabase credentials');
    return res.status(500).json({ error: 'Server configuration error' });
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

    const { data: styles, error } = await supabase
      .from('typography_style')
      .select(`
        id,
        name,
        style_type,
        font_family,
        font_size,
        font_size_mobile,
        font_weight,
        line_height,
        letter_spacing,
        text_transform,
        color,
        margin_bottom,
        is_default,
        is_active
      `)
      .eq('tenant_id', tenant.id)
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (error) {
      console.error('[Public Typography] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch typography styles' });
    }

    return res.status(200).json(styles || []);
  } catch (error) {
    console.error('[Public Typography] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
