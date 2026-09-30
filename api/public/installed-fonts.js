import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

// Public read of a tenant's active installed fonts. Mirrors
// api/public/typography-styles.js so public pages + dropdowns can load the
// tenant's fonts without authentication. Task #2549.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[Public InstalledFonts] Missing Supabase credentials');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: fonts, error } = await supabase
      .from('installed_font')
      .select('id, label, font_stack, google_family, source, is_base, is_active')
      .eq('tenant_id', tenant.id)
      .eq('is_active', true)
      .order('label', { ascending: true });

    if (error) {
      console.error('[Public InstalledFonts] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch installed fonts' });
    }

    return res.status(200).json(fonts || []);
  } catch (error) {
    console.error('[Public InstalledFonts] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
