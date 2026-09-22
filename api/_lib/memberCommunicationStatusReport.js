import {
  buildCommunicationStatusReportRow,
  parseCommunicationStatusReportFilters,
  reportCategoryMetadata,
} from '../../shared/memberCommunicationStatusReport.js';

const DATABASE_PAGE_SIZE = 1000;
const MEMBER_BATCH_SIZE = 100;
const MAX_EXPORT_ROWS = 250000;

export async function fetchAllCommunicationReportRows(buildQuery, orderColumn = 'id') {
  const rows = [];
  for (let from = 0; ; from += DATABASE_PAGE_SIZE) {
    let query = buildQuery().order(orderColumn, { ascending: true });
    if (orderColumn !== 'id') query = query.order('id', { ascending: true });
    const { data, error } = await query.range(from, from + DATABASE_PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < DATABASE_PAGE_SIZE) break;
  }
  return rows;
}

function chunks(values, size = MEMBER_BATCH_SIZE) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function quotePostgrestValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildCommunicationReportSearchFilter(token) {
  // Use PostgreSQL's case-insensitive regex operator rather than ilike in the
  // raw OR expression. PostgREST treats every `*` in ilike values as `%`, which
  // prevents literal-star searches. Regex metacharacters are escaped first and
  // the PostgREST quoted-string layer is escaped separately.
  const literalRegex = `.*${String(token).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}.*`;
  const value = quotePostgrestValue(literalRegex);
  return `first_name.imatch.${value},last_name.imatch.${value},email.imatch.${value}`;
}

export function applyCommunicationReportMemberFilters(
  query,
  filters,
  tenantId,
  { summaryOptIn = false } = {},
) {
  query = query
    .eq('tenant_id', tenantId)
    // Keep members without an email address. SQL `NOT LIKE` alone evaluates to
    // NULL for those rows and silently removes them. Supabase combines this OR
    // group with the preceding tenant equality using AND.
    .or('email.is.null,email.not.like.deleted\\_%@deleted.local');

  if (filters.search) {
    for (const token of filters.search.split(/\s+/).filter(Boolean)) {
      query = query.or(buildCommunicationReportSearchFilter(token));
    }
  }
  if (filters.organizationId) query = query.eq('organization_id', filters.organizationId);
  if (filters.roleId) query = query.eq('role_id', filters.roleId);
  if (filters.globalOptOut === 'yes') query = query.eq('communications_opted_out_all', true);
  if (filters.globalOptOut === 'no') query = query.or(
    'communications_opted_out_all.eq.false,communications_opted_out_all.is.null',
  );

  if (filters.categoryId && filters.categoryStatus) {
    query = query
      .eq('category_filter.category_id', filters.categoryId)
      .eq('category_filter.tenant_id', tenantId)
      .eq('category_filter.is_subscribed', true);
    if (filters.categoryStatus === 'not_opted_in') query = query.is('category_filter', null);
  }
  if (summaryOptIn) {
    query = query
      .eq('any_opt_in.tenant_id', tenantId)
      .eq('any_opt_in.is_subscribed', true);
  }
  return query;
}

function memberSelect(filters, { summaryOptIn = false, countOnly = false } = {}) {
  const relation = filters.categoryId && filters.categoryStatus
    ? `, category_filter:member_communication_preference!${filters.categoryStatus === 'opted_in' ? 'inner' : 'left'}(id)`
    : '';
  const optInRelation = summaryOptIn
    ? ', any_opt_in:member_communication_preference!inner(id)'
    : '';
  if (countOnly) return `id${relation}${optInRelation}`;
  return `id, first_name, last_name, email, organization_id, role_id,
    login_enabled, communications_opted_out_all${relation}${optInRelation}`;
}

function buildMemberQuery(database, tenantId, filters, options = {}) {
  const query = database
    .from('member')
    .select(memberSelect(filters, options), options.countOnly
      ? { count: 'exact', head: true }
      : { count: 'exact' });
  return applyCommunicationReportMemberFilters(query, filters, tenantId, options);
}

async function exactCount(database, tenantId, filters, overrides = {}, options = {}) {
  const merged = { ...filters, ...overrides };
  const { count, error } = await buildMemberQuery(database, tenantId, merged, {
    countOnly: true,
    ...options,
  });
  if (error) throw error;
  if (!Number.isInteger(count)) throw new Error('Report query did not return an exact count');
  return count;
}

async function loadDefinitions(database, tenantId) {
  const [categories, assignments, organizations, roles] = await Promise.all([
    fetchAllCommunicationReportRows(() => database
      .from('communication_category')
      .select('id, name, display_order, is_active, is_public, member_enabled')
      .eq('tenant_id', tenantId), 'display_order'),
    fetchAllCommunicationReportRows(() => database
      .from('communication_category_role')
      .select('id, category_id, role_id')
      .eq('tenant_id', tenantId)),
    fetchAllCommunicationReportRows(() => database
      .from('organization')
      .select('id, name')
      .eq('tenant_id', tenantId)),
    fetchAllCommunicationReportRows(() => database
      .from('role')
      .select('id, name')
      .eq('tenant_id', tenantId)),
  ]);
  // display_order may not be unique, so make the final ordering deterministic.
  categories.sort((a, b) =>
    (a.display_order ?? 0) - (b.display_order ?? 0)
    || String(a.id).localeCompare(String(b.id)));
  const rolesByCategory = new Map();
  for (const assignment of assignments) {
    if (!rolesByCategory.has(assignment.category_id)) rolesByCategory.set(assignment.category_id, []);
    rolesByCategory.get(assignment.category_id).push(assignment.role_id);
  }
  organizations.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))
    || String(a.id).localeCompare(String(b.id)));
  roles.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))
    || String(a.id).localeCompare(String(b.id)));
  return { categories, rolesByCategory, organizations, roles };
}

async function loadPreferences(database, tenantId, memberIds) {
  const byMember = new Map(memberIds.map((id) => [id, []]));
  for (const batch of chunks(memberIds)) {
    const preferences = await fetchAllCommunicationReportRows(() => database
      .from('member_communication_preference')
      .select('id, member_id, category_id, is_subscribed')
      .eq('tenant_id', tenantId)
      .in('member_id', batch));
    for (const preference of preferences) {
      if (byMember.has(preference.member_id)) byMember.get(preference.member_id).push(preference);
    }
  }
  return byMember;
}

export async function loadCommunicationStatusReport(database, {
  tenantId,
  query = {},
  includeDefinitions = true,
  definitions = null,
  includeSummary = true,
}) {
  const filters = parseCommunicationStatusReportFilters(query);
  const loadedDefinitions = definitions || await loadDefinitions(database, tenantId);
  const { categories, rolesByCategory, organizations, roles } = loadedDefinitions;
  if (filters.categoryId && !categories.some((category) => category.id === filters.categoryId)) {
    const error = new Error('Unknown communication category');
    error.status = 400;
    throw error;
  }

  let memberQuery = buildMemberQuery(database, tenantId, filters);
  memberQuery = memberQuery
    .order('last_name', { ascending: true, nullsFirst: false })
    .order('first_name', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true })
    .range((filters.page - 1) * filters.limit, filters.page * filters.limit - 1);
  const globallyOptedOutPromise = !includeSummary ? Promise.resolve(null)
    : filters.globalOptOut === 'no'
    ? Promise.resolve(0)
    : exactCount(database, tenantId, filters, { globalOptOut: 'yes' });
  const notGloballyOptedOutPromise = !includeSummary ? Promise.resolve(null)
    : filters.globalOptOut === 'yes'
    ? Promise.resolve(0)
    : exactCount(database, tenantId, filters, { globalOptOut: 'no' });
  const [{ data: members, error: memberError, count }, globallyOptedOut, notGloballyOptedOut, anyOptIn] =
    await Promise.all([
      memberQuery,
      globallyOptedOutPromise,
      notGloballyOptedOutPromise,
      includeSummary
        ? exactCount(database, tenantId, filters, {}, { summaryOptIn: true })
        : Promise.resolve(null),
    ]);
  if (memberError) throw memberError;
  if (!Number.isInteger(count)) throw new Error('Report query did not return an exact count');

  const preferenceByMember = await loadPreferences(
    database,
    tenantId,
    (members || []).map((member) => member.id),
  );
  const organizationById = new Map(organizations.map((organization) => [
    organization.id,
    organization,
  ]));
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const rows = (members || []).map((member) =>
    buildCommunicationStatusReportRow(
      {
        ...member,
        // Never surface joined labels from another tenant if legacy/corrupt
        // foreign keys point across tenant boundaries.
        organization: organizationById.get(member.organization_id) || null,
        role: roleById.get(member.role_id) || null,
      },
      categories,
      preferenceByMember.get(member.id) || [],
      rolesByCategory,
    ));

  return {
    filters,
    categories: includeDefinitions
      ? categories.map((category) => reportCategoryMetadata(category, rolesByCategory))
      : undefined,
    options: includeDefinitions ? {
      organizations: organizations.map(({ id, name }) => ({ id, name: name || '' })),
      roles: roles.map(({ id, name }) => ({ id, name: name || '' })),
    } : undefined,
    rows,
    summary: includeSummary ? {
      filteredMembers: count,
      globallyOptedOut,
      notGloballyOptedOut,
      anyExplicitCategoryOptIn: anyOptIn,
      withAnyCategoryOptIn: anyOptIn,
    } : undefined,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total: count,
      totalPages: Math.ceil(count / filters.limit),
    },
  };
}

export async function loadAllCommunicationStatusRows(database, { tenantId, query = {} }) {
  const definitions = await loadDefinitions(database, tenantId);
  const first = await loadCommunicationStatusReport(database, {
    tenantId,
    query: { ...query, page: 1, limit: 100 },
    definitions,
    includeSummary: false,
  });
  if (first.pagination.total > MAX_EXPORT_ROWS) {
    const error = new Error(
      `This export contains more than ${MAX_EXPORT_ROWS.toLocaleString('en-US')} members. Narrow the filters and try again.`,
    );
    error.status = 413;
    throw error;
  }
  const rows = [...first.rows];
  const expectedPages = Math.ceil(first.pagination.total / 100);
  for (let page = 2; page <= expectedPages; page += 1) {
    const next = await loadCommunicationStatusReport(database, {
      tenantId,
      query: { ...query, page, limit: 100 },
      includeDefinitions: false,
      definitions,
      includeSummary: false,
    });
    if (next.pagination.total !== first.pagination.total) {
      const error = new Error('Report changed while export was being prepared');
      error.status = 409;
      throw error;
    }
    rows.push(...next.rows);
  }
  if (rows.length !== first.pagination.total) {
    const error = new Error('Export row count did not match report total');
    error.status = 409;
    throw error;
  }
  if (new Set(rows.map((row) => row.memberId)).size !== rows.length) {
    const error = new Error('Report changed while export was being prepared');
    error.status = 409;
    throw error;
  }
  return {
    categories: first.categories,
    rows,
    filters: first.filters,
    options: first.options,
  };
}