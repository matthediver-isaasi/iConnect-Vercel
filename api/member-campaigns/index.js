import { supabase } from '../_lib/database.js';
import { getCallerEmsAccess, requireGroupAccess, normalizeAudienceRoles } from '../_lib/memberGroupEmsAccess.js';
import { createCampaign } from '../_lib/campaignService.js';

/**
 * /api/member-campaigns
 *  - GET: list campaigns owned by the calling member, scoped to groups they
 *    qualify for. Tenant-admin campaigns (created_by_member_id IS NULL) are
 *    NEVER returned here.
 *  - POST: create a draft campaign locked to one of the caller's groups. The
 *    server forces created_by_member_id, member_group_id and target_audiences
 *    so the client cannot widen its own audience.
 */
export default async function handler(req, res) {
  const access = await getCallerEmsAccess(req);
  if (access.error) {
    return res.status(access.status).json({ error: access.error });
  }
  if (access.groups.length === 0) {
    return res.status(403).json({ error: 'You do not have permission to send group emails.' });
  }

  const allowedGroupIds = access.groups.map((g) => g.groupId);

  if (req.method === 'GET') {
    const { groupId } = req.query;
    let scopedGroupIds = allowedGroupIds;
    if (groupId) {
      if (!allowedGroupIds.includes(groupId)) {
        return res.status(403).json({ error: 'You do not have access to this group.' });
      }
      scopedGroupIds = [groupId];
    }

    const { data, error } = await supabase
      .from('email_campaign')
      .select('id, name, subject, status, scheduled_at, sent_at, created_at, updated_at, total_recipients, sent_count, delivered_count, opened_count, clicked_count, bounced_count, member_group_id, target_audiences')
      .eq('tenant_id', access.tenantContext.tenantId)
      .eq('created_by_member_id', access.memberId)
      .in('member_group_id', scopedGroupIds)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[MemberCampaigns] list error:', error.message || error);
      return res.status(500).json({ error: 'Failed to load campaigns' });
    }

    return res.json({ success: true, campaigns: data || [] });
  }

  if (req.method === 'POST') {
    const { groupId, name, subject, html_content, design_json, from_name, from_email, preheader, audience_roles } = req.body || {};

    if (!groupId) {
      return res.status(400).json({ error: 'groupId is required' });
    }
    const group = requireGroupAccess(access.groups, groupId);
    if (!group) {
      return res.status(403).json({ error: 'You do not have access to this group.' });
    }
    if (!name || !subject) {
      return res.status(400).json({ error: 'name and subject are required' });
    }

    const roles = normalizeAudienceRoles(group, audience_roles || []);
    if (roles === null) {
      return res.status(400).json({ error: 'audience_roles must be a subset of the group roles.' });
    }

    const audienceSegment = { type: 'member_group', ids: [group.groupId] };
    if (roles.length > 0) audienceSegment.roles = roles;

    const campaignData = {
      name,
      subject,
      from_name: from_name || group.groupName,
      from_email: from_email || null,
      preheader: preheader || null,
      html_content: html_content || '',
      design_json: design_json || null,
      target_audiences: [audienceSegment],
      target_type: 'member_group',
      target_ids: [group.groupId],
      member_group_id: group.groupId,
      created_by_member_id: access.memberId,
      // Members must NEVER drive a category/list selector; force null so the
      // tenant-side category filter in getTargetRecipients is bypassed.
      communication_category_id: null,
    };

    const result = await createCampaign(campaignData, access.tenantContext.tenantId, access.memberId);
    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }
    return res.status(201).json(result.campaign);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
