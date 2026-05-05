import { supabase } from '../_lib/database.js';
import { getCallerEmsAccess, requireGroupAccess } from '../_lib/memberGroupEmsAccess.js';
import { sendCampaign, getTargetRecipients, getCampaign, scheduleCampaign } from '../_lib/campaignService.js';
import { getHostFromRequest } from '../_lib/tenantResolver.js';

/**
 * /api/member-campaigns/send
 *
 * Mirrors the tenant /api/email-campaigns/send contract but locked to a
 * member-owned campaign. Supports:
 *  - body { campaignId: 'preview', preview: true, previewList? }: ad-hoc preview
 *    using a forced { type: 'member_group', id, roles? } segment so members can
 *    see their recipient count before saving.
 *  - body { campaignId, preview: true }: stored-campaign preview.
 *  - body { campaignId, scheduledAt }: schedule a draft.
 *  - body { campaignId }: send immediately.
 *
 * The audience is ALWAYS overridden server-side to the caller's group; the
 * client cannot widen it.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const access = await getCallerEmsAccess(req);
  if (access.error) return res.status(access.status).json({ error: access.error });
  if (access.groups.length === 0) return res.status(403).json({ error: 'You do not have permission to send group emails.' });

  const { campaignId, preview, scheduledAt, previewList, groupId, audienceRoles } = req.body || {};

  // ---- Ad-hoc preview path (no campaign row yet) ----
  if (preview === true && campaignId === 'preview') {
    if (!groupId) return res.status(400).json({ error: 'groupId required for preview' });
    const group = requireGroupAccess(access.groups, groupId);
    if (!group) return res.status(403).json({ error: 'You do not have access to this group.' });

    const segment = { type: 'member_group', ids: [group.groupId] };
    if (Array.isArray(audienceRoles) && audienceRoles.length > 0) {
      const allowed = new Set(group.allRoles || []);
      const filtered = audienceRoles.filter((r) => typeof r === 'string' && allowed.has(r));
      if (filtered.length > 0) segment.roles = filtered;
    }

    const fakeCampaign = { target_audiences: [segment] };
    const result = await getTargetRecipients(fakeCampaign, access.tenantContext.tenantId, false, previewList === true);
    if (!result.success) return res.status(500).json({ error: result.error });

    const mapRecipient = (r) => ({ email: r.email, firstName: r.first_name, lastName: r.last_name });
    const response = {
      success: true,
      preview: true,
      recipientCount: result.recipients.length,
      stats: result.stats || null,
    };
    if (previewList === true) {
      response.recipients = result.recipients.map(mapRecipient);
    }
    return res.json(response);
  }

  if (!campaignId) return res.status(400).json({ error: 'Campaign ID required' });

  // Verify ownership of the stored campaign.
  const { data: row, error: rowErr } = await supabase
    .from('email_campaign')
    .select('id, tenant_id, created_by_member_id, member_group_id, status')
    .eq('id', campaignId)
    .eq('tenant_id', access.tenantContext.tenantId)
    .single();
  if (rowErr || !row) return res.status(404).json({ error: 'Campaign not found' });
  if (row.created_by_member_id !== access.memberId) return res.status(404).json({ error: 'Campaign not found' });
  const ownedGroup = requireGroupAccess(access.groups, row.member_group_id);
  if (!ownedGroup) return res.status(403).json({ error: 'You do not have access to this campaign.' });

  // ---- Preview a stored campaign ----
  if (preview === true) {
    const campaignResult = await getCampaign(campaignId, access.tenantContext.tenantId);
    if (!campaignResult.success) return res.status(404).json({ error: campaignResult.error });

    const recipientsResult = await getTargetRecipients(campaignResult.campaign, access.tenantContext.tenantId);
    if (!recipientsResult.success) return res.status(500).json({ error: recipientsResult.error });

    return res.json({
      success: true,
      preview: true,
      recipientCount: recipientsResult.recipients.length,
      sampleRecipients: recipientsResult.recipients.slice(0, 10).map((r) => ({
        email: r.email, firstName: r.first_name, lastName: r.last_name,
      })),
    });
  }

  // ---- Schedule ----
  if (scheduledAt) {
    const scheduleDate = new Date(scheduledAt);
    if (isNaN(scheduleDate.getTime())) return res.status(400).json({ error: 'Invalid schedule date' });
    if (scheduleDate <= new Date()) return res.status(400).json({ error: 'Schedule date must be in the future' });
    const result = await scheduleCampaign(campaignId, access.tenantContext.tenantId, scheduleDate);
    if (!result.success) return res.status(500).json({ error: result.error });
    return res.json(result);
  }

  // ---- Send immediately ----
  const requestHost = getHostFromRequest(req);
  const result = await sendCampaign(campaignId, access.tenantContext.tenantId, requestHost);
  if (!result.success) return res.status(500).json({ error: result.error });
  return res.json(result);
}
