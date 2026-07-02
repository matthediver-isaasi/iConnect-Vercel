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
  const { campaignId, preview, scheduledAt, targetType, targetIds, targetAudiences, previewList, communicationCategoryId } = req.body;

  if (preview === true && campaignId === 'preview') {
    const fakeCampaign = {};
    if (Array.isArray(targetAudiences) && targetAudiences.length > 0) {
      fakeCampaign.target_audiences = targetAudiences;
    } else {
      fakeCampaign.target_type = targetType || 'all_members';
      fakeCampaign.target_ids = targetIds || [];
    }
    if (communicationCategoryId) {
      fakeCampaign.communication_category_id = communicationCategoryId;
    }
    
    const recipientsResult = await getTargetRecipients(fakeCampaign, tenantId, false, previewList === true);
    if (!recipientsResult.success) {
      return res.status(500).json({ error: recipientsResult.error });
    }

    const mapRecipient = r => ({
      email: r.email,
      firstName: r.first_name,
      lastName: r.last_name
    });

    const response = {
      success: true,
      preview: true,
      recipientCount: recipientsResult.recipients.length,
      stats: recipientsResult.stats || null,
    };

    if (previewList === true) {
      response.recipients = recipientsResult.recipients.map(mapRecipient);
      if (recipientsResult.detailedLists) {
        response.detailedLists = {
          audience: (recipientsResult.detailedLists.audience || []).map(mapRecipient),
          globalOptOuts: (recipientsResult.detailedLists.globalOptOuts || []).map(mapRecipient),
          categoryOptOuts: (recipientsResult.detailedLists.categoryOptOuts || []).map(mapRecipient),
        };
      }
    }

    return res.json(response);
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

  // Send immediately. Plan quota enforcement lives inside sendCampaign() so
  // this same gate also covers scheduled sends executed by the cron.
  const requestHost = getHostFromRequest(req);
  const result = await sendCampaign(campaignId, tenantId, requestHost);

  if (!result.success) {
    if (result.quota) {
      return res.status(402).json({ error: result.error, code: 'PLAN_QUOTA_EXCEEDED', quota: result.quota });
    }
    return res.status(500).json({ error: result.error });
  }

  return res.json(result);
}
