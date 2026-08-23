import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { fetchCategoriesWithAccess, computeHiddenSubcategories, filterResourcesByCategoryAccess } from '../_lib/resourceCategoryAccess.js';
import { projectPublicResourceAccess } from '../_lib/publicResourceProjection.js';

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

    // Task #3220: PostgREST caps un-paginated selects at 1000 rows, so tenants
    // with >1000 resources saw exactly 1000. Page through in batches with a
    // deterministic order (release_date desc, id asc as a unique tiebreaker)
    // so no rows are skipped or duplicated across page boundaries.
    const BATCH_SIZE = 1000;
    const resources = [];
    let offset = 0;
    for (;;) {
      const { data: batch, error } = await supabase
        .from('resource')
        .select(`
          id,
          title,
          description,
          image_url,
          target_url,
          resource_type,
          release_date,
          author_name,
          subcategories,
          tags,
          is_public,
          open_in_new_tab,
          allowed_role_ids,
          linked_events
        `)
        .eq('tenant_id', tenant.id)
        .eq('status', 'active')
        .is('member_group_id', null)
        .order('release_date', { ascending: false })
        .order('id', { ascending: true })
        .range(offset, offset + BATCH_SIZE - 1);

      if (error) {
        console.error('[Public Resources] Query error:', error);
        return res.status(500).json({ error: 'Failed to fetch resources' });
      }

      resources.push(...(batch || []));
      if (!batch || batch.length < BATCH_SIZE) break;
      offset += batch.length;
    }

    // Task #3306: resources exclusively tagged with subcategories of
    // role-restricted categories are member-only — hide them from guests.
    // Categories with no restrictions leave everything exactly as before.
    let guestHiddenSubcats = new Set();
    try {
      const cats = await fetchCategoriesWithAccess(supabase, tenant.id);
      guestHiddenSubcats = computeHiddenSubcategories(cats, { isGuest: true });
    } catch (catErr) {
      console.error('[Public Resources] Failed to load category access:', catErr?.message);
      // Fail closed is not possible without the category list; log and continue
      // (matches pre-existing behaviour when the column is absent).
    }

    const tenant_domain = tenant.domain || `${tenant.slug}.iconn.app`;
    const publicResources = filterResourcesByCategoryAccess(resources || [], guestHiddenSubcats).filter(r => {
      if (r.linked_events && Array.isArray(r.linked_events) && r.linked_events.length > 0) {
        return false;
      }
      return true;
    }).map((resource) => projectPublicResourceAccess(resource, tenant_domain));

    res.json(publicResources);
  } catch (error) {
    console.error('[Public Resources] Error:', error);
    res.status(500).json({ error: 'Failed to fetch resources' });
  }
}
