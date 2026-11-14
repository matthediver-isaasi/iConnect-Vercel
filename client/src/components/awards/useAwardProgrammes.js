import { useQuery } from '@tanstack/react-query';
import { adminFetch } from '@/lib/adminFetch';

export const programmeQueryKey = tenant => ['awards-programmes', tenant.scopeKey, 'all'];
export const isProgrammeArchived = programme => Boolean(programme?.archived_at || programme?.archived);

async function programmeRequest(tenant, url, options = {}) {
  tenant.assertCurrent();
  const response = await adminFetch(url, options, tenant.tenantId);
  const result = await response.json();
  tenant.assertCurrent();
  if (!response.ok) throw new Error(result.error || 'Unable to load programmes.');
  return result;
}

export function useAwardProgrammes(tenant) {
  return useQuery({
    queryKey: programmeQueryKey(tenant),
    queryFn: async ({ signal }) => {
      const programmes = [], ids = new Set();
      let expectedTotal;
      for (let page = 1; page <= 10000; page += 1) {
        const result = await programmeRequest(tenant, `/api/awards/programmes?page=${page}`, { signal });
        if (!Array.isArray(result.programmes) || !Number.isSafeInteger(result.total) || result.total < 0
          || result.page !== page || !Number.isSafeInteger(result.pageSize) || result.pageSize < 1) {
          throw new Error('The programme list response is incomplete. Retry loading the full list.');
        }
        if (expectedTotal !== undefined && expectedTotal !== result.total) throw new Error('The programme list changed while loading. Retry to load a consistent list.');
        expectedTotal = result.total;
        for (const programme of result.programmes) {
          if (!programme.id || ids.has(programme.id)) throw new Error('The programme list changed while loading. Retry to load the full list.');
          ids.add(programme.id); programmes.push(programme);
        }
        if (programmes.length === expectedTotal) return programmes;
        if (programmes.length > expectedTotal || result.programmes.length < result.pageSize) throw new Error('Not all programmes could be loaded. Retry before choosing a programme.');
      }
      throw new Error('The programme list exceeds the supported page limit. No partial list has been used.');
    },
    refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false,
  });
}

export async function saveAwardProgramme(tenant, programme, payload) {
  const result = await programmeRequest(tenant, '/api/awards/programmes', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Awards-Request': '1' },
    body: JSON.stringify({ id: programme?.id || null, version: programme?.version || null, payload }),
  });
  if (!result.programme?.id || !Number.isSafeInteger(result.programme.version)) throw new Error('The server did not confirm a programme version. Reload the list before retrying.');
  return result.programme;
}
