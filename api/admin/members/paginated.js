import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import {
  parseMemberListFilters,
  validateOrganizationFilterEntries,
  memberFilterSelectJoins,
  applyMemberListFilters,
  stripFilterJoinAliases,
} from '../../_lib/memberListFilters.js';
import { resolveDepartmentMemberIds, enrichMembersWithDepartments, MemberDepartmentError } from '../../_lib/memberDepartments.js';

function parseRequestedFields(rawFields) {
  const value = Array.isArray(rawFields) ? rawFields.join(',') : String(rawFields || '');
  if (value.trim().toLowerCase() === 'none') return { skip: true, ids: [] };
  const ids = [...new Set(value.split(',').map((id) => id.trim()).filter(Boolean))];
  return { skip: false, ids };
}

function requireRows(data, message) {
  if (Array.isArray(data)) return data;
  const error = new Error(message);
  error.status = 500;
  throw error;
}

export async function handlePaginatedMembers(req, res, {
  db = supabase,
  getContext = getTenantContext,
  resolveDepartments = resolveDepartmentMemberIds,
  enrichDepartments = enrichMembersWithDepartments,
} = {}) {
  // POST is accepted only so a widget click-through can send a large ids
  // list in the request body (thousands of UUIDs overflow URL limits);
  // all other params still come from the query string.
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantCtx = await getContext(req);
  if (!tenantCtx || !tenantCtx.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const tenantId = tenantCtx.tenantId;
  if (!tenantId) {
    return res.status(403).json({ error: 'Invalid tenant context' });
  }

  try {
    const {
      page = '1',
      limit = '50',
      search = '',
      organizationId = '',
       departmentId = '',
      roleId = '',
      status = 'all',
      sortField = 'created_on',
      sortDir = 'desc',
      customFilters = '',
      organizationFilters = '',
      coreFilters = '',
      fields = '',
      // Dashboard widget click-through: comma-separated member ids limiting
      // the list to the records behind one widget bucket. On POST the ids
      // travel in the JSON body instead (URL length limits).
      ids = ''
    } = req.query;
    const rawIds = req.method === 'POST'
      ? (Array.isArray(req.body?.ids) ? req.body.ids.join(',') : String(req.body?.ids || ''))
      : ids;

    // Parse + cap the drill-down id list (uuid-shaped values only).
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const drillIds = (rawIds ? String(rawIds).split(',') : [])
      .map(s => s.trim())
      .filter(s => UUID_RE.test(s))
      .slice(0, 2000);

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;
    const requestedFields = parseRequestedFields(fields);

    // Shared filter contract (search, org/role id lists, status, custom field
    // filters, direct-column coreFilters) — kept in lockstep with the CSV
    // export via api/_lib/memberListFilters.js.
    const filterCtx = parseMemberListFilters({ search, organizationId, departmentId, roleId, status, customFilters, organizationFilters, coreFilters });
    await validateOrganizationFilterEntries(db, tenantId, filterCtx);
    const departmentMemberIds = filterCtx.departmentIds.length
      ? await resolveDepartments(db, tenantId, filterCtx.departmentIds) : null;
    if (departmentMemberIds && departmentMemberIds.length === 0) {
      return res.json({ members: [], pagination: { page: pageNum, limit: limitNum, total: 0, totalPages: 0 } });
    }

    // Build the core select. For each active custom filter we add an aliased
    // join on member_preference_value. Positive operators use an inner join so
    // the join restricts (and counts) members across the entire tenant;
    // negative operators use a left join whose matches are then excluded
    // (`.is(alias, null)`), so members without any row also qualify.
    let selectClause = `
      id,
      first_name,
      last_name,
      email,
      mobile,
      job_title,
      organization_id,
      role_id,
      login_enabled,
      show_in_directory,
      created_on,
      profile_photo_url,
      tenant_id,
      is_guest,
      guest_expires_at,
      organization (id, name, tenant_id)`;

    selectClause += memberFilterSelectJoins(filterCtx);

    let query = db
      .from('member')
      .select(selectClause, { count: 'exact' });

    query = query.eq('tenant_id', tenantId);

    if (drillIds.length > 0) {
      query = query.in('id', drillIds);
    }
    if (departmentMemberIds) query = query.in('id', departmentMemberIds);

    query = query.not('email', 'like', 'deleted_%@deleted.local');

    query = applyMemberListFilters(query, filterCtx, { tenantId });

    const validSortFields = ['first_name', 'last_name', 'email', 'created_on', 'job_title', 'mobile', 'login_enabled', 'organization_name'];
    const actualSortField = validSortFields.includes(sortField) ? sortField : 'created_on';
    const ascending = sortDir === 'asc';

    if (actualSortField === 'organization_name') {
      query = query.order('name', { ascending, foreignTable: 'organization', nullsFirst: false });
    } else {
      query = query.order(actualSortField, { ascending });
    }
    // Make ranged pagination deterministic when the selected value is shared.
    query = query.order('id', { ascending: true });
    query = query.range(offset, offset + limitNum - 1);

    const { data: members, error, count } = await query;

    if (error) {
      console.error('[MembersPaginated] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch members' });
    }
    if (!Number.isInteger(count)) {
      console.error('[MembersPaginated] Query returned no exact count');
      return res.status(500).json({ error: 'Failed to count members' });
    }

    const memberRows = requireRows(members, 'Failed to fetch members');
    const memberIds = memberRows.map(m => m.id);

    // Fetch custom field values for just this page of members so columns populate
    // on every page without a capped global fetch. Limit to the requested fields
    // when provided to keep the row count small.
    const customFieldValuesByMember = {};
    const loadPreferenceValues = async () => {
      if (memberIds.length === 0 || requestedFields.skip) return;
      let pvQuery = db
        .from('member_preference_value')
        .select('member_id, field_id, value')
        .in('member_id', memberIds);

      if (requestedFields.ids.length > 0) {
        pvQuery = pvQuery.in('field_id', requestedFields.ids);
      }

      const { data: prefValues, error: pvError } = await pvQuery;
      if (pvError) {
        console.error('[MembersPaginated] Preference value query error:', pvError);
        const error = new Error('Failed to fetch member preference values');
        error.status = 500;
        throw error;
      }
      for (const pv of requireRows(prefValues, 'Failed to fetch member preference values')) {
        if (!customFieldValuesByMember[pv.member_id]) {
          customFieldValuesByMember[pv.member_id] = {};
        }
        customFieldValuesByMember[pv.member_id][pv.field_id] = pv.value;
      }
    };

    // These page enrichments read independent tables and can run concurrently.
    const [, enrichedMemberRows] = await Promise.all([
      loadPreferenceValues(),
      enrichDepartments(db, tenantId, memberRows),
    ]);
    requireRows(enrichedMemberRows, 'Failed to fetch member departments');
    const filteredMembers = enrichedMemberRows.map(m => {
      const { ...rest } = m;
      // Strip the join-only aliases from the response
      stripFilterJoinAliases(rest, filterCtx);
      return {
        ...rest,
        disabled: m.login_enabled === false,
        profile_photo: m.profile_photo_url,
        custom_fields: customFieldValuesByMember[m.id] || {}
      };
    });

    const totalPages = Math.ceil(count / limitNum);

    return res.json({
      members: filteredMembers,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count,
        totalPages
      }
    });
  } catch (err) {
    if (err instanceof MemberDepartmentError) return res.status(err.status).json({ error: err.message });
    if (err?.status) return res.status(err.status).json({ error: err.message });
    console.error('[MembersPaginated] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export default function handler(req, res) {
  return handlePaginatedMembers(req, res);
}
