import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { resolveMicrositeByPrefix, isMissingMicrositeSchema } from '../_lib/microsites.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[Public Navigation] Missing Supabase credentials');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Task #2426: microsite-scoped navigation. `?microsite=prefix` returns
    // ONLY that microsite's nav; the default request must NEVER include
    // microsite-scoped rows (they'd leak into the tenant-wide chrome).
    const micrositePrefix = typeof req.query.microsite === 'string' ? req.query.microsite.trim() : '';
    let micrositeId = null;
    if (micrositePrefix) {
      const microsite = await resolveMicrositeByPrefix(supabase, tenant.id, micrositePrefix);
      if (!microsite) {
        return res.status(404).json({ error: 'Microsite not found' });
      }
      micrositeId = microsite.id;
    }

    // Note: navigation_item uses 'title' not 'label' column
    const NAV_COLUMNS = `
        id,
        title,
        url,
        location,
        display_order,
        is_active,
        parent_id,
        open_in_new_tab,
        icon,
        link_type,
        form_slug,
        display_type,
        button_style,
        highlight_style,
        footer_column,
        content_block_type,
        description,
        typography_style_id,
        font_size_override,
        include_outside_microsite
      `;

    const buildQuery = (scoped) => {
      let q = supabase
        .from('navigation_item')
        .select(NAV_COLUMNS)
        .eq('tenant_id', tenant.id)
        .eq('is_active', true);
      if (scoped) {
        q = micrositeId ? q.eq('microsite_id', micrositeId) : q.is('microsite_id', null);
      }
      return q.order('display_order', { ascending: true });
    };

    let { data: items, error } = await buildQuery(true);

    // Legacy tolerance: databases without the microsite_id column (42703)
    // can't have microsite rows, so the unscoped query is safe there.
    if (error && isMissingMicrositeSchema(error) && !micrositeId) {
      ({ data: items, error } = await buildQuery(false));
    }

    if (error) {
      console.error('[Public Navigation] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch navigation items' });
    }

    // Transform to match expected frontend shape (label instead of title)
    const transformedItems = (items || []).map(item => ({
      ...item,
      label: item.title
    }));

    return res.status(200).json(transformedItems);
  } catch (error) {
    console.error('[Public Navigation] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
