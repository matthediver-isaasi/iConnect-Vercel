import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

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
