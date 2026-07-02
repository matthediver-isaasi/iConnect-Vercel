import { getTenantContext } from '../_lib/tenantContext.js';
import { getCampaign, updateCampaign, deleteCampaign, duplicateCampaign, cancelCampaign, pauseCampaign, resumeCampaign, getCampaignStats, getClickHeatmapData, getCampaignRecipients } from '../_lib/campaignService.js';

export default async function handler(req, res) {
  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }

  const { tenantId } = tenantContext;
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Campaign ID required' });
  }

  if (req.method === 'GET') {
    const { stats, heatmap } = req.query;

    if (stats === 'true') {
      const result = await getCampaignStats(id, tenantId);
      if (!result.success) {
        return res.status(500).json({ error: result.error });
      }
      return res.json(result);
    }

    if (heatmap === 'true') {
      const result = await getClickHeatmapData(id, tenantId);
      if (!result.success) {
        return res.status(500).json({ error: result.error });
      }
      return res.json(result);
    }

    if (req.query.recipients === 'true') {
      const result = await getCampaignRecipients(id, tenantId);
      if (!result.success) {
        return res.status(500).json({ error: result.error });
      }
      return res.json(result);
    }

    const result = await getCampaign(id, tenantId);
    if (!result.success) {
      return res.status(result.error === 'Campaign not found' ? 404 : 500).json({ error: result.error });
    }

    return res.json(result.campaign);
  }

  if (req.method === 'POST') {
    const { action } = req.body || {};
    if (action === 'duplicate') {
      const result = await duplicateCampaign(id, tenantId, tenantContext.memberId);
      if (!result.success) {
        return res.status(500).json({ error: result.error });
      }
      return res.status(201).json(result.campaign);
    }
    if (action === 'cancel') {
      if (!tenantContext.memberId) {
        return res.status(401).json({ error: 'Authentication required to cancel a campaign' });
      }
      const result = await cancelCampaign(id, tenantId, tenantContext.memberId);
      if (!result.success) {
        const statusCode = result.error?.includes('Cannot cancel') || result.error?.includes('already changed') ? 400 : result.error?.includes('not found') ? 404 : 500;
        return res.status(statusCode).json({ error: result.error });
      }
      return res.json(result);
    }
    if (action === 'pause') {
      if (!tenantContext.memberId) {
        return res.status(401).json({ error: 'Authentication required to pause a campaign' });
      }
      const result = await pauseCampaign(id, tenantId, tenantContext.memberId);
      if (!result.success) {
        const statusCode = result.error?.includes('Cannot pause') || result.error?.includes('changed before') ? 400 : result.error?.includes('not found') ? 404 : 500;
        return res.status(statusCode).json({ error: result.error });
      }
      return res.json(result);
    }
    if (action === 'resume') {
      if (!tenantContext.memberId) {
        return res.status(401).json({ error: 'Authentication required to resume a campaign' });
      }
      const result = await resumeCampaign(id, tenantId, tenantContext.memberId);
      if (!result.success) {
        const statusCode = result.error?.includes('Cannot resume') || result.error?.includes('Nothing to resume') || result.error?.includes('changed before') ? 400 : result.error?.includes('not found') ? 404 : 500;
        return res.status(statusCode).json({ error: result.error });
      }
      return res.json(result);
    }
    return res.status(400).json({ error: 'Invalid action' });
  }

  if (req.method === 'PATCH' || req.method === 'PUT') {
    const updates = req.body;

    if (updates.target_type === 'all_members') {
      return res.status(400).json({ error: 'Setting target_type to all_members is not allowed. Please select a specific audience.' });
    }
    if (Array.isArray(updates.target_audiences)) {
      for (const seg of updates.target_audiences) {
        if (seg.type === 'all_members') {
          return res.status(400).json({ error: 'Audience segment type all_members is not allowed. Please select a specific audience.' });
        }
      }
    }

    const result = await updateCampaign(id, updates, tenantId);

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    return res.json(result.campaign);
  }

  if (req.method === 'DELETE') {
    const result = await deleteCampaign(id, tenantId);

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    return res.json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
