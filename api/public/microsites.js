import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { listActiveMicrosites } from '../_lib/microsites.js';

/**
 * Task #2426: public list of a tenant's active microsites.
 * The frontend uses this to recognise /{prefix}/{slug} URLs as microsite
 * routes. Returns only what's needed publicly: prefix, name, logo.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    let tenant = await resolveTenantFromRequest(req);
    if (!tenant && req.query.tenant) {
      const { data } = await supabase
        .from('tenant')
        .select('id, slug, status')
        .eq('slug', req.query.tenant)
        .eq('status', 'active')
        .single();
      tenant = data || null;
    }
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const microsites = await listActiveMicrosites(supabase, tenant.id);

    // Resolve home-page slugs so the frontend can link a microsite's logo to
    // its home page (/{prefix}/{home_slug}).
    const homeIds = microsites.map((m) => m.home_page_id).filter(Boolean);
    const slugById = {};
    if (homeIds.length > 0) {
      const { data: homePages } = await supabase
        .from('i_edit_page')
        .select('id, slug')
        .in('id', homeIds);
      for (const p of homePages || []) slugById[p.id] = p.slug;
    }

    return res.status(200).json({
      success: true,
      microsites: microsites.map((m) => ({
        id: m.id,
        name: m.name,
        path_prefix: m.path_prefix,
        logo_url: m.logo_url || null,
        home_page_id: m.home_page_id || null,
        home_slug: (m.home_page_id && slugById[m.home_page_id]) || null,
      })),
    });
  } catch (error) {
    console.error('[Public Microsites] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch microsites' });
  }
}
