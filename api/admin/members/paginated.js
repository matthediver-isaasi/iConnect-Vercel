import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import { buildOptionValueOrConditions, parseCustomFilterRawValue } from '../../_lib/prefValueOptionFilter.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
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
      fields = ''
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    // Parse custom field filters (applied at DB level so paging + count span the whole tenant).
    // Shape: { "<fieldId>": ["A","B"] } for option filters (OR within the field),
    // "<fieldId>": "__text__:<substring>" / "__bool__:Yes|No" for the prefixed
    // encodings, or a legacy plain string from an old saved view.
    let parsedCustomFilters = {};
    if (customFilters && customFilters.trim()) {
      try {
        const obj = JSON.parse(customFilters);
        if (obj && typeof obj === 'object') {
          for (const [fieldId, raw] of Object.entries(obj)) {
            const parsed = parseCustomFilterRawValue(raw);
            if (parsed !== null) parsedCustomFilters[fieldId] = parsed;
          }
        }
      } catch {
        // Ignore malformed filter param and fall back to no custom filtering
      }
    }
    // Cap the number of custom filters to avoid pathological query expansion from crafted URLs.
    const MAX_CUSTOM_FILTERS = 20;
    const customFilterEntries = Object.entries(parsedCustomFilters).slice(0, MAX_CUSTOM_FILTERS);

    // Build the core select. For each active custom filter we add an aliased
    // inner join on member_preference_value so the join restricts (and counts)
    // members across the entire tenant, not just the current page.
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

    customFilterEntries.forEach((_, idx) => {
      selectClause += `,\n      cf${idx}:member_preference_value!inner(field_id, value)`;
    });

    let query = supabase
      .from('member')
      .select(selectClause, { count: 'exact' });

    query = query.eq('tenant_id', tenantId);

    query = query.not('email', 'like', 'deleted_%@deleted.local');

    customFilterEntries.forEach(([fieldId, value], idx) => {
      const alias = `cf${idx}`;
      query = query.eq(`${alias}.field_id`, fieldId);
      if (Array.isArray(value)) {
        // Multi-select option filter: OR across the selected values, each
        // matching scalar or JSON-array storage.
        query = query.or(buildOptionValueOrConditions(value), { foreignTable: alias });
      } else if (value.startsWith('__text__:')) {
        const substr = value.slice('__text__:'.length);
        query = query.ilike(`${alias}.value`, `%${substr}%`);
      } else if (value.startsWith('__bool__:')) {
        const boolLabel = value.slice('__bool__:'.length);
        if (boolLabel === 'Yes') {
          query = query.or('value.eq.Yes,value.eq.true', { foreignTable: alias });
        } else {
          query = query.or('value.eq.No,value.eq.false', { foreignTable: alias });
        }
      } else {
        // Legacy single-value option filter (old saved views / bookmarked
        // URLs): same matching so JSON-array-stored rows are found too.
        query = query.or(buildOptionValueOrConditions([value]), { foreignTable: alias });
      }
    });

    if (search && search.trim()) {
      const tokens = search.trim().split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        const pattern = `%${token.toLowerCase()}%`;
        query = query.or(`first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern},mobile.ilike.${pattern},job_title.ilike.${pattern}`);
      }
    }

    if (organizationId && organizationId !== 'all') {
      query = query.eq('organization_id', organizationId);
    }

    if (roleId && roleId !== 'all') {
      query = query.eq('role_id', roleId);
    }

    if (status === 'active') {
      query = query.eq('login_enabled', true);
    } else if (status === 'disabled') {
      query = query.eq('login_enabled', false);
    }

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
      customFilterEntries.forEach((_, idx) => { delete rest[`cf${idx}`]; });
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
