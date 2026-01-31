import { getTenantContext } from '../_lib/tenantContext.js';
import { getCampaigns, createCampaign } from '../_lib/campaignService.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }

  const { tenantId, memberId } = tenantContext;

  if (req.method === 'GET') {
    const { status, limit } = req.query;
    const result = await getCampaigns(tenantId, { 
      status, 
      limit: limit ? parseInt(limit, 10) : undefined 
    });

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    return res.json(result.campaigns);
  }

  if (req.method === 'POST') {
    const campaignData = req.body;

    if (!campaignData.name || !campaignData.subject) {
      return res.status(400).json({ error: 'Name and subject are required' });
    }

    const result = await createCampaign(campaignData, tenantId, memberId);

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    return res.status(201).json(result.campaign);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
