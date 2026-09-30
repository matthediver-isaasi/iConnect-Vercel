import { supabase } from '../../_lib/database.js';
import { getSessionPlatformOwner } from '../../_lib/platformSession.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const owner = await getSessionPlatformOwner(req);
  if (!owner) {
    return res.status(401).json({ error: 'Platform owner authentication required' });
  }

  try {
    const { data: tenants, error } = await supabase
      .from('tenant')
      .select(`
        id,
        name,
        slug,
        created_at,
        subscription_status,
        settings
      `)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[Platform Tenants] Error fetching tenants:', error);
      return res.status(500).json({ error: 'Failed to fetch tenants' });
    }

    const tenantsWithCounts = await Promise.all(
      (tenants || []).map(async (tenant) => {
        const { count: orgCount } = await supabase
          .from('organization')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenant.id);

        const demoSeed = tenant.settings?.demo_seed || null;
        const { settings, ...rest } = tenant;
        return {
          ...rest,
          organization_count: orgCount || 0,
          // Platform-console-only demo marker (never exposed to tenant members)
          is_demo: !!demoSeed,
          demo_seed_key: demoSeed?.key || null
        };
      })
    );

    return res.status(200).json({ tenants: tenantsWithCounts });

  } catch (error) {
    console.error('[Platform Tenants] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
