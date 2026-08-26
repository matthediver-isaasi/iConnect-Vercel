const MAX_SEARCH_LENGTH = 100;
const MAX_PAGE_SIZE = 100;
const COUNT_PAGE_SIZE = 1000;

export function normalizeExternalSubscriberSearch(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s@._+'-]/gu, '')
    .slice(0, MAX_SEARCH_LENGTH);
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

export function applyExternalSubscriberFilters(query, { tenantId, categoryId, search }) {
  let filteredQuery = query
    .eq('tenant_id', tenantId)
    .eq('communication_category_id', categoryId)
    .eq('opted_out', false);

  const normalizedSearch = normalizeExternalSubscriberSearch(search);
  for (const token of normalizedSearch.split(' ').filter(Boolean)) {
    const pattern = `%${token}%`;
    filteredQuery = filteredQuery.or(
      `first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern}`
    );
  }

  return filteredQuery;
}

export async function countExternalSubscribersByCategory({
  database,
  tenantId,
  pageSize = COUNT_PAGE_SIZE,
}) {
  const normalizedPageSize = positiveInteger(pageSize, COUNT_PAGE_SIZE);
  const counts = {};

  for (let offset = 0; ; offset += normalizedPageSize) {
    const { data, error } = await database
      .from('email_subscriber')
      .select('id, communication_category_id')
      .eq('tenant_id', tenantId)
      .eq('opted_out', false)
      .order('id', { ascending: true })
      .range(offset, offset + normalizedPageSize - 1);

    if (error) throw error;

    const subscribers = data || [];
    for (const subscriber of subscribers) {
      const categoryId = subscriber.communication_category_id;
      if (categoryId) {
        counts[categoryId] = (counts[categoryId] || 0) + 1;
      }
    }

    if (subscribers.length < normalizedPageSize) break;
  }

  return counts;
}

export async function listExternalSubscribers({
  database,
  tenantId,
  categoryId,
  search,
  page,
  perPage,
}) {
  const normalizedPage = positiveInteger(page, 1);
  const normalizedPerPage = positiveInteger(perPage, 20, MAX_PAGE_SIZE);
  const offset = (normalizedPage - 1) * normalizedPerPage;

  const resultQuery = applyExternalSubscriberFilters(
    database
      .from('email_subscriber')
      .select('id, email, first_name, last_name, subscribed_at, opted_out, form_id'),
    { tenantId, categoryId, search }
  )
    .order('subscribed_at', { ascending: false })
    .range(offset, offset + normalizedPerPage - 1);

  const countQuery = applyExternalSubscriberFilters(
    database
      .from('email_subscriber')
      .select('id', { count: 'exact', head: true }),
    { tenantId, categoryId, search }
  );

  const [
    { data: subscribers, error: subscribersError },
    { count, error: countError },
  ] = await Promise.all([resultQuery, countQuery]);

  if (subscribersError || countError) {
    throw subscribersError || countError;
  }

  return {
    subscribers: subscribers || [],
    total: count || 0,
    page: normalizedPage,
    per_page: normalizedPerPage,
  };
}