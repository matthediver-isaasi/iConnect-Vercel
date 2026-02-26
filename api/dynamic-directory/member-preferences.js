import { getTenantContext } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }

  const { tenantId } = tenantContext;
  const { member_ids, field_ids } = req.query;

  if (!member_ids) {
    return res.json([]);
  }

  const memberIdList = member_ids.split(',').filter(Boolean);
  if (memberIdList.length === 0) {
    return res.json([]);
  }

  try {
    const allPreferences = [];
    const batchSize = 200;

    for (let i = 0; i < memberIdList.length; i += batchSize) {
      const batch = memberIdList.slice(i, i + batchSize);

      let query = supabase
        .from('member_preference_value')
        .select('id, member_id, preference_field_id, value, tenant_id')
        .eq('tenant_id', tenantId)
        .in('member_id', batch);

      if (field_ids) {
        const fieldIdList = field_ids.split(',').filter(Boolean);
        if (fieldIdList.length > 0) {
          query = query.in('preference_field_id', fieldIdList);
        }
      }

      const { data, error } = await query;

      if (error) {
        console.error('[DynamicDirectory MemberPreferences] Batch error:', error);
        continue;
      }

      if (data) {
        allPreferences.push(...data);
      }
    }

    return res.json(allPreferences);
  } catch (err) {
    console.error('[DynamicDirectory MemberPreferences] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch member preferences' });
  }
}
