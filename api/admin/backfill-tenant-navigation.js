import { supabase } from '../_lib/database.js';
import { getSessionTenantUser } from '../_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
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
    const { targetTenantId, sourceTenantId, updateNull = true } = req.body;
    
    if (!targetTenantId) {
      return res.status(400).json({ error: 'targetTenantId is required' });
    }

    const { data: tenant } = await supabase
      .from('tenant')
      .select('id, name, slug')
      .eq('id', targetTenantId)
      .single();

    if (!tenant) {
      return res.status(404).json({ error: 'Target tenant not found' });
    }

    const results = {
      targetTenant: tenant.name,
      sourceTenantId: sourceTenantId || 'null',
      updated: {}
    };

    const navigationTables = [
      'portal_navigation_item',
      'portal_menu',
      'navigation_item'
    ];

    for (const table of navigationTables) {
      let query = supabase.from(table).select('id');
      
      if (sourceTenantId) {
        query = query.eq('tenant_id', sourceTenantId);
      } else if (updateNull) {
        query = query.is('tenant_id', null);
      } else {
        results.updated[table] = { count: 0, message: 'No source specified' };
        continue;
      }
      
      const { data: records, error: queryError } = await query;

      if (queryError) {
        console.error(`Error querying ${table}:`, queryError);
        results.updated[table] = { error: queryError.message };
        continue;
      }

      if (records && records.length > 0) {
        const ids = records.map(r => r.id);
        
        const { error } = await supabase
          .from(table)
          .update({ tenant_id: targetTenantId })
          .in('id', ids);

        if (error) {
          console.error(`Error updating ${table}:`, error);
          results.updated[table] = { error: error.message };
        } else {
          results.updated[table] = { count: ids.length };
        }
      } else {
        results.updated[table] = { count: 0, message: 'No matching records found' };
      }
    }

    return res.status(200).json(results);

  } catch (error) {
    console.error('[Backfill Navigation] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
