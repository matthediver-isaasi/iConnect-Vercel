import { getTenantContext } from '../_lib/tenantContext.js';
import { sendCampaign, getTargetRecipients, getCampaign, scheduleCampaign } from '../_lib/campaignService.js';
import { getHostFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }

  const { tenantId } = tenantContext;
  const { campaignId, preview, scheduledAt, targetType, targetIds } = req.body;

  // Handle preview for targeting selection (no campaign needed)
  if (preview === true && campaignId === 'preview') {
    const fakeCampaign = {
      target_type: targetType || 'all_members',
      target_ids: targetIds || []
    };
    
    const recipientsResult = await getTargetRecipients(fakeCampaign, tenantId);
    if (!recipientsResult.success) {
      return res.status(500).json({ error: recipientsResult.error });
    }

    return res.json({
      success: true,
      preview: true,
      recipientCount: recipientsResult.recipients.length
    });
  }

  if (!campaignId) {
    return res.status(400).json({ error: 'Campaign ID required' });
  }

  if (preview === true) {
    const campaignResult = await getCampaign(campaignId, tenantId);
    if (!campaignResult.success) {
      return res.status(404).json({ error: campaignResult.error });
    }

    const recipientsResult = await getTargetRecipients(campaignResult.campaign, tenantId);
    if (!recipientsResult.success) {
      return res.status(500).json({ error: recipientsResult.error });
    }

    return res.json({
      success: true,
      preview: true,
      recipientCount: recipientsResult.recipients.length,
      sampleRecipients: recipientsResult.recipients.slice(0, 10).map(r => ({
        email: r.email,
        firstName: r.first_name,
        lastName: r.last_name
      }))
    });
  }

  // Handle scheduling
  if (scheduledAt) {
    const scheduleDate = new Date(scheduledAt);
    if (isNaN(scheduleDate.getTime())) {
      return res.status(400).json({ error: 'Invalid schedule date' });
    }
    if (scheduleDate <= new Date()) {
      return res.status(400).json({ error: 'Schedule date must be in the future' });
    }

    const result = await scheduleCampaign(campaignId, tenantId, scheduleDate);
    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }
    return res.json(result);
  }

  // Send immediately
  const requestHost = getHostFromRequest(req);
  const result = await sendCampaign(campaignId, tenantId, requestHost);

  if (!result.success) {
    return res.status(500).json({ error: result.error });
  }

  return res.json(result);
}
