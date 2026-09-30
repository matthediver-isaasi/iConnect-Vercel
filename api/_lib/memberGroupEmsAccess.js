import { supabase } from './database.js';
import { getTenantContext } from './tenantContext.js';

/**
 * Resolve the list of member_group / role pairs that the calling member is
 * allowed to send group-emails for. The caller qualifies for a group when:
 *   - they have an active assignment (member_group_assignment row),
 *   - the group is active (member_group.is_active = true),
 *   - the assignment has not expired (expires_at IS NULL OR expires_at > now()),
 *   - the assignment is flagged as Group Admin (is_group_admin = true).
 *
 * Returns { tenantContext, memberId, groups: [{ groupId, groupName, role, allRoles }] }.
 * On 0 qualifying groups the caller list is empty — callers MUST 403.
 *
 * Also exposes a `requireGroupAccess(groups, groupId)` helper to assert the
 * caller can act on a particular group; returns the matched entry or null.
 */

export async function getCallerEmsAccess(req) {
  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return { error: 'Unauthorized - tenant required', status: 401, tenantContext, memberId: null, groups: [] };
  }
  const memberId = tenantContext.memberId;
  if (!memberId) {
    return { error: 'Forbidden - member session required', status: 403, tenantContext, memberId: null, groups: [] };
  }

  if (!supabase) {
    return { error: 'Database not configured', status: 500, tenantContext, memberId, groups: [] };
  }

  const nowIso = new Date().toISOString();

  // Pull the caller's active assignments. Filter expired rows in JS so we can
  // accept either NULL expires_at or a future date without complex Supabase
  // OR syntax.
  const { data: assignments, error: assignErr } = await supabase
    .from('member_group_assignment')
    .select('group_id, group_role, expires_at, is_group_admin')
    .eq('member_id', memberId);

  if (assignErr) {
    console.error('[MemberGroupEmsAccess] assignment lookup failed:', assignErr.message || assignErr);
    return { error: 'Failed to resolve group access', status: 500, tenantContext, memberId, groups: [] };
  }

  const liveAssignments = (assignments || []).filter((a) => {
    if (!a.group_id || !a.group_role) return false;
    if (!a.expires_at) return true;
    const expiry = new Date(a.expires_at).getTime();
    return Number.isFinite(expiry) && expiry > Date.parse(nowIso);
  });

  if (liveAssignments.length === 0) {
    return { tenantContext, memberId, groups: [] };
  }

  const groupIds = [...new Set(liveAssignments.map((a) => a.group_id))];

  const { data: groupRows, error: groupErr } = await supabase
    .from('member_group')
    .select('id, name, is_active, roles, tenant_id, classification_id')
    .eq('tenant_id', tenantContext.tenantId)
    .in('id', groupIds);

  if (groupErr) {
    console.error('[MemberGroupEmsAccess] group lookup failed:', groupErr.message || groupErr);
    return { error: 'Failed to resolve group access', status: 500, tenantContext, memberId, groups: [] };
  }

  const activeGroups = new Map();
  (groupRows || []).forEach((g) => {
    if (g.is_active !== true) return;
    activeGroups.set(g.id, g);
  });

  const seen = new Set();
  const qualifying = [];
  for (const a of liveAssignments) {
    const g = activeGroups.get(a.group_id);
    if (!g) continue;
    // Sending is gated by the explicit per-assignment Group Admin flag, not by
    // the assignment's role. Treat missing/null as not-admin.
    if (a.is_group_admin !== true) continue;
    const key = `${a.group_id}::${a.group_role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    qualifying.push({
      groupId: g.id,
      groupName: g.name,
      role: a.group_role,
      allRoles: Array.isArray(g.roles) ? g.roles : [],
      classificationId: g.classification_id || null,
    });
  }

  return { tenantContext, memberId, groups: qualifying };
}

export function requireGroupAccess(qualifyingGroups, groupId) {
  if (!groupId) return null;
  return qualifyingGroups.find((g) => g.groupId === groupId) || null;
}

/**
 * Validates a roles[] sub-filter the caller wants to apply within a group:
 * every entry must be one of the group's defined roles. Returns the
 * normalized array (deduped) or null if invalid.
 */
/**
 * Resolve the locked sender identity for a member-originated campaign.
 * Members may NEVER set or change the from-address: the task spec is
 * explicit ("from-address remains the tenant's existing campaign sender").
 * Returns { fromEmail, fromName } where fromEmail comes from the tenant's
 * verified email-domain config and fromName falls back to the group name.
 */
import { getTenantEmailConfig as _getTenantEmailConfig } from './tenantEmailService.js';

export async function resolveMemberCampaignSender(tenantId, group, requestedFromName) {
  const tenantCfg = await _getTenantEmailConfig(tenantId);
  if (!tenantCfg || !tenantCfg.fromEmail) {
    return { error: 'Your tenant has not configured a verified email domain. Ask an admin to set one up before sending group emails.' };
  }
  const fromName = (typeof requestedFromName === 'string' && requestedFromName.trim())
    ? requestedFromName.trim()
    : (group?.groupName || tenantCfg.fromName || 'ICONN');
  return { fromEmail: tenantCfg.fromEmail, fromName };
}

export function normalizeAudienceRoles(group, roles) {
  if (roles === undefined || roles === null) return [];
  if (!Array.isArray(roles)) return null;
  if (roles.length === 0) return [];
  const allowed = new Set(group.allRoles || []);
  const out = [];
  const seen = new Set();
  for (const r of roles) {
    if (typeof r !== 'string') return null;
    if (!allowed.has(r)) return null;
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

/**
 * Stored campaigns may have been created outside the member editor. Fail closed
 * rather than silently converting a legacy audience, sender or template policy.
 * Call before recipient previews, scheduling, real sends and test sends.
 */
export async function validateStoredMemberCampaign(campaign, tenantId, group) {
  const audiences = campaign.target_audiences;
  const segment = Array.isArray(audiences) && audiences.length === 1 ? audiences[0] : null;
  const ownsIds = ids => Array.isArray(ids) && ids.length === 1 && ids[0] === group.groupId;
  if (campaign.tenant_id !== tenantId || campaign.member_group_id !== group.groupId ||
      !segment || segment.type !== 'member_group' || !ownsIds(segment.ids) ||
      normalizeAudienceRoles(group, segment.roles) === null ||
      (campaign.target_type != null && campaign.target_type !== 'member_group') ||
      (campaign.target_ids != null && !ownsIds(campaign.target_ids)) ||
      campaign.communication_category_id != null || campaign.ignore_opt_outs === true) {
    return { error: 'Campaign targeting is not valid for this group. Edit the draft before sending.', status: 400 };
  }
  if (!campaign.email_template_id) {
    return { error: 'A currently permitted group email template is required.', status: 403 };
  }
  const { data: template, error } = await supabase.from('email_template')
    .select('id, member_group_opt_in, member_group_classification_ids')
    .eq('id', campaign.email_template_id)
    .eq('tenant_id', tenantId)
    .single();
  if (error || !template || template.member_group_opt_in !== true) {
    return { error: 'The template used by this campaign is no longer available for member group use.', status: 403 };
  }
  const classes = template.member_group_classification_ids;
  if (classes != null && (!Array.isArray(classes) ||
      (classes.length > 0 && (!group.classificationId || !classes.includes(String(group.classificationId)))))) {
    return { error: 'The template used by this campaign is not permitted for this group.', status: 403 };
  }
  const sender = await resolveMemberCampaignSender(tenantId, group, campaign.from_name);
  if (sender.error) return { error: sender.error, status: 400 };
  if (typeof campaign.from_email !== 'string' ||
      campaign.from_email.trim().toLowerCase() !== sender.fromEmail.trim().toLowerCase()) {
    return { error: 'Campaign sender no longer matches the tenant sender. Edit the draft before sending.', status: 400 };
  }
  return { ok: true };
}
