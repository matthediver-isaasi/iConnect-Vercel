import { supabase } from '../_lib/database.js';
import {
  getCampaign,
  updateCampaign,
  deleteCampaign,
  getCampaignStats,
  getCampaignRecipients,
  getTargetRecipients,
  cancelCampaign,
  pauseCampaign,
  resumeCampaign,
  createCampaign,
  returnScheduledCampaignToDraft,
  resolveMemberCampaignTemplateContent,
} from '../_lib/campaignService.js';
import { getCallerEmsAccess, requireGroupAccess, normalizeAudienceRoles, resolveMemberCampaignSender, validateStoredMemberCampaign } from '../_lib/memberGroupEmsAccess.js';

// from_email is intentionally NOT in this list — see PATCH handler. Members
// may only customize from_name; the sender address is forced from the
// tenant's verified email-domain config.
const MEMBER_EDITABLE_FIELDS = new Set([
  'name', 'subject', 'preheader', 'from_name',
  'html_content', 'design_json', 'email_template_id', 'audience_roles',
  'event_survey_context',
]);

async function loadAccessibleCampaign(campaignId, access) {
  const { data, error } = await supabase
    .from('email_campaign')
    .select('*')
    .eq('id', campaignId)
    .eq('tenant_id', access.tenantContext.tenantId)
    .single();

  if (error || !data) return { error: 'Campaign not found', status: 404 };

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

  const owned = await loadAccessibleCampaign(id, access);
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

    // Group Email is locked to the template-driven flow. The effective template
    // is the incoming one (if the client is switching) or the campaign's current
    // one. We re-pin html_content / design_json structure from that template and
    // accept ONLY per-send slot values from the client — freeform html_content /
    // structural design_json edits from the member endpoint are discarded.
    const touchesContent = 'html_content' in updates || 'design_json' in updates || 'email_template_id' in updates;
    if (touchesContent) {
      const effectiveTemplateId = ('email_template_id' in updates)
        ? updates.email_template_id
        : row.email_template_id;
      const requestedSlotValues = (updates.design_json && typeof updates.design_json === 'object')
        ? updates.design_json.slotValues
        : null;
      const requestedHiddenSlots = (updates.design_json && typeof updates.design_json === 'object')
        ? updates.design_json.hiddenSlots
        : null;
      const requestedRichSlots = (updates.design_json && typeof updates.design_json === 'object')
        ? updates.design_json.richSlots
        : null;
      const resolved = await resolveMemberCampaignTemplateContent({
        templateId: effectiveTemplateId,
        tenantId: access.tenantContext.tenantId,
        requestedSlotValues,
        requestedHiddenSlots,
        requestedRichSlots,
        groupClassificationId: group.classificationId || null,
      });
      if (!resolved.ok) return res.status(400).json({ error: resolved.error });
      updates.html_content = resolved.html_content;
      updates.design_json = resolved.design_json;
      updates.email_template_id = resolved.email_template_id;
    }

    // Audience is hard-locked to the owning group; client may only refine the
    // optional in-group role filter.
    if ('audience_roles' in updates) {
      const roles = normalizeAudienceRoles(group, updates.audience_roles);
      if (roles === null) return res.status(400).json({ error: 'audience_roles must be a subset of the group roles.' });
      const segment = { type: 'member_group', ids: [group.groupId] };
      if (roles.length > 0) segment.roles = roles;
      updates.target_audiences = [segment];
      delete updates.audience_roles;
    }

    // Always re-pin ownership / scope so a malicious PATCH cannot drift them.
    updates.member_group_id = group.groupId;
    updates.target_type = 'member_group';
    updates.target_ids = [group.groupId];
    updates.communication_category_id = null;

    // Re-pin sender identity from tenant config. from_name is allowed
    // through MEMBER_EDITABLE_FIELDS above; from_email is forced.
    const sender = await resolveMemberCampaignSender(access.tenantContext.tenantId, group, updates.from_name);
    if (sender.error) return res.status(400).json({ error: sender.error });
    updates.from_email = sender.fromEmail;
    updates.from_name = sender.fromName;

    const result = await updateCampaign(id, updates, access.tenantContext.tenantId, { expectedStatus: 'draft' });
    if (!result.success) return res.status(result.status || (result.code === 'CAMPAIGN_STATE_CONFLICT' || result.conflict ? 409 : 500)).json({ error: result.error, code: result.code });
    return res.json(result.campaign);
  }

  if (req.method === 'POST') {
    const { action } = req.body || {};
    if (action === 'edit-scheduled') {
      const result = await returnScheduledCampaignToDraft(id, access.tenantContext.tenantId);
      if (!result.success) return res.status(result.status || (result.code === 'CAMPAIGN_STATE_CONFLICT' || result.conflict ? 409 : 500)).json({ error: result.error, code: result.code });
      return res.json(result.campaign);
    }
    if (action === 'duplicate') {
      // Validate everything before the single insert. Never copy delivery state,
      // raw template structure, or arbitrary targeting from a legacy source.
      const audiences = row.target_audiences;
      if (audiences != null && (!Array.isArray(audiences) || audiences.length > 1)) {
        return res.status(400).json({ error: 'Source campaign has invalid group targeting.' });
      }
      const sourceAudience = audiences?.[0];
      if (sourceAudience && (sourceAudience.type !== 'member_group' ||
          !Array.isArray(sourceAudience.ids) || sourceAudience.ids.length !== 1 ||
          sourceAudience.ids[0] !== group.groupId)) {
        return res.status(400).json({ error: 'Source campaign has invalid group targeting.' });
      }
      const safeRoles = normalizeAudienceRoles(group, sourceAudience?.roles);
      if (safeRoles === null) return res.status(400).json({ error: 'Source campaign roles are no longer valid for this group.' });
      const segment = { type: 'member_group', ids: [group.groupId] };
      if (safeRoles.length > 0) segment.roles = safeRoles;
      let design = row.design_json;
      if (typeof design === 'string') {
        try { design = JSON.parse(design); } catch {
          return res.status(400).json({ error: 'Source campaign design is invalid.' });
        }
      }
      const resolved = await resolveMemberCampaignTemplateContent({
        templateId: row.email_template_id,
        tenantId: access.tenantContext.tenantId,
        requestedSlotValues: design?.slotValues,
        requestedHiddenSlots: design?.hiddenSlots,
        requestedRichSlots: design?.richSlots,
        groupClassificationId: group.classificationId || null,
      });
      if (!resolved.ok) return res.status(400).json({ error: resolved.error });
      const sender = await resolveMemberCampaignSender(access.tenantContext.tenantId, group, row.from_name);
      if (sender.error) return res.status(400).json({ error: sender.error });
      const dup = await createCampaign({
        name: `${row.name} (Copy)`,
        subject: row.subject,
        event_survey_context: row.event_survey_context || null,
        preheader: row.preheader || null,
        from_name: sender.fromName,
        from_email: sender.fromEmail,
        html_content: resolved.html_content,
        design_json: resolved.design_json,
        email_template_id: resolved.email_template_id,
        created_by_member_id: access.memberId,
        member_group_id: group.groupId,
        target_type: 'member_group',
        target_ids: [group.groupId],
        target_audiences: [segment],
        communication_category_id: null,
      }, access.tenantContext.tenantId, access.memberId);
      if (!dup.success) return res.status(500).json({ error: dup.error });
      return res.status(201).json(dup.campaign);
    }
    if (action === 'cancel') {
      const result = await cancelCampaign(id, access.tenantContext.tenantId, access.memberId);
      if (!result.success) {
        const status = result.code === 'CAMPAIGN_STATE_CONFLICT' ? 409 : result.error?.includes('Cannot cancel') ? 400 : result.error?.includes('not found') ? 404 : 500;
        return res.status(status).json({ error: result.error });
      }
      return res.json(result);
    }
    if (action === 'pause') {
      const result = await pauseCampaign(id, access.tenantContext.tenantId, access.memberId);
      if (!result.success) {
        const status = result.code === 'CAMPAIGN_STATE_CONFLICT' ? 409 : result.error?.includes('Cannot pause') ? 400 : result.error?.includes('not found') ? 404 : 500;
        return res.status(status).json({ error: result.error });
      }
      return res.json(result);
    }
    if (action === 'resume') {
      const validation = await validateStoredMemberCampaign(row, access.tenantContext.tenantId, group);
      if (!validation.ok) return res.status(validation.status).json({ error: validation.error });
      // Resume drains persisted rows, not the declared audience. Legacy rows
      // must therefore be checked against today's authorized group recipients.
      const audience = await getTargetRecipients(row, access.tenantContext.tenantId);
      if (!audience.success) return res.status(500).json({ error: audience.error });
      const recipientKey = recipient => JSON.stringify([
        recipient.member_id !== undefined ? recipient.member_id : recipient.id,
        String(recipient.email || '').trim().toLowerCase(),
      ]);
      const allowed = new Set(audience.recipients.map(recipientKey));
      for (let offset = 0; ; offset += 500) {
        const { data: recipients, error } = await supabase.from('email_campaign_recipient')
          .select('id, member_id, email')
          .eq('campaign_id', id).in('status', ['pending', 'processing'])
          .order('id').range(offset, offset + 499);
        if (error || !recipients) return res.status(500).json({ error: 'Unable to validate remaining campaign recipients.' });
        if (recipients.some(recipient => !allowed.has(recipientKey(recipient)))) {
          return res.status(403).json({ error: 'Remaining campaign recipients are outside the permitted group audience. This campaign cannot be resumed.' });
        }
        if (recipients.length < 500) break;
      }
      const result = await resumeCampaign(id, access.tenantContext.tenantId, access.memberId, {
        expectedStatus: row.status,
        expectedUpdatedAt: row.updated_at,
      });
      if (!result.success) {
        const status = result.code === 'CAMPAIGN_STATE_CONFLICT' ? 409 : result.error?.includes('Cannot resume') ? 400 : result.error?.includes('not found') ? 404 : 500;
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
    const result = await deleteCampaign(id, access.tenantContext.tenantId, { expectedStatus: 'draft' });
    if (!result.success) return res.status(result.status || (result.code === 'CAMPAIGN_STATE_CONFLICT' || result.conflict ? 409 : 500)).json({ error: result.error, code: result.code });
    return res.json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
