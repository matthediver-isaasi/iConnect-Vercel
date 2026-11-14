import { useQuery } from '@tanstack/react-query';
import { adminFetch } from '@/lib/adminFetch';
import { listAwardRounds } from '@/lib/awardsApi';
import { formatScore } from '../../../../api/_lib/assessment/scoring.js';

export async function decisionRequest(tenant, url, body, signal) {
  tenant.assertCurrent();
  const response = await adminFetch(url, {
    signal, ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Awards-Request': '1' },
      body: JSON.stringify(body),
    }),
  }, tenant.tenantId);
  const result = await response.json();
  tenant.assertCurrent();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Unable to complete the decision request.'), { status: response.status });
  return result;
}

export function decisionScore(score) {
  if (!score) return 'No score';
  try { return `${formatScore(score)} / 100`; } catch { return 'Score unavailable'; }
}
export function latestOutcomes(outcomes) {
  const latest = new Map();
  for (const outcome of outcomes) {
    const previous = latest.get(outcome.application_id);
    if (!previous || outcome.revision > previous.revision) latest.set(outcome.application_id, outcome);
  }
  return latest;
}
export function publicationStreams(publications, outcomes) {
  const byId = new Map(outcomes.map(outcome => [outcome.id, outcome]));
  const streams = new Map(), revisions = new Set();
  for (const publication of publications) {
    const outcome = byId.get(publication.outcome_revision_id);
    if (!outcome) throw new Error('Publication history references an outcome outside the loaded history. Reload both histories before changing publication or reopening outcomes.');
    const key = `${outcome.application_id}:${publication.audience}:${publication.event_link_id || 'award'}`;
    const revisionKey = `${key}:${publication.revision}`;
    if (!['public', 'member'].includes(publication.audience) || !['publish', 'correct', 'retract'].includes(publication.action)
      || !Number.isSafeInteger(publication.revision) || publication.revision < 1 || revisions.has(revisionKey)
      || (publication.event_link_id != null && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(publication.event_link_id))) {
      throw new Error('Publication stream revisions or scopes are invalid/ambiguous. Reload complete histories before another command.');
    }
    revisions.add(revisionKey);
    const previous = streams.get(key);
    if (!previous || publication.revision > previous.revision) streams.set(key, publication);
  }
  return streams;
}

export function useDecisionRounds(awardId, tenant) {
  return useQuery({
    queryKey: ['award-decision-rounds', tenant.scopeKey, awardId],
    queryFn: async () => {
      const rows = [], seen = new Set();
      let total;
      for (let page = 1; page <= 10000; page += 1) {
        tenant.assertCurrent();
        const result = await listAwardRounds(awardId, page);
        tenant.assertCurrent();
        if (!Array.isArray(result.rounds) || !Number.isSafeInteger(result.total) || result.page !== page || !result.pageSize) throw new Error('The complete round list could not be loaded.');
        if (total !== undefined && total !== result.total) throw new Error('The round list changed while loading. Retry.');
        total = result.total;
        for (const round of result.rounds) {
          if (seen.has(round.id)) throw new Error('The round list changed while loading. Retry.');
          seen.add(round.id); rows.push(round);
        }
        if (rows.length === total) return rows;
        if (!result.rounds.length || rows.length > total) break;
      }
      throw new Error('The round list is incomplete. No partial list has been used.');
    },
    retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
}

export function useOutcomeHistory(awardId, tenant) {
  return useQuery({
    queryKey: ['award-outcome-history', tenant.scopeKey, awardId],
    queryFn: async ({ signal }) => {
      const outcomes = [], categories = [], outcomeIds = new Set(), categoryIds = new Set(), revisions = new Set();
      for (let page = 1; page <= 10000; page += 1) {
        const result = await decisionRequest(tenant, `/api/awards/outcomes?awardId=${encodeURIComponent(awardId)}&page=${page}`, undefined, signal);
        if (!Array.isArray(result.outcomes) || !Array.isArray(result.categories) || result.page !== page || !Number.isSafeInteger(result.pageSize) || result.pageSize < 1) throw new Error('The outcome history response is incomplete.');
        for (const category of result.categories) {
          if (!category.id || categoryIds.has(category.id)) throw new Error('Categories changed while loading. Reload the complete history.');
          categoryIds.add(category.id); categories.push(category);
        }
        for (const outcome of result.outcomes) {
          const revisionKey = `${outcome.application_id}:${outcome.revision}`;
          if (!outcome.id || !outcome.application_id || !Number.isSafeInteger(outcome.revision) || outcome.revision < 1 || outcomeIds.has(outcome.id) || revisions.has(revisionKey)) throw new Error('Outcome revisions changed or are ambiguous. Reload the complete history.');
          outcomeIds.add(outcome.id); revisions.add(revisionKey); outcomes.push(outcome);
        }
        if (result.outcomes.length < result.pageSize && result.categories.length < result.pageSize) return { outcomes, categories };
      }
      throw new Error('The full outcome history exceeds the page limit. Commands remain unavailable.');
    },
    retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
}

export function usePublicationHistory(awardId, tenant, enabled = true) {
  return useQuery({
    queryKey: ['award-publication-history', tenant.scopeKey, awardId],
    enabled,
    queryFn: async ({ signal }) => {
      const publications = [], seen = new Set();
      let total;
      for (let page = 1; page <= 10000; page += 1) {
        const result = await decisionRequest(tenant, `/api/awards/publications?awardId=${encodeURIComponent(awardId)}&page=${page}`, undefined, signal);
        if (!Array.isArray(result.publications) || !Number.isSafeInteger(result.total) || result.page !== page || !Number.isSafeInteger(result.pageSize) || result.pageSize < 1) throw new Error('The publication history response is incomplete.');
        if (total !== undefined && total !== result.total) throw new Error('Publication history changed while loading. Refresh before continuing.');
        total = result.total;
        for (const publication of result.publications) {
          if (!publication.id || !Number.isSafeInteger(publication.revision) || seen.has(publication.id)) throw new Error('Publication revisions changed while loading. Refresh before continuing.');
          seen.add(publication.id); publications.push(publication);
        }
        if (publications.length === total) return publications;
        if (!result.publications.length || publications.length > total) break;
      }
      throw new Error('The complete publication history could not be loaded. Commands remain unavailable.');
    },
    retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
}
