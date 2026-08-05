import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import {
  parseMemberListFilters,
  memberFilterSelectJoins,
  applyMemberListFilters,
  stripFilterJoinAliases,
} from '../../_lib/memberListFilters.js';

export default async function handler(req, res) {
  // POST is accepted only so a widget click-through can send a large ids
  // list in the request body (thousands of UUIDs overflow URL limits);
  // all other params still come from the query string.
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantCtx = await getTenantContext(req);
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
      roleId = '',
      status = 'all',
      sortField = 'created_on',
      sortDir = 'desc',
      customFilters = '',
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

    // Shared filter contract (search, org/role id lists, status, custom field
    // filters, direct-column coreFilters) — kept in lockstep with the CSV
    // export via api/_lib/memberListFilters.js.
    const filterCtx = parseMemberListFilters({ search, organizationId, roleId, status, customFilters, coreFilters });

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

    let query = supabase
      .from('member')
      .select(selectClause, { count: 'exact' });

    query = query.eq('tenant_id', tenantId);

    if (drillIds.length > 0) {
      query = query.in('id', drillIds);
    }

    query = query.not('email', 'like', 'deleted_%@deleted.local');

    query = applyMemberListFilters(query, filterCtx);

    const validSortFields = ['first_name', 'last_name', 'email', 'created_on', 'job_title', 'mobile', 'login_enabled', 'organization_name'];
    const actualSortField = validSortFields.includes(sortField) ? sortField : 'created_on';
    const ascending = sortDir === 'asc';

    if (actualSortField === 'organization_name') {
      query = query.order('name', { ascending, foreignTable: 'organization', nullsFirst: false });
    } else {
      query = query.order(actualSortField, { ascending });
    }
    query = query.range(offset, offset + limitNum - 1);

    const { data: members, error, count } = await query;

    if (error) {
      console.error('[MembersPaginated] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch members' });
    }

    const memberRows = members || [];
    const memberIds = memberRows.map(m => m.id);

    // Fetch custom field values for just this page of members so columns populate
    // on every page without a capped global fetch. Limit to the requested fields
    // when provided to keep the row count small.
    const customFieldValuesByMember = {};
    if (memberIds.length > 0) {
      let pvQuery = supabase
        .from('member_preference_value')
        .select('member_id, field_id, value')
        .in('member_id', memberIds);

      const fieldIds = fields
        ? fields.split(',').map(s => s.trim()).filter(Boolean)
        : [];
      if (fieldIds.length > 0) {
        pvQuery = pvQuery.in('field_id', fieldIds);
      }

      const { data: prefValues, error: pvError } = await pvQuery;
      if (pvError) {
        console.error('[MembersPaginated] Preference value query error:', pvError);
      } else {
        for (const pv of prefValues || []) {
          if (!customFieldValuesByMember[pv.member_id]) {
            customFieldValuesByMember[pv.member_id] = {};
          }
          customFieldValuesByMember[pv.member_id][pv.field_id] = pv.value;
        }
      }
    }

    const filteredMembers = memberRows.map(m => {
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

    const totalPages = Math.ceil((count || 0) / limitNum);

    return res.json({
      members: filteredMembers,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        totalPages
      }
    });
  } catch (err) {
    console.error('[MembersPaginated] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
