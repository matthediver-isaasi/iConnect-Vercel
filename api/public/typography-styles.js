import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { resolveMicrositeByPrefix } from '../_lib/microsites.js';
import { resolveScopedTypographyStyles } from '../_lib/typographyScope.js';

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
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Task #2572: microsite scope. `?microsite=prefix` returns that microsite's
    // styles alongside the main-site styles, with the effective default per
    // style_type resolved to the microsite default when set, else the main-site
    // default. Without it, only main-site (microsite_id IS NULL) styles apply.
    let micrositeId = null;
    const micrositePrefix = typeof req.query.microsite === 'string' ? req.query.microsite.trim() : '';
    if (micrositePrefix) {
      const microsite = await resolveMicrositeByPrefix(supabase, tenant.id, micrositePrefix);
      micrositeId = microsite?.id || null;
    }

    const { data: styles, error } = await supabase
      .from('typography_style')
      .select(`
        id,
        name,
        style_type,
        font_family,
        font_size,
        font_size_tablet,
        font_size_mobile,
        font_weight,
        line_height,
        line_height_tablet,
        line_height_mobile,
        letter_spacing,
        letter_spacing_tablet,
        letter_spacing_mobile,
        text_transform,
        color,
        margin_bottom,
        margin_bottom_tablet,
        margin_bottom_mobile,
        is_default,
        is_active,
        microsite_id
      `)
      .eq('tenant_id', tenant.id)
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (error) {
      console.error('[Public Typography] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch typography styles' });
    }

    return res.status(200).json(resolveScopedTypographyStyles(styles, micrositeId));
  } catch (error) {
    console.error('[Public Typography] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
