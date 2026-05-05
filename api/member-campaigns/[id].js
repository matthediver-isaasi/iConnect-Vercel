import { supabase } from '../_lib/database.js';
import {
  getCampaign,
  updateCampaign,
  deleteCampaign,
  getCampaignStats,
  getCampaignRecipients,
  cancelCampaign,
  pauseCampaign,
  resumeCampaign,
  duplicateCampaign,
} from '../_lib/campaignService.js';
import { getCallerEmsAccess, requireGroupAccess, normalizeAudienceRoles } from '../_lib/memberGroupEmsAccess.js';

const MEMBER_EDITABLE_FIELDS = new Set([
  'name', 'subject', 'preheader', 'from_name', 'from_email',
  'html_content', 'design_json', 'audience_roles',
]);

async function loadOwnedCampaign(campaignId, access) {
  const { data, error } = await supabase
    .from('email_campaign')
    .select('id, tenant_id, created_by_member_id, member_group_id, status, target_audiences')
    .eq('id', campaignId)
    .eq('tenant_id', access.tenantContext.tenantId)
    .single();

  if (error || !data) return { error: 'Campaign not found', status: 404 };
  if (data.created_by_member_id !== access.memberId) return { error: 'Campaign not found', status: 404 };

  const group = requireGroupAccess(access.groups, data.member_group_id);
  if (!group) return { error: 'You do not have access to this campaign.', status: 403 };

  return { row: data, group };
}

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Campaign ID required' });

  const access = await getCallerEmsAccess(req);
  if (access.error) return res.status(access.status).json({ error: access.error });
  if (access.groups.length === 0) return res.status(403).json({ error: 'You do not have permission to send group emails.' });

  const owned = await loadOwnedCampaign(id, access);
  if (owned.error) return res.status(owned.status).json({ error: owned.error });
  const { row, group } = owned;

  if (req.method === 'GET') {
    if (req.query.stats === 'true') {
      const result = await getCampaignStats(id, access.tenantContext.tenantId);
      if (!result.success) return res.status(500).json({ error: result.error });
      return res.json(result);
    }
    if (req.query.recipients === 'true') {
      const result = await getCampaignRecipients(id, access.tenantContext.tenantId);
      if (!result.success) return res.status(500).json({ error: result.error });
      return res.json(result);
    }
    const result = await getCampaign(id, access.tenantContext.tenantId);
    if (!result.success) return res.status(404).json({ error: result.error });
    return res.json(result.campaign);
  }

  if (req.method === 'PATCH' || req.method === 'PUT') {
    if (row.status !== 'draft') {
      return res.status(400).json({ error: 'Only draft campaigns can be edited.' });
    }

    const updates = {};
    for (const [k, v] of Object.entries(req.body || {})) {
      if (MEMBER_EDITABLE_FIELDS.has(k)) updates[k] = v;
    }

    // Audience is hard-locked to the owning group; client may only refine the
    // optional in-group role filter.
    if ('audience_roles' in updates) {
      const roles = normalizeAudienceRoles(group, updates.audience_roles || []);
      if (roles === null) return res.status(400).json({ error: 'audience_roles must be a subset of the group roles.' });
      const segment = { type: 'member_group', ids: [group.groupId] };
      if (roles.length > 0) segment.roles = roles;
      updates.target_audiences = [segment];
      delete updates.audience_roles;
    }

    // Always re-pin ownership / scope so a malicious PATCH cannot drift them.
    updates.member_group_id = group.groupId;
    updates.created_by_member_id = access.memberId;
    updates.target_type = 'member_group';
    updates.target_ids = [group.groupId];
    updates.communication_category_id = null;

    const result = await updateCampaign(id, updates, access.tenantContext.tenantId);
    if (!result.success) return res.status(500).json({ error: result.error });
    return res.json(result.campaign);
  }

  if (req.method === 'POST') {
    const { action } = req.body || {};
    if (action === 'duplicate') {
      const dup = await duplicateCampaign(id, access.tenantContext.tenantId, access.memberId);
      if (!dup.success) return res.status(500).json({ error: dup.error });
      // Re-pin the duplicate's full scope so a tampered/legacy source row can
      // never carry widened targeting forward into the new draft.
      const sourceAudience = Array.isArray(row.target_audiences) ? row.target_audiences[0] : null;
      const sourceRoles = sourceAudience && Array.isArray(sourceAudience.roles) ? sourceAudience.roles : [];
      const safeRoles = normalizeAudienceRoles(group, sourceRoles) || [];
      const segment = { type: 'member_group', ids: [group.groupId] };
      if (safeRoles.length > 0) segment.roles = safeRoles;
      const { data: pinned, error: pinErr } = await supabase
        .from('email_campaign')
        .update({
          created_by_member_id: access.memberId,
          member_group_id: group.groupId,
          target_type: 'member_group',
          target_ids: [group.groupId],
          target_audiences: [segment],
          communication_category_id: null,
        })
        .eq('id', dup.campaign.id)
        .eq('tenant_id', access.tenantContext.tenantId)
        .select()
        .single();
      if (pinErr) {
        console.error('[MemberCampaigns] duplicate pin failed:', pinErr.message || pinErr);
        return res.status(500).json({ error: 'Failed to pin duplicate ownership' });
      }
      return res.status(201).json(pinned);
    }
    if (action === 'cancel') {
      const result = await cancelCampaign(id, access.tenantContext.tenantId, access.memberId);
      if (!result.success) {
        const status = result.error?.includes('Cannot cancel') ? 400 : result.error?.includes('not found') ? 404 : 500;
        return res.status(status).json({ error: result.error });
      }
      return res.json(result);
    }
    if (action === 'pause') {
      const result = await pauseCampaign(id, access.tenantContext.tenantId, access.memberId);
      if (!result.success) {
        const status = result.error?.includes('Cannot pause') ? 400 : result.error?.includes('not found') ? 404 : 500;
        return res.status(status).json({ error: result.error });
      }
      return res.json(result);
    }
    if (action === 'resume') {
      const result = await resumeCampaign(id, access.tenantContext.tenantId, access.memberId);
      if (!result.success) {
        const status = result.error?.includes('Cannot resume') ? 400 : result.error?.includes('not found') ? 404 : 500;
        return res.status(status).json({ error: result.error });
      }
      return res.json(result);
    }
    return res.status(400).json({ error: 'Invalid action' });
  }

  if (req.method === 'DELETE') {
    if (row.status !== 'draft') {
      return res.status(400).json({ error: 'Only draft campaigns can be deleted.' });
    }
    const result = await deleteCampaign(id, access.tenantContext.tenantId);
    if (!result.success) return res.status(500).json({ error: result.error });
    return res.json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
