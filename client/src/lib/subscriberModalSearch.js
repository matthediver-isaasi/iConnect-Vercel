export function normalizeSubscriberSearch(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function filterMemberSubscribers(members, search, orgLookup = {}, roleLookup = {}) {
  const normalizedSearch = normalizeSubscriberSearch(search);
  if (!normalizedSearch) return members;

  return members.filter((member) => {
    const searchableValues = [
      [member.first_name, member.last_name].filter(Boolean).join(' '),
      member.email,
      member.organization_id && orgLookup[member.organization_id],
      member.role_id && roleLookup[member.role_id],
    ];

    return searchableValues.some((value) =>
      normalizeSubscriberSearch(value).includes(normalizedSearch)
    );
  });
}

export function paginateSubscriberResults(items, requestedPage, perPage) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const currentPage = Math.min(Math.max(1, Number(requestedPage) || 1), totalPages);
  const startIndex = (currentPage - 1) * perPage;

  return {
    items: items.slice(startIndex, startIndex + perPage),
    total,
    totalPages,
    currentPage,
    rangeStart: total === 0 ? 0 : startIndex + 1,
    rangeEnd: Math.min(startIndex + perPage, total),
  };
}

export function getSubscriberEmptyState(unfilteredTotal, filteredTotal, search) {
  if (filteredTotal > 0) return null;
  return unfilteredTotal > 0 && normalizeSubscriberSearch(search) ? 'no-match' : 'empty';
}

export function getPageAfterRemoval(currentPage, currentTotal, perPage) {
  const remainingTotal = Math.max(0, currentTotal - 1);
  const remainingPages = Math.max(1, Math.ceil(remainingTotal / perPage));
  return Math.min(Math.max(1, currentPage), remainingPages);
}

export function beginExternalSubscriberRequest(context, page, search) {
  return {
    ...context,
    externalPage: Math.max(1, Number(page) || 1),
    externalSearch: String(search || ''),
    externalActionGeneration: (context.externalActionGeneration || 0) + 1,
  };
}

export function createLatestRequestTracker() {
  let latestRequestId = 0;

  return {
    begin() {
      latestRequestId += 1;
      return latestRequestId;
    },
    invalidate() {
      latestRequestId += 1;
    },
    isLatest(requestId) {
      return requestId === latestRequestId;
    },
  };
}

export async function fetchAllExternalSubscribers({
  categoryId,
  fetchImpl = fetch,
  pageSize = 100,
}) {
  const subscribers = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;

  while (subscribers.length < total) {
    const params = new URLSearchParams({
      category_id: categoryId,
      page: String(page),
      per_page: String(pageSize),
    });
    const response = await fetchImpl(`/api/admin/external-subscribers?${params}`, {
      credentials: 'include',
    });
    if (!response.ok) {
      throw new Error('Failed to fetch external subscribers for export');
    }

    const data = await response.json();
    const pageSubscribers = data.subscribers || [];
    total = Number(data.total) || 0;
    subscribers.push(...pageSubscribers);

    if (pageSubscribers.length === 0) break;
    page += 1;
  }

  return subscribers;
}