// Keep the existing query prefixes so legacy prefix invalidations still work.
export const subscriberInputKey = (prefix, tenantId) => [prefix, tenantId];

export function subscriberInputState(tenantId, queries) {
  if (!tenantId) return 'loading';
  if (queries.some(query => query.isFetching)) {
    return queries.every(query => query.data !== undefined) ? 'refreshing' : 'loading';
  }
  if (queries.some(query => query.isError)) return 'unavailable';
  return queries.every(query => query.isSuccess && query.data !== undefined) ? 'ready' : 'loading';
}

export const subscriberStateLabel = state => ({
  loading: 'Loading subscribers…',
  refreshing: 'Refreshing subscribers…',
  unavailable: 'Subscriber count unavailable',
})[state];

export function invalidateSubscriberInputs(queryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['member-communication-preferences'] }),
    queryClient.invalidateQueries({ queryKey: ['all-members-for-export'] }),
  ]);
}

// Pin every page to the tenant that owns the query key, including after a switch.
export async function fetchSubscriberEntity(entity, tenantId, signal, fetchImpl = fetch) {
  if (!tenantId) throw new Error('Tenant context unavailable');
  const records = [];
  for (let offset = 0; ; offset += 1000) {
    const params = new URLSearchParams({ sort: JSON.stringify({ id: 'asc' }), limit: '1000', offset: String(offset) });
    const response = await fetchImpl(`/api/entities/${entity}?${params}`, {
      credentials: 'include', headers: { 'X-Tenant-Id': tenantId }, signal,
    });
    if (!response.ok) throw new Error('Subscriber inputs could not be loaded');
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error('Invalid subscriber inputs');
    records.push(...batch);
    if (batch.length < 1000) return records;
  }
}
