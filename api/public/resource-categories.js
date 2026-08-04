import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { fetchCategoriesWithAccess, filterCategoriesForViewer, filterCategorySubcategoriesForViewer, stripCategoryAccessFields } from '../_lib/resourceCategoryAccess.js';

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

    let data;
    try {
      data = await fetchCategoriesWithAccess(supabase, tenant.id);
    } catch (error) {
      console.error('Error fetching resource categories:', error);
      return res.status(500).json({ error: error.message });
    }

    // Task #3306: role-restricted categories are member-only — never expose
    // them (or their role lists) to guests. Unrestricted categories behave
    // exactly as before.
    // Task #3320: subcategories with any role exclusions are member-only too —
    // drop them from the guest view and strip both access-control fields.
    const guest = { isGuest: true };
    const visible = filterCategoriesForViewer(
      (data || []).filter((c) => c.is_active !== false),
      guest
    ).map((c) => stripCategoryAccessFields(filterCategorySubcategoriesForViewer(c, guest)));

    return res.json(visible);
  } catch (error) {
    console.error('Public resource categories fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch resource categories' });
  }
}
