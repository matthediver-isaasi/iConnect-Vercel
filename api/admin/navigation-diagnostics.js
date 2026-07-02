import { supabase } from '../_lib/database.js';
import { getSessionMember, getSessionTenantUser } from '../_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser) {
    return res.status(403).json({ error: 'SaaS admin access required' });
  }

  try {
    const results = {
      tenants: [],
      navigation: {}
    };

    const { data: tenants } = await supabase
      .from('tenant')
      .select('id, name, slug');
    
    results.tenants = tenants || [];

    const navigationTables = [
      { table: 'portal_navigation_item', nameCol: 'label' },
      { table: 'portal_menu', nameCol: 'name' },
      { table: 'navigation_item', nameCol: 'label' }
    ];

    for (const { table, nameCol } of navigationTables) {
      try {
        const { data: records, error } = await supabase
          .from(table)
          .select(`id, ${nameCol}, tenant_id`);

        if (error) {
          results.navigation[table] = { error: error.message };
          continue;
        }

        const byTenant = {};
        for (const record of (records || [])) {
          const tid = record.tenant_id || 'null';
          if (!byTenant[tid]) {
            byTenant[tid] = [];
          }
          byTenant[tid].push({
            id: record.id,
            name: record[nameCol]
          });
        }

        results.navigation[table] = {
          total: records?.length || 0,
          byTenantId: byTenant
        };
      } catch (e) {
        results.navigation[table] = { error: e.message };
      }
    }

    return res.status(200).json(results);

  } catch (error) {
    console.error('[Navigation Diagnostics] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
