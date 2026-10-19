import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { getCampaigns, createCampaign } from '../_lib/campaignService.js';
import { supabase } from '../_lib/database.js';
import { campaignSummary, campaignLifecycleReady } from '../_lib/campaignLifecycle.js';

export default async function handler(req, res) {
  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }

  const { tenantId, memberId } = tenantContext;

  if (req.method === 'GET') {
    const { status, limit, archive } = req.query;
    if (!tenantContext.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
    if (tenantContext.tenantMismatch || !await hasAdminAccess(tenantContext)) {
      return res.status(403).json({ error: 'Tenant administrator access required' });
    }
    if (req.query.lifecycle === 'ready') {
      const result = await campaignLifecycleReady(supabase);
      return res.status(result.success ? 200 : result.statusCode || 503).json(result);
    }
    if (req.query.summary === 'true') {
      const result = await campaignSummary(supabase, tenantId);
      return res.status(result.success ? 200 : result.statusCode || 500).json(result.success ? result.summary : result);
    }
    if (archive && !['active', 'archived', 'all'].includes(archive)) {
      return res.status(400).json({ error: 'Invalid archive filter' });
    }
    const parsedLimit = limit == null ? undefined : Number(limit);
    if (parsedLimit != null && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1)) {
      return res.status(400).json({ error: 'Invalid campaign limit' });
    }
    const result = await getCampaigns(tenantId, { 
      status, archive,
      limit: parsedLimit,
    });

    if (!result.success) {
      return res.status(result.code === 'AUDIENCE_LIST_REPLACEMENT_REQUIRED' ? 400 : 500)
        .json({ error: result.error, code: result.code });
    }

    return res.json(result.campaigns);
  }

  if (req.method === 'POST') {
    const campaignData = req.body;

    if (!campaignData.name || !campaignData.subject) {
      return res.status(400).json({ error: 'Name and subject are required' });
    }

    if (campaignData.target_type === 'all_members') {
      return res.status(400).json({ error: 'Setting target_type to all_members is not allowed. Please select a specific audience.' });
    }
    if (Array.isArray(campaignData.target_audiences)) {
      for (const seg of campaignData.target_audiences) {
        if (seg.type === 'all_members') {
          return res.status(400).json({ error: 'Audience segment type all_members is not allowed. Please select a specific audience.' });
        }
      }
    }

    const result = await createCampaign(campaignData, tenantId, memberId);

    if (!result.success) {
      return res.status(result.code === 'AUDIENCE_LIST_REPLACEMENT_REQUIRED' ? 400 : 500)
        .json({ error: result.error, code: result.code });
    }

    return res.status(201).json(result.campaign);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
