import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import { getCountryByName } from '../../../shared/countries.js';
import {
  normalizeCustomFilterEntry,
  applyPrefFilterEntry,
  prefEntryNeedsAntiJoin,
  parseCoreFilters,
  applyDirectColumnFilter,
} from '../../_lib/prefValueOptionFilter.js';

// Direct organization columns filterable through the coreFilters param.
const CORE_FILTER_COLUMNS = {
  phone: {},
  website_url: {},
  invoicing_email: {},
  invoicing_address: {},
};

// Build the OR conditions matching a set of country names against
// single-select storage (name or legacy ISO-2 code) and multi-select storage
// (JSON array containing the name or code). Quoting the name in the ilike
// pattern prevents substring false-positives (e.g. "Niger" vs "Nigeria").
export function buildCountryOrConditions(names) {
  const conditions = [];
  for (const countryName of names) {
    const countryRecord = getCountryByName(countryName);
    const isoCode = countryRecord?.code;
    conditions.push(`value.eq.${countryName}`);
    conditions.push(`value.ilike.*"${countryName}"*`);
    if (isoCode) {
      conditions.push(`value.eq.${isoCode}`);
      conditions.push(`value.ilike.*"${isoCode}"*`);
    }
  }
  return conditions.join(',');
}

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
      limit = '20',
      search = '',
      phone = '',
      website_url = '',
      invoicing_email = '',
      invoicing_address = '',
      sortField = 'name',
      sortDir = 'asc',
      customFilters = '',
      coreFilters = '',
      fields = '',
      // Dashboard widget click-through: comma-separated org ids limiting
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
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    // Parse custom field filters (applied at DB level so paging + totals span the
    // whole tenant). Shape: { "<fieldId>": ["A","B"] } for option filters (OR
    // within the field), "__text__:<substring>" / "__bool__:Yes|No" /
    // "__country__:<name>" for the prefixed encodings, a legacy plain string
    // from an old saved view, or an operator object like
    // { "op": "none_of", "value": [...] } / { "op": "empty" }.
    let parsedCustomFilters = {};
    if (customFilters && customFilters.trim()) {
      try {
        const obj = JSON.parse(customFilters);
        if (obj && typeof obj === 'object') {
          for (const [fieldId, raw] of Object.entries(obj)) {
            const entry = normalizeCustomFilterEntry(raw);
            if (entry !== null) parsedCustomFilters[fieldId] = entry;
          }
        }
      } catch {
        // Ignore malformed filter param and fall back to no custom filtering
      }
    }
    // Cap the number of custom filters to avoid pathological query expansion.
    const MAX_CUSTOM_FILTERS = 20;
    const customFilterEntries = Object.entries(parsedCustomFilters).slice(0, MAX_CUSTOM_FILTERS);

    // Direct-column filters with operators ({ "phone": { op, value }, ... }).
    const coreFilterEntries = parseCoreFilters(coreFilters, CORE_FILTER_COLUMNS);

    // For each active custom filter add an aliased join on
    // organization_preference_value. Positive operators use an inner join so
    // the join restricts (and counts) orgs across the entire tenant; negative
    // operators use a left join whose matches are then excluded
    // (`.is(alias, null)`), so orgs without any row also qualify.
    const buildSelect = (base) => {
      let sel = base;
      customFilterEntries.forEach(([, entry], idx) => {
        const joinType = prefEntryNeedsAntiJoin(entry) ? '!left' : '!inner';
        sel += `, cf${idx}:organization_preference_value${joinType}(field_id, value)`;
      });
      return sel;
    };

    const applyFilters = (query) => {
      query = query.eq('tenant_id', tenantId);
      if (drillIds.length > 0) {
        query = query.in('id', drillIds);
      }
      customFilterEntries.forEach(([fieldId, entry], idx) => {
        const alias = `cf${idx}`;
        query = applyPrefFilterEntry(query, alias, fieldId, entry, {
          buildCountryConditions: buildCountryOrConditions,
        });
        if (prefEntryNeedsAntiJoin(entry)) {
          // Anti-join: keep only orgs with NO matching preference-value row.
          query = query.is(alias, null);
        }
      });
      for (const coreEntry of coreFilterEntries) {
        query = applyDirectColumnFilter(query, coreEntry);
      }
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
            // Unique ordering keeps ranged paging stable (no skipped/repeated rows).
            .order('id', { ascending: true })
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
        // Unique ordering keeps ranged paging stable (no skipped/repeated rows).
        idQuery = applyFilters(idQuery).order('id', { ascending: true }).range(from, from + PAGE - 1);
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
