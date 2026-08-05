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
  coreFilters = '',
} = {}) {
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
  return {
    search: typeof search === 'string' ? search : '',
    // organizationId/roleId accept a single id (legacy) or a comma-separated
    // list (multi-select filters); matches ANY of the ids.
    organizationIds: parseIdList(organizationId),
    roleIds: parseIdList(roleId),
    status,
    customFilterEntries: Object.entries(parsedCustomFilters).slice(0, MAX_CUSTOM_FILTERS),
    coreFilterEntries: parseCoreFilters(coreFilters, MEMBER_CORE_FILTER_COLUMNS),
  };
}

// Aliased member_preference_value joins the select clause must include for the
// active custom filters. Positive ops inner-join; negative ops left-join and
// are excluded via `.is(alias, null)` in applyMemberListFilters.
export function memberFilterSelectJoins(ctx) {
  return ctx.customFilterEntries
    .map(([, entry], idx) => {
      const joinType = prefEntryNeedsAntiJoin(entry) ? '!left' : '!inner';
      return `,\n      cf${idx}:member_preference_value${joinType}(field_id, value)`;
    })
    .join('');
}

// Apply the parsed filter context to a supabase query on `member`.
export function applyMemberListFilters(query, ctx) {
  ctx.customFilterEntries.forEach(([fieldId, entry], idx) => {
    const alias = `cf${idx}`;
    query = applyPrefFilterEntry(query, alias, fieldId, entry);
    if (prefEntryNeedsAntiJoin(entry)) {
      // Anti-join: keep only members with NO matching preference-value row.
      query = query.is(alias, null);
    }
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
  return row;
}
