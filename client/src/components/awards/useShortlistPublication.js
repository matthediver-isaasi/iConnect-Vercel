import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { communicationRequest, communicationUuid } from './useAwardCommunications';

export const shortlistCatalogKey = (tenant, awardId) => ['award-shortlist-publication', tenant.scopeKey, awardId];
export const shortlistGroupKey = row => `${row.round_id}:${row.application_id}`;
export const shortlistStreamKey = row => `${shortlistGroupKey(row)}:${row.audience}:${row.event_link_id || 'award'}`;
export function shortlistStreams(publications) {
  const streams = new Map(), versions = new Set(), counts = new Map();
  for (const row of publications) {
    const key = shortlistStreamKey(row), revisionKey = `${key}:${row.revision}`;
    if (!communicationUuid(row.shortlist_id) || !communicationUuid(row.round_id) || !communicationUuid(row.application_id) || (row.event_link_id != null && !communicationUuid(row.event_link_id)) || !['public', 'member'].includes(row.audience)
      || !['publish', 'correct', 'retract'].includes(row.action) || !Number.isSafeInteger(row.revision) || row.revision < 1 || versions.has(revisionKey)) {
      throw new Error('Publication streams are incomplete or ambiguous. No expected revision can safely be calculated.');
    }
    versions.add(revisionKey);
    counts.set(key, (counts.get(key) || 0) + 1);
    if (!streams.has(key) || streams.get(key).revision < row.revision) streams.set(key, row);
  }
  for (const [key, head] of streams) if (counts.get(key) !== head.revision) throw new Error('Publication history has a gap in an audience/event stream. Reload; optimistic revisions cannot be calculated from partial history.');
  return streams;
}
export const shortlistPublicationRequest = (tenant, body) => communicationRequest(tenant, '/api/awards/shortlist-publications', { body });
export function useShortlistPublicationCatalog(tenant, awardId) {
  return useQuery({ queryKey: shortlistCatalogKey(tenant, awardId), queryFn: async ({ signal }) => {
    const shortlists = [], publications = [], decisionIds = new Set(), publicationIds = new Set();
    let total, publicationTotal;
    for (let page = 1; page <= 10000; page += 1) {
      const result = await communicationRequest(tenant, `/api/awards/shortlist-publications?awardId=${encodeURIComponent(awardId)}&page=${page}`, { signal });
      if (result.page !== page || !Number.isSafeInteger(result.pageSize) || result.pageSize < 1
        || !Array.isArray(result.shortlists) || !Array.isArray(result.publications)
        || !Number.isSafeInteger(result.total) || result.total < 0 || !Number.isSafeInteger(result.publicationTotal) || result.publicationTotal < 0
        || (total !== undefined && (total !== result.total || publicationTotal !== result.publicationTotal))) throw new Error('Shortlist decisions or publication history changed during loading. Reload; no partial stream history is used.');
      total = result.total; publicationTotal = result.publicationTotal;
      for (const [rows, target, seen] of [[result.shortlists, shortlists, decisionIds], [result.publications, publications, publicationIds]]) {
        for (const row of rows) {
          if (!communicationUuid(row.id) || seen.has(row.id)) throw new Error('Shortlist catalog pagination changed. Reload the complete catalog.');
          seen.add(row.id); target.push(row);
        }
      }
      if (shortlists.length === total && publications.length === publicationTotal) {
        if (shortlists.some(row => !communicationUuid(row.round_id) || !communicationUuid(row.application_id) || !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.reference !== 'string' || typeof row.round_name !== 'string')
          || publications.some(row => !row.safe_projection || typeof row.safe_projection !== 'object' || Array.isArray(row.safe_projection)
            || ['title', 'recipient', 'summary'].some(key => row.safe_projection[key] != null && typeof row.safe_projection[key] !== 'string'))) throw new Error('The protected shortlist catalog contains unreadable decisions or safe projections.');
        if (new Set(shortlists.map(shortlistGroupKey)).size !== shortlists.length) throw new Error('Current confirmed decisions are ambiguous. Reload before continuing.');
        shortlistStreams(publications);
        return { shortlists, publications };
      }
      if (shortlists.length > total || publications.length > publicationTotal
        || (shortlists.length < total && result.shortlists.length < result.pageSize)
        || (publications.length < publicationTotal && result.publications.length < result.pageSize)) throw new Error('The complete decisions and publication history were not returned. Commands remain blocked.');
    }
    throw new Error('The shortlist catalog exceeds the page limit. No partial history is used.');
  }, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
}
export function useShortlistEventChoices(tenant, type, enabled) {
  return useQuery({ queryKey: ['award-shortlist-events', tenant.scopeKey, type], enabled: enabled && ['event', 'complex'].includes(type),
    queryFn: async ({ signal }) => {
      const entity = type === 'complex' ? base44.entities.ComplexEvent : base44.entities.Event, rows = [], seen = new Set(), limit = 1000;
      for (let offset = 0; offset < 1000000; offset += limit) {
        tenant.assertCurrent();
        const batch = await entity.list({ limit, offset, sort: { id: 'asc' }, signal });
        tenant.assertCurrent();
        if (!Array.isArray(batch)) throw new Error('The event catalog could not be loaded completely.');
        for (const row of batch) {
          if (!row.id || seen.has(row.id)) throw new Error('Event discovery changed while loading. Reload; no partial choices are used.');
          seen.add(row.id); rows.push(row);
        }
        if (batch.length < limit) return rows;
      }
      throw new Error('Event discovery exceeds the page limit. No partial choices are used.');
    }, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
}
export function useShortlistEventLinks(tenant, award, type, eventId, enabled) {
  return useQuery({ queryKey: ['award-shortlist-event-links', tenant.scopeKey, award.id, award.programme_id, type, eventId],
    enabled: enabled && !!eventId && ['event', 'complex'].includes(type), queryFn: async ({ signal }) => {
      const rows = [], seen = new Set(); let total;
      for (let page = 1; page <= 10000; page += 1) {
        const result = await communicationRequest(tenant, `/api/awards/events?eventId=${encodeURIComponent(eventId)}&type=${type}&page=${page}`, { signal });
        if (result.page !== page || !Array.isArray(result.links) || !Number.isSafeInteger(result.total) || result.total < 0
          || !Number.isSafeInteger(result.pageSize) || result.pageSize < 1 || (total !== undefined && result.total !== total)) throw new Error('Event associations changed or were incomplete. Reload before selecting a scope.');
        total = result.total;
        for (const row of result.links) {
          if (!row.id || seen.has(row.id)) throw new Error('Event association pagination changed. No partial choices are used.');
          seen.add(row.id); rows.push(row);
        }
        if (rows.length === total) return rows.filter(row => row.award_id === award.id || (!!award.programme_id && row.programme_id === award.programme_id));
        if (rows.length > total || result.links.length < result.pageSize) throw new Error('The complete event association catalog was not returned.');
      }
      throw new Error('Event association discovery exceeds the page limit.');
    }, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
}
