import { getTenantContext } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';
import { getTargetRecipients } from '../_lib/campaignService.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }

  const { tenantId } = tenantContext;

  try {
    const { data: lists, error } = await supabase
      .from('audience_list')
      .select('id, target_audiences')
      .eq('tenant_id', tenantId);

    if (error) {
      console.error('[AudienceListCounts] Fetch error:', error);
      return res.status(500).json({ error: error.message });
    }

    const counts = {};

    await Promise.all((lists || []).map(async (list) => {
      try {
        const fakeCampaign = { target_audiences: list.target_audiences || [] };
        const result = await getTargetRecipients(fakeCampaign, tenantId, true, false);
        if (result.success) {
          counts[list.id] = result.count;
        }
      } catch (e) {
        console.error('[AudienceListCounts] Failed to resolve count for list', list.id, e.message);
      }
    }));

    return res.json({ success: true, counts });
  } catch (err) {
    console.error('[AudienceListCounts] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
