export const GUEST_WRITER_SEARCH_MAX_LENGTH = 200;
export const GUEST_WRITER_PAGE_MAX_LIMIT = 100;
export const GUEST_WRITER_DEFAULT_LIMIT = 100;
export const GUEST_WRITER_MAX_OFFSET = Number.MAX_SAFE_INTEGER - GUEST_WRITER_PAGE_MAX_LIMIT;

const GUEST_WRITER_SEARCH_FIELDS = [
  'full_name',
  'email',
  'organization',
  'job_title',
];

function readSingleQueryValue(value, name) {
  if (value === undefined) return { value: undefined };
  if (typeof value !== 'string') {
    return { error: `${name} must be a single string value` };
  }
  return { value };
}

function parseBoundedInteger(value, {
  name,
  minimum,
  maximum = Number.MAX_SAFE_INTEGER,
}) {
  const single = readSingleQueryValue(value, name);
  if (single.error) return single;
  if (single.value === undefined) return { value: undefined };
  if (!/^(0|[1-9]\d*)$/.test(single.value)) {
    return { error: `${name} must be an integer between ${minimum} and ${maximum}` };
  }
  const parsed = Number(single.value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return { error: `${name} must be an integer between ${minimum} and ${maximum}` };
  }
  return { value: parsed };
}

/**
 * GuestWriter pagination is deliberately opt-in. A request that omits both
 * limit and offset retains the generic entity endpoint's legacy list shape and
 * PostgREST behaviour.
 */
export function parseGuestWriterListQuery(query = {}) {
  const rawSearch = readSingleQueryValue(query.search, 'search');
  if (rawSearch.error) return rawSearch;

  const search = rawSearch.value?.trim() || '';
  if (search.length > GUEST_WRITER_SEARCH_MAX_LENGTH) {
    return {
      error: `search must be at most ${GUEST_WRITER_SEARCH_MAX_LENGTH} characters`,
    };
  }

  const limitResult = parseBoundedInteger(query.limit, {
    name: 'limit',
    minimum: 1,
    maximum: GUEST_WRITER_PAGE_MAX_LIMIT,
  });
  if (limitResult.error) return limitResult;

  const offsetResult = parseBoundedInteger(query.offset, {
    name: 'offset',
    minimum: 0,
    maximum: GUEST_WRITER_MAX_OFFSET,
  });
  if (offsetResult.error) return offsetResult;

  const paginated = limitResult.value !== undefined || offsetResult.value !== undefined;
  return {
    value: {
      search,
      paginated,
      limit: paginated ? (limitResult.value ?? GUEST_WRITER_DEFAULT_LIMIT) : undefined,
      offset: paginated ? (offsetResult.value ?? 0) : undefined,
    },
  };
}

export function escapeCaseInsensitiveRegexLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function quotePostgrestLogicValue(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildGuestWriterSearchExpression(search) {
  const pattern = `.*${escapeCaseInsensitiveRegexLiteral(search)}.*`;
  const quotedPattern = quotePostgrestLogicValue(pattern);
  return GUEST_WRITER_SEARCH_FIELDS
    .map((field) => `${field}.imatch.${quotedPattern}`)
    .join(',');
}

/**
 * Apply the literal search before ordering/range so PostgREST's exact count is
 * calculated from the complete tenant-scoped match set, not from one page.
 */
export function applyGuestWriterListQuery(query, options) {
  let nextQuery = query;
  if (options.search) {
    nextQuery = nextQuery.or(buildGuestWriterSearchExpression(options.search));
  }
  if (options.paginated) {
    nextQuery = nextQuery
      .order('full_name', { ascending: true })
      .order('id', { ascending: true })
      .range(options.offset, options.offset + options.limit - 1);
  }
  return nextQuery;
}