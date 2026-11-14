import { useQuery } from '@tanstack/react-query';
import { decisionRequest } from './useAwardDecisions';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const eventLinksReady = query => query.isSuccess && !query.isError && !query.isFetching && Array.isArray(query.data);
export const publicationScopeLabel = (id, links = []) => {
  if (!id) return 'Award-wide';
  const link = links.find(row => row.id === id);
  return link ? `${link.type === 'complex' ? 'Complex event' : 'Event'}: ${link.title} · association ${id}` : `Recorded event association ${id} (not in the current discovered catalog)`;
};
export function usePublicationEventLinks(tenant, awardId, enabled = true) {
  return useQuery({
    queryKey: ['award-publication-event-links', tenant.scopeKey, awardId], enabled,
    queryFn: async ({ signal }) => {
      const links = [], seen = new Set();
      let total;
      for (let page = 1; page <= 10000; page += 1) {
        const data = await decisionRequest(tenant, `/api/awards/publications?awardId=${encodeURIComponent(awardId)}&scope=eventLinks&page=${page}`, undefined, signal);
        if (!Array.isArray(data?.links) || data.page !== page || data.pageSize !== 50 || !Number.isSafeInteger(data.total) || data.total < 0
          || (total !== undefined && total !== data.total) || data.links.length !== Math.min(50, Math.max(0, data.total - (page - 1) * 50))) throw new Error('The full event-association catalog changed or is incomplete. No partial list has been used.');
        total = data.total;
        for (const link of data.links) {
          if (!uuid.test(link?.id || '') || seen.has(link.id) || !uuid.test(link.eventId || '') || !['event', 'complex'].includes(link.type)
            || typeof link.title !== 'string' || !['public', 'member'].includes(link.audience)
            || typeof link.showInformation !== 'boolean' || typeof link.showApplicationLink !== 'boolean') throw new Error('The event-association catalog contains invalid or duplicate records. Reload it before choosing a new event target.');
          seen.add(link.id); links.push(link);
        }
        if (links.length === total) return links;
      }
      throw new Error('The complete event-association catalog exceeds the server page limit. No partial choices are available.');
    },
    retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
}
