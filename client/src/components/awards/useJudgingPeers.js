import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatScore } from '../../../../api/_lib/assessment/scoring.js';
import { judgingRequest } from './judgingClient';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const scalar = value => value == null || ['string', 'number', 'boolean'].includes(typeof value);

function peerPage(result, page, criteria) {
  if (!record(result) || !['blind', 'after_submit', 'open'].includes(result.visibility)
    || typeof result.available !== 'boolean' || typeof result.commentsVisible !== 'boolean'
    || !Array.isArray(result.assessments) || !Number.isSafeInteger(result.total) || result.total < 0
    || result.page !== page || !Number.isSafeInteger(result.pageSize) || result.pageSize < 1
    || result.assessments.length !== Math.min(result.pageSize, Math.max(0, result.total - (page - 1) * result.pageSize))
    || (result.visibility === 'blind' && result.available)
    || (!result.available && (result.assessments.length || result.total))) {
    throw new Error('The peer-assessment page is incomplete or unreadable. No cached peer responses are being shown.');
  }
  const aliases = new Set();
  const assessments = result.assessments.map(row => {
    if (!record(row) || typeof row.judgeAlias !== 'string' || !row.judgeAlias.trim() || aliases.has(row.judgeAlias)
      || typeof row.submittedAt !== 'string' || !Number.isFinite(Date.parse(row.submittedAt)) || !record(row.answers)) {
      throw new Error('Peer aliases or submitted response metadata could not be verified. No partial page is shown.');
    }
    aliases.add(row.judgeAlias);
    if (row.score != null) {
      if (!record(row.score)) throw new Error('A peer score did not contain an exact numerator and denominator.');
      formatScore(row.score);
    }
    const answers = {};
    // Keep only the current assigned criteria. Never retain comments or text
    // responses in this view's cache when the endpoint withholds them.
    for (const criterion of criteria) {
      if ((!result.commentsVisible && criterion.type === 'text') || !Object.hasOwn(row.answers, criterion.id)) continue;
      const raw = row.answers[criterion.id], answer = record(raw) ? raw : { value: raw };
      if (!scalar(answer.value) || (answer.comment != null && typeof answer.comment !== 'string')) throw new Error('A peer response could not be safely displayed. No partial page is shown.');
      answers[criterion.id] = { ...(Object.hasOwn(answer, 'value') ? { value: answer.value } : {}),
        ...(result.commentsVisible && typeof answer.comment === 'string' ? { comment: answer.comment } : {}) };
    }
    return { judgeAlias: row.judgeAlias, score: row.score == null ? null : {
      numerator: String(row.score.numerator), denominator: String(row.score.denominator),
    }, submittedAt: row.submittedAt, answers };
  });
  return { visibility: result.visibility, available: result.available, commentsVisible: result.commentsVisible,
    assessments, total: result.total, page: result.page, pageSize: result.pageSize };
}

export function useJudgingPeers({ scope, authority, assignment, assessment, criteria, page }) {
  const queryClient = useQueryClient();
  const baseKey = ['judging-workspace', scope, 'peers', authority?.scopeKey || 'unverified', assignment.id];
  return useQuery({
    queryKey: [...baseKey, assignment.applicationVersionId, assignment.criteriaVersionId, assessment?.state || 'none', assessment?.revision || 0, page],
    enabled: !!authority?.ready && Array.isArray(criteria),
    queryFn: async ({ signal }) => {
      try {
        const result = await judgingRequest(`/api/judging/peers?assignmentId=${encodeURIComponent(assignment.id)}&page=${page}`, { authority, signal });
        if (signal.aborted) throw new DOMException('Peer read superseded.', 'AbortError');
        authority.assertCurrent();
        const data = peerPage(result, page, criteria);
        if (!data.available) queryClient.setQueriesData({ queryKey: baseKey }, () => null);
        return data;
      } catch (error) {
        // A failed/revoked read must not leave another cached page visible.
        // A superseded/cancelled observer must not clear the newer
        // revision's successfully authorised page. Its old cache has gcTime 0.
        if (!signal.aborted) queryClient.setQueriesData({ queryKey: baseKey }, () => null);
        throw error;
      }
    },
    retry: false, gcTime: 0, staleTime: 0,
    refetchOnWindowFocus: true, refetchOnReconnect: false,
    // No placeholderData: previous pages/authorities must never stand in for
    // the new server-authorised page.
  });
}
