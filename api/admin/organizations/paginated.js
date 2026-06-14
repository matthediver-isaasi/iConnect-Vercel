import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';

const DELETED_EMAIL_PATTERN = 'deleted_%@deleted.local';

// Direct organization columns that can be sorted at the DB level.
const DIRECT_SORT_FIELDS = {
  name: 'name',
  invoicing_email: 'invoicing_email',
  phone: 'phone',
  website_url: 'website_url',
  description: 'description',
  created_at: 'created_at'
};

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
      limit = '20',
      search = '',
      phone = '',
      website_url = '',
      invoicing_email = '',
      invoicing_address = '',
      sortField = 'name',
      sortDir = 'asc',
      customFilters = '',
      fields = ''
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    // Parse custom field filters (applied at DB level so paging + totals span the
    // whole tenant). Shape: { "<fieldId>": "<value>" | "__text__:<substring>" }.
    let parsedCustomFilters = {};
    if (customFilters && customFilters.trim()) {
      try {
        const obj = JSON.parse(customFilters);
        if (obj && typeof obj === 'object') {
          for (const [fieldId, raw] of Object.entries(obj)) {
            if (raw === undefined || raw === null) continue;
            const val = String(raw);
            if (val === '' || val === 'all') continue;
            parsedCustomFilters[fieldId] = val;
          }
        }
      } catch {
        // Ignore malformed filter param and fall back to no custom filtering
      }
    }
    // Cap the number of custom filters to avoid pathological query expansion.
    const MAX_CUSTOM_FILTERS = 20;
    const customFilterEntries = Object.entries(parsedCustomFilters).slice(0, MAX_CUSTOM_FILTERS);

    // For each active custom filter add an aliased inner join on
    // organization_preference_value so the join restricts (and counts) orgs
    // across the entire tenant, not just the current page.
    const buildSelect = (base) => {
      let sel = base;
      customFilterEntries.forEach((_, idx) => {
        sel += `, cf${idx}:organization_preference_value!inner(field_id, value)`;
      });
      return sel;
    };

    const applyFilters = (query) => {
      query = query.eq('tenant_id', tenantId);
      customFilterEntries.forEach(([fieldId, value], idx) => {
        const alias = `cf${idx}`;
        query = query.eq(`${alias}.field_id`, fieldId);
        if (value.startsWith('__text__:')) {
          const substr = value.slice('__text__:'.length);
          query = query.ilike(`${alias}.value`, `%${substr}%`);
        } else {
          query = query.eq(`${alias}.value`, value);
        }
      });
      if (search && search.trim()) {
        const term = `%${search.trim().toLowerCase()}%`;
        query = query.or(
          `name.ilike.${term},invoicing_email.ilike.${term},phone.ilike.${term},website_url.ilike.${term}`
        );
      }
      if (phone && phone.trim()) query = query.ilike('phone', `%${phone.trim()}%`);
      if (website_url && website_url.trim()) query = query.ilike('website_url', `%${website_url.trim()}%`);
      if (invoicing_email && invoicing_email.trim()) query = query.ilike('invoicing_email', `%${invoicing_email.trim()}%`);
      if (invoicing_address && invoicing_address.trim()) query = query.ilike('invoicing_address', `%${invoicing_address.trim()}%`);
      return query;
    };

    // Count non-deleted members per organisation for an arbitrary id list.
    const countMembersForOrgIds = async (orgIds) => {
      const counts = {};
      orgIds.forEach((id) => { counts[id] = 0; });
      if (orgIds.length === 0) return counts;
      const BATCH = 100;
      for (let i = 0; i < orgIds.length; i += BATCH) {
        const batch = orgIds.slice(i, i + BATCH);
        let from = 0;
        const PAGE = 1000;
        while (true) {
          const { data, error } = await supabase
            .from('member')
            .select('organization_id')
            .eq('tenant_id', tenantId)
            .in('organization_id', batch)
            .not('email', 'like', DELETED_EMAIL_PATTERN)
            .range(from, from + PAGE - 1);
          if (error) {
            console.error('[OrgsPaginated] member count error:', error);
            break;
          }
          for (const m of data || []) {
            if (m.organization_id != null) {
              counts[m.organization_id] = (counts[m.organization_id] || 0) + 1;
            }
          }
          if (!data || data.length < PAGE) break;
          from += PAGE;
        }
      }
      return counts;
    };

    const ascending = sortDir === 'asc';
    let pageOrgs = [];
    let totalCount = 0;

    if (sortField === 'members') {
      // Member count is an aggregate the DB can't order on directly here, so
      // fetch every matching org id, count members tenant-wide, sort, paginate.
      const allIds = [];
      let from = 0;
      const PAGE = 1000;
      while (true) {
        let idQuery = supabase.from('organization').select(buildSelect('id'));
        idQuery = applyFilters(idQuery).range(from, from + PAGE - 1);
        const { data, error } = await idQuery;
        if (error) {
          console.error('[OrgsPaginated] id query error:', error);
          return res.status(500).json({ error: 'Failed to fetch organisations' });
        }
        for (const r of data || []) allIds.push(r.id);
        if (!data || data.length < PAGE) break;
        from += PAGE;
      }
      totalCount = allIds.length;
      const memberCounts = await countMembersForOrgIds(allIds);
      allIds.sort((a, b) => {
        const ca = memberCounts[a] || 0;
        const cb = memberCounts[b] || 0;
        return ascending ? ca - cb : cb - ca;
      });
      const pageIds = allIds.slice(offset, offset + limitNum);
      if (pageIds.length > 0) {
        const { data, error } = await supabase
          .from('organization')
          .select('*')
          .in('id', pageIds);
        if (error) {
          console.error('[OrgsPaginated] page rows error:', error);
          return res.status(500).json({ error: 'Failed to fetch organisations' });
        }
        const byId = {};
        (data || []).forEach((o) => { byId[o.id] = o; });
        pageOrgs = pageIds.map((id) => byId[id]).filter(Boolean);
        pageOrgs.forEach((o) => { o.member_count = memberCounts[o.id] || 0; });
      }
    } else {
      const actualSortField = DIRECT_SORT_FIELDS[sortField] || 'name';
      let query = supabase
        .from('organization')
        .select(buildSelect('*'), { count: 'exact' });
      query = applyFilters(query);
      query = query.order(actualSortField, { ascending, nullsFirst: false });
      query = query.range(offset, offset + limitNum - 1);

      const { data, error, count } = await query;
      if (error) {
        console.error('[OrgsPaginated] query error:', error);
        return res.status(500).json({ error: 'Failed to fetch organisations' });
      }
      totalCount = count || 0;
      pageOrgs = (data || []).map((o) => {
        const rest = { ...o };
        customFilterEntries.forEach((_, idx) => { delete rest[`cf${idx}`]; });
        return rest;
      });
      const memberCounts = await countMembersForOrgIds(pageOrgs.map((o) => o.id));
      pageOrgs.forEach((o) => { o.member_count = memberCounts[o.id] || 0; });
    }

    // Fetch custom field values for just this page of orgs so columns populate
    // on every page without a capped global fetch. Limit to requested fields.
    const orgIds = pageOrgs.map((o) => o.id);
    const customFieldValuesByOrg = {};
    if (orgIds.length > 0) {
      let pvQuery = supabase
        .from('organization_preference_value')
        .select('organization_id, field_id, value')
        .in('organization_id', orgIds);
      const fieldIds = fields
        ? fields.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      if (fieldIds.length > 0) pvQuery = pvQuery.in('field_id', fieldIds);

      const { data: prefValues, error: pvError } = await pvQuery;
      if (pvError) {
        console.error('[OrgsPaginated] Preference value query error:', pvError);
      } else {
        for (const pv of prefValues || []) {
          if (!customFieldValuesByOrg[pv.organization_id]) {
            customFieldValuesByOrg[pv.organization_id] = {};
          }
          customFieldValuesByOrg[pv.organization_id][pv.field_id] = pv.value;
        }
      }
    }

    const organizations = pageOrgs.map((o) => ({
      ...o,
      member_count: o.member_count || 0,
      custom_fields: customFieldValuesByOrg[o.id] || {}
    }));

    const totalPages = Math.ceil(totalCount / limitNum);

    return res.json({
      organizations,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        totalPages
      }
    });
  } catch (err) {
    console.error('[OrgsPaginated] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
