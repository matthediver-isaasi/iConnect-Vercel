import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { fetchMemberDisplaySettings } from '../_lib/directoryConfig.js';

// Public, tenant-scoped member-group member endpoint (Task #3685).
//
// GET -> given a group (?groupId=…) and an optional set of group-role filters
//        (?roles=Chair,Member), returns the group's current members rendered
//        as safe directory cards, together with each member's group-role
//        context and the group's public metadata / display settings.
//
// Privacy rules mirror api/public/dynamic-directory.js exactly:
//   * only members opted into the directory (show_in_directory not false),
//   * only login-enabled accounts (login_enabled not false),
//   * soft-deleted accounts (deleted_*@deleted.local) are excluded.
// Only CURRENT, NON-GUEST assignments are considered: the assignment must
// have a member_id (guests carry guest_id instead) and must not be expired
// (expires_at IS NULL OR expires_at > now()).
//
// Pagination is deterministic (name ascending, tie-broken by id) and applied
// to the joined assignment/member result in the database. This avoids an
// unbounded member-id list in the PostgREST request for large groups.

// Directory-safe columns exposed on a member card. Kept in sync with the
// member card fields returned by api/public/dynamic-directory.js.
const MEMBER_CARD_SELECT =
  'id, first_name, last_name, job_title, profile_photo_url, handle, role_id, linkedin_url, organization_id';
const MEMBER_ASSIGNMENT_SELECT =
  `group_role, member:member!inner(${MEMBER_CARD_SELECT})`;
const MEMBER_CARD_SELECT_WITHOUT_LINKEDIN =
  'id, first_name, last_name, job_title, profile_photo_url, handle, role_id, organization_id';

// Public shape of the group returned to embeds. Keep this intentionally
// narrower than the standalone group page: Canvas needs only live display copy
// and the configured role names used by the filter.
function buildPublicGroupPayload(group) {
  if (!group) return null;
  return {
    id: group.id,
    name: group.name || null,
    description: group.description || null,
    roles: Array.isArray(group.roles) ? group.roles.filter(Boolean) : [],
  };
}

// Parse the optional ?roles= filter into a trimmed, de-duplicated list.
// Accepts a comma-separated string or a repeated query param (array).
function parseRequestedRoles(rolesParam) {
  if (rolesParam === undefined || rolesParam === null) return null;
  const raw = Array.isArray(rolesParam)
    ? rolesParam
    : String(rolesParam).split(',');
  const cleaned = raw.map((r) => String(r).trim()).filter(Boolean);
  return [...new Set(cleaned)];
}

function selectCurrentAssignments(assignments, groupRoles, requestedRoles, now = Date.now()) {
  const allowedRoles = new Set(Array.isArray(groupRoles) ? groupRoles : []);
  const filteredRoles = requestedRoles?.length ? new Set(requestedRoles) : null;
  const byMemberId = new Map();
  for (const assignment of assignments || []) {
    if (!assignment?.member_id || assignment.guest_id) continue;
    if (!allowedRoles.has(assignment.group_role)) continue;
    const expiry = assignment.expires_at ? Date.parse(assignment.expires_at) : null;
    if (expiry !== null && (!Number.isFinite(expiry) || expiry <= now)) continue;
    if (filteredRoles && !filteredRoles.has(assignment.group_role)) continue;
    if (!byMemberId.has(assignment.member_id)) {
      byMemberId.set(assignment.member_id, {
        groupRole: assignment.group_role,
        isGroupAdmin: assignment.is_group_admin === true,
      });
    }
  }
  return byMemberId;
}

function parsePagination(page, limit) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(limit, 10) || 12));
  return { pageNum, pageSize, offset: (pageNum - 1) * pageSize };
}

function buildMemberPageQuery({
  supabase,
  tenantId,
  groupId,
  effectiveRoles,
  offset,
  pageSize,
  nowIso,
  memberSelect = MEMBER_CARD_SELECT,
}) {
  return supabase
    .from('member_group_assignment')
    .select(`group_role, member:member!inner(${memberSelect})`, { count: 'exact' })
    .eq('tenant_id', tenantId)
    .eq('group_id', groupId)
    .not('member_id', 'is', null)
    .is('guest_id', null)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .eq('member.tenant_id', tenantId)
    .or(
      'show_in_directory.is.null,show_in_directory.neq.false',
      { referencedTable: 'member' }
    )
    .or(
      'login_enabled.is.null,login_enabled.neq.false',
      { referencedTable: 'member' }
    )
    .not('member.email', 'ilike', 'deleted_%@deleted.local')
    .in('group_role', effectiveRoles)
    .order('first_name', { ascending: true, referencedTable: 'member' })
    .order('last_name', { ascending: true, referencedTable: 'member' })
    .order('id', { ascending: true, referencedTable: 'member' })
    .range(offset, offset + pageSize - 1);
}

async function handleMemberGroupMembers(req, res, dependencies = {}) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let supabase = dependencies.supabase;
  if (!supabase) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !supabaseServiceKey) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    supabase = createClient(supabaseUrl, supabaseServiceKey);
  }

  const tenant = dependencies.tenant
    || await (dependencies.resolveTenant || resolveTenantFromRequest)(req);
  if (!tenant) return res.status(400).json({ error: 'Invalid tenant context' });
  const tenantId = tenant.id;

  const { groupId, page = '1', limit = '12' } = req.query;
  if (!groupId) return res.status(400).json({ error: 'groupId is required' });

  const requestedRoles = parseRequestedRoles(req.query.roles);

  try {
    // Resolve the group and confirm it belongs to this tenant and is active.
    const { data: groups, error: groupError } = await supabase
      .from('member_group')
      .select('id, name, description, roles, is_active')
      .eq('tenant_id', tenantId)
      .eq('id', groupId)
      .neq('is_active', false)
      .limit(1);

    if (groupError) {
      console.error('[PublicMemberGroupMembers] Group lookup error:', groupError);
      return res.status(500).json({ error: 'Failed to look up member group' });
    }
    const group = groups?.[0];
    if (!group) return res.status(404).json({ error: 'Member group not found' });

    const groupRoles = Array.isArray(group.roles) ? group.roles.filter(Boolean) : [];
    const groupRoleSet = new Set(groupRoles);

    // Validate that every requested group-role actually belongs to this group.
    let roleFilter = null;
    if (requestedRoles && requestedRoles.length > 0) {
      const invalid = requestedRoles.filter((r) => !groupRoleSet.has(r));
      if (invalid.length > 0) {
        return res.status(400).json({
          error: `Unknown group role(s) for this group: ${invalid.join(', ')}`,
        });
      }
      roleFilter = new Set(requestedRoles);
    }

    const { pageNum, pageSize, offset } = parsePagination(page, limit);
    const effectiveRoles = roleFilter ? [...roleFilter] : groupRoles;

    // A group with no configured roles cannot have a publicly valid
    // assignment. Avoid emitting an invalid empty `in.()` PostgREST filter.
    if (effectiveRoles.length === 0) {
      const displaySettings = await fetchMemberDisplaySettings(supabase, tenantId);
      return res.json({
        groupId: group.id,
        records: [],
        total: 0,
        page: pageNum,
        pageSize,
        config: {
          displaySettings,
          group: buildPublicGroupPayload(group),
          requestedRoles: requestedRoles || null,
        },
      });
    }

    const nowIso = new Date().toISOString();
    const queryOptions = {
      supabase,
      tenantId,
      groupId: group.id,
      effectiveRoles,
      offset,
      pageSize,
      nowIso,
    };
    let pageResult = await buildMemberPageQuery(queryOptions);
    // Some legacy schemas predate the optional member.linkedin_url column.
    // Keep the whole block available there while retaining LinkedIn on schemas
    // that support the existing public directory card field.
    if (
      pageResult.error?.code === '42703'
      && String(pageResult.error.message || '').includes('linkedin_url')
    ) {
      pageResult = await buildMemberPageQuery({
        ...queryOptions,
        memberSelect: MEMBER_CARD_SELECT_WITHOUT_LINKEDIN,
      });
    }
    const { data, count: total, error } = pageResult;
    if (error) {
      console.error('[PublicMemberGroupMembers] joined member fetch error', error);
      return res.status(500).json({ error: 'Failed to fetch members' });
    }
    const pageMembers = (data || [])
      .map((assignment) => assignment?.member
        ? { ...assignment.member, group_role: assignment.group_role || null }
        : null)
      .filter(Boolean);

    // Config needed to render cards identically to the portal / guest view.
    const displaySettings = await fetchMemberDisplaySettings(supabase, tenantId);

    // Resolve organisation names for this page's members.
    const orgIds = [...new Set(pageMembers.map((m) => m.organization_id).filter(Boolean))];
    const orgNameById = {};
    if (orgIds.length > 0) {
      const { data: orgRows } = await supabase
        .from('organization')
        .select('id, name')
        .in('id', orgIds);
      for (const o of orgRows || []) orgNameById[o.id] = o.name;
    }

    const records = pageMembers.map((m) => ({
      id: m.id,
      name: [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || null,
      first_name: m.first_name || null,
      last_name: m.last_name || null,
      subtitle: m.job_title || null,
      job_title: m.job_title || null,
      image_url: m.profile_photo_url || null,
      profile_photo_url: m.profile_photo_url || null,
      handle: m.handle || null,
      role_id: m.role_id || null,
      linkedin_url: m.linkedin_url || null,
      organization_id: m.organization_id || null,
      organization_name: m.organization_id ? (orgNameById[m.organization_id] || null) : null,
      group_role: m.group_role || null,
    }));

    return res.json({
      groupId: group.id,
      records,
      total: total || 0,
      page: pageNum,
      pageSize,
      config: {
        displaySettings,
        group: buildPublicGroupPayload(group),
        requestedRoles: requestedRoles || null,
      },
    });
  } catch (err) {
    console.error('[PublicMemberGroupMembers] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch member group members' });
  }
}

export default function handler(req, res) {
  return handleMemberGroupMembers(req, res);
}

// Exported for unit tests.
export {
  buildPublicGroupPayload,
  parseRequestedRoles,
  selectCurrentAssignments,
  parsePagination,
  handleMemberGroupMembers,
  MEMBER_ASSIGNMENT_SELECT,
  MEMBER_CARD_SELECT,
};
