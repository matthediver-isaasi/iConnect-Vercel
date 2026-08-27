// Shared filter contract for the admin members list and its CSV export.
// Both endpoints must filter the exact same population, so the parsing and
// query application live here and are imported by:
//   - api/admin/members/paginated.js
//   - api/admin/members/export-csv.js
import {
  normalizeCustomFilterEntry,
  applyPrefFilterEntry,
  prefEntryNeedsAntiJoin,
  parseCoreFilters,
  applyDirectColumnFilter,
} from './prefValueOptionFilter.js';

// Direct member columns filterable through the coreFilters param.
export const MEMBER_CORE_FILTER_COLUMNS = {
  job_title: {},
  mobile: {},
  organization_id: { idColumn: true },
  role_id: { idColumn: true },
};

// Cap the number of custom filters to avoid pathological query expansion.
const MAX_CUSTOM_FILTERS = 20;
const MAX_ORGANIZATION_FILTERS = 20;
const MAX_ID_LIST = 100;

const parseIdList = (raw) =>
  (raw && raw !== 'all' ? String(raw).split(',') : [])
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, MAX_ID_LIST);

// Parse the shared list/export filter params into one context object.
export function parseMemberListFilters({
  search = '',
  organizationId = '',
  roleId = '',
  status = 'all',
  customFilters = '',
  organizationFilters = '',
  coreFilters = '',
} = {}) {
  const parsePreferenceFilters = (rawFilters, max) => {
    const parsed = {};
    if (!rawFilters || !String(rawFilters).trim()) return [];
    try {
      const obj = JSON.parse(rawFilters);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const [fieldId, raw] of Object.entries(obj)) {
          if (typeof fieldId !== 'string' || !fieldId.trim()) continue;
          const entry = normalizeCustomFilterEntry(raw);
          if (entry !== null) parsed[fieldId] = entry;
        }
      }
    } catch {
      return [];
    }
    return Object.entries(parsed).slice(0, max);
  };
  return {
    search: typeof search === 'string' ? search : '',
    // organizationId/roleId accept a single id (legacy) or a comma-separated
    // list (multi-select filters); matches ANY of the ids.
    organizationIds: parseIdList(organizationId),
    roleIds: parseIdList(roleId),
    status,
    customFilterEntries: parsePreferenceFilters(customFilters, MAX_CUSTOM_FILTERS),
    organizationFilterEntries: parsePreferenceFilters(organizationFilters, MAX_ORGANIZATION_FILTERS),
    coreFilterEntries: parseCoreFilters(coreFilters, MEMBER_CORE_FILTER_COLUMNS),
  };
}

// Organisation filter ids are client input. Keep only active, tenant-owned
// organisation fields that are actually enabled for CRM filtering.
export async function validateOrganizationFilterEntries(supabaseClient, tenantId, ctx) {
  if (ctx.organizationFilterEntries.length === 0) return ctx;
  const ids = ctx.organizationFilterEntries.map(([fieldId]) => fieldId);
  const { data, error } = await supabaseClient
    .from('preference_field')
    .select('id, show_in_admin_filter, show_in_admin_list')
    .eq('tenant_id', tenantId)
    .eq('entity_scope', 'organization')
    .eq('is_active', true)
    .in('id', ids);
  if (error) throw new Error(`Organisation filter validation failed: ${error.message}`);
  const allowed = new Set(
    (data || [])
      .filter(field => field.show_in_admin_filter === true
        || (field.show_in_admin_filter !== false && field.show_in_admin_list !== false))
      .map(field => field.id)
  );
  ctx.organizationFilterEntries = ctx.organizationFilterEntries
    .filter(([fieldId]) => allowed.has(fieldId));
  return ctx;
}

// Aliased member_preference_value joins the select clause must include for the
// active custom filters. Positive ops inner-join; negative ops left-join and
// are excluded via `.is(alias, null)` in applyMemberListFilters.
export function memberFilterSelectJoins(ctx) {
  const memberJoins = ctx.customFilterEntries
    .map(([, entry], idx) => {
      const joinType = prefEntryNeedsAntiJoin(entry) ? '!left' : '!inner';
      return `,\n      cf${idx}:member_preference_value${joinType}(field_id, value)`;
    })
    .join('');
  const organizationJoins = ctx.organizationFilterEntries
    .map(([, entry], idx) => {
      const joinType = prefEntryNeedsAntiJoin(entry) ? '!left' : '!inner';
      const orgJoinType = prefEntryNeedsAntiJoin(entry) ? '!left' : '!inner';
      return `,\n      orgf${idx}:organization${orgJoinType}(tenant_id, opv${idx}:organization_preference_value${joinType}(field_id, value))`;
    })
    .join('');
  return memberJoins + organizationJoins;
}

// Apply the parsed filter context to a supabase query on `member`.
export function applyMemberListFilters(query, ctx, { tenantId } = {}) {
  ctx.customFilterEntries.forEach(([fieldId, entry], idx) => {
    const alias = `cf${idx}`;
    query = applyPrefFilterEntry(query, alias, fieldId, entry);
    if (prefEntryNeedsAntiJoin(entry)) {
      // Anti-join: keep only members with NO matching preference-value row.
      query = query.is(alias, null);
    }
  });

  ctx.organizationFilterEntries.forEach(([fieldId, entry], idx) => {
    const orgAlias = `orgf${idx}`;
    const valueAlias = `${orgAlias}.opv${idx}`;
    // A member must only filter through an organisation belonging to the same
    // tenant. For anti-joins, an unlinked/cross-tenant organisation behaves as
    // no value and therefore satisfies negative/empty operators.
    if (tenantId) query = query.eq(`${orgAlias}.tenant_id`, tenantId);
    query = applyPrefFilterEntry(query, valueAlias, fieldId, entry);
    if (prefEntryNeedsAntiJoin(entry)) query = query.is(valueAlias, null);
  });

  for (const coreEntry of ctx.coreFilterEntries) {
    query = applyDirectColumnFilter(query, coreEntry);
  }

  if (ctx.search && ctx.search.trim()) {
    const tokens = ctx.search.trim().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      const pattern = `%${token.toLowerCase()}%`;
      query = query.or(`first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern},mobile.ilike.${pattern},job_title.ilike.${pattern}`);
    }
  }

  if (ctx.organizationIds.length === 1) {
    query = query.eq('organization_id', ctx.organizationIds[0]);
  } else if (ctx.organizationIds.length > 1) {
    query = query.in('organization_id', ctx.organizationIds);
  }

  if (ctx.roleIds.length === 1) {
    query = query.eq('role_id', ctx.roleIds[0]);
  } else if (ctx.roleIds.length > 1) {
    query = query.in('role_id', ctx.roleIds);
  }

  if (ctx.status === 'active') {
    query = query.eq('login_enabled', true);
  } else if (ctx.status === 'disabled') {
    query = query.eq('login_enabled', false);
  }

  return query;
}

// Strip the join-only cf aliases from a returned member row (in place).
export function stripFilterJoinAliases(row, ctx) {
  ctx.customFilterEntries.forEach((_, idx) => { delete row[`cf${idx}`]; });
  ctx.organizationFilterEntries.forEach((_, idx) => { delete row[`orgf${idx}`]; });
  return row;
}
