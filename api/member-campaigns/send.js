import { supabase } from '../_lib/database.js';
import { getCallerEmsAccess, requireGroupAccess, normalizeAudienceRoles, validateStoredMemberCampaign } from '../_lib/memberGroupEmsAccess.js';
import { sendCampaign, getTargetRecipients, scheduleCampaign } from '../_lib/campaignService.js';
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
 * Ad-hoc audiences are pinned to the group. Stored audiences, sender and
 * template policy are validated and rejected if they no longer qualify.
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
    const roles = normalizeAudienceRoles(group, audienceRoles);
    if (roles === null) return res.status(400).json({ error: 'audienceRoles must be a subset of the group roles.' });
    if (roles.length > 0) segment.roles = roles;

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

  // Verify tenant scope and current group-admin access.
  const { data: row, error: rowErr } = await supabase
    .from('email_campaign')
    .select('*')
    .eq('id', campaignId)
    .eq('tenant_id', access.tenantContext.tenantId)
    .single();
  if (rowErr || !row) return res.status(404).json({ error: 'Campaign not found' });
  const ownedGroup = requireGroupAccess(access.groups, row.member_group_id);
  if (!ownedGroup) return res.status(403).json({ error: 'You do not have access to this campaign.' });

  const validation = await validateStoredMemberCampaign(row, access.tenantContext.tenantId, ownedGroup);
  if (!validation.ok) return res.status(validation.status).json({ error: validation.error });

  // ---- Preview a stored campaign ----
  if (preview === true) {
    const recipientsResult = await getTargetRecipients(row, access.tenantContext.tenantId);
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

  if (row.status !== 'draft') return res.status(400).json({ error: 'Only draft campaigns can be sent or scheduled.' });

  // ---- Schedule ----
  if (scheduledAt) {
    const scheduleDate = new Date(scheduledAt);
    if (isNaN(scheduleDate.getTime())) return res.status(400).json({ error: 'Invalid schedule date' });
    if (scheduleDate <= new Date()) return res.status(400).json({ error: 'Schedule date must be in the future' });
    const result = await scheduleCampaign(campaignId, access.tenantContext.tenantId, scheduleDate, { expectedStatus: 'draft', expectedUpdatedAt: row.updated_at });
    if (!result.success) return res.status(result.code === 'CAMPAIGN_STATE_CONFLICT' || result.conflict ? 409 : Number.isInteger(result.status) ? result.status : 500).json({ error: result.error, code: result.code });
    return res.json(result);
  }

  // ---- Send immediately ---- (plan quota enforced inside sendCampaign())
  const requestHost = getHostFromRequest(req);
  const result = await sendCampaign(campaignId, access.tenantContext.tenantId, requestHost, { expectedStatus: 'draft', expectedUpdatedAt: row.updated_at });
  if (!result.success) {
    if (result.quota) {
      return res.status(402).json({ error: result.error, code: 'PLAN_QUOTA_EXCEEDED', quota: result.quota });
    }
    return res.status(result.code === 'CAMPAIGN_STATE_CONFLICT' || result.conflict ? 409 : Number.isInteger(result.status) ? result.status : 500).json({ error: result.error, code: result.code });
  }
  return res.json(result);
}
