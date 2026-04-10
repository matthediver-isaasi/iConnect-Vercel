import { getTenantContext } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';
import { getTargetRecipients } from '../_lib/campaignService.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }

  const { tenantId } = tenantContext;
  const { listId } = req.body;

  if (!listId) {
    return res.status(400).json({ error: 'listId is required' });
  }

  try {
    const { data: list, error } = await supabase
      .from('audience_list')
      .select('id, name, target_audiences')
      .eq('id', listId)
      .eq('tenant_id', tenantId)
      .single();

    if (error || !list) {
      return res.status(404).json({ error: 'Audience list not found' });
    }

    const fakeCampaign = {
      target_audiences: list.target_audiences || []
    };

    const result = await getTargetRecipients(fakeCampaign, tenantId, false, false);

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    const seen = new Set();
    const uniqueRecipients = [];
    for (const r of result.recipients) {
      if (!r.email) continue;
      const key = r.email.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        uniqueRecipients.push({
          email: r.email,
          first_name: r.first_name || '',
          last_name: r.last_name || ''
        });
      }
    }

    uniqueRecipients.sort((a, b) => {
      const nameA = `${a.last_name} ${a.first_name}`.toLowerCase();
      const nameB = `${b.last_name} ${b.first_name}`.toLowerCase();
      return nameA.localeCompare(nameB);
    });

    return res.json({
      success: true,
      listName: list.name,
      totalCount: uniqueRecipients.length,
      recipients: uniqueRecipients
    });
  } catch (err) {
    console.error('[AudienceListPreview] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
