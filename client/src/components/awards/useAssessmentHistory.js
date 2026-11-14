import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { adminFetch } from '@/lib/adminFetch';
import { judgingRequest } from './judgingClient';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function verifyHistory(data, page) {
  if (data?.page !== page || data.pageSize !== 10 || !Number.isSafeInteger(data.total) || data.total < 0
    || !Array.isArray(data.assessments) || data.assessments.length !== Math.min(10, Math.max(0, data.total - (page - 1) * 10))) throw new Error('Submitted history pagination could not be verified. No partial history is displayed.');
  const seen = new Set();
  for (const row of data.assessments) {
    if (!uuid(row?.id) || seen.has(row.id) || !/^Judge [A-F0-9]{8}$/.test(row.judge)
      || !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.submittedAt !== 'string' || !Number.isFinite(Date.parse(row.submittedAt))
      || !uuid(row.applicationVersionId) || !uuid(row.criteriaVersionId) || typeof row.current !== 'boolean'
      || typeof row.assignmentIncluded !== 'boolean' || typeof row.assignmentState !== 'string' || typeof row.conflict !== 'string'
      || !row.answers || typeof row.answers !== 'object' || Array.isArray(row.answers)
      || (row.definition !== null && (!row.definition || !Array.isArray(row.definition.criteria)))
      || (row.score !== null && (!row.score || !/^-?\d{1,1000}$/.test(row.score.numerator) || !/^[1-9]\d{0,999}$/.test(row.score.denominator)))) throw new Error('The submitted assessment history response is invalid. Reload current access; no stale history is displayed.');
    seen.add(row.id);
  }
  return data;
}

export function useAssessmentHistory({ tenant, judgingContext, roundId, applicationId, page, enabled, onAccessDenied }) {
  const client = useQueryClient(), [failure, setFailure] = useState('');
  const alive = useRef(false), live = useRef({});
  live.current = { tenant, judgingContext, enabled, onAccessDenied };
  const scope = tenant?.scopeKey, judgingScope = judgingContext?.scope, authorityScope = judgingContext?.authority?.scopeKey, appointed = !!judgingContext;
  const prefix = useMemo(() => appointed
    ? ['judging-workspace', judgingScope, 'assessment-history', authorityScope, roundId, applicationId]
    : ['award-assessment-history', scope, roundId, applicationId],
  [scope, judgingScope, authorityScope, appointed, roundId, applicationId]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!enabled) {
      client.cancelQueries({ queryKey: prefix });
      client.setQueriesData({ queryKey: prefix }, () => null);
    }
  }, [client, prefix, enabled]);
  const query = useQuery({
    queryKey: [...prefix, page], enabled,
    queryFn: async ({ signal }) => {
      try {
        const current = live.current, authority = current.judgingContext?.authority;
        if (current.judgingContext && (!authority?.ready || !current.judgingContext.enabled)) throw Object.assign(new Error('Current panel authority and both conflict gates must be verified.'), { status: 403 });
        const assertCurrent = () => {
          if (signal.aborted || !live.current.enabled) throw new DOMException('Submitted history read cancelled.', 'AbortError');
          if (authority) authority.assertCurrent(); else current.tenant.assertCurrent();
        };
        assertCurrent();
        const params = new URLSearchParams({ roundId, applicationId, page: String(page) });
        let result;
        if (authority) {
          if (!authority.ready || !current.judgingContext.enabled) throw Object.assign(new Error('Current panel authority and both conflict gates must be verified.'), { status: 403 });
          params.set('scope', 'assessmentHistory');
          result = await judgingRequest(`/api/judging/panel?${params}`, { authority, signal });
        } else {
          const response = await adminFetch(`/api/awards/assessment-history?${params}`, { signal, cache: 'no-store', headers: { Accept: 'application/json' } }, current.tenant.tenantId);
          assertCurrent();
          if (!response.ok) throw Object.assign(new Error(`Submitted history access failed (${response.status}). Recheck current authority and retry explicitly.`), { status: response.status });
          if (response.redirected || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new Error('The server did not return submitted history JSON.');
          result = await response.json();
        }
        assertCurrent(); verifyHistory(result, page);
        if (alive.current) setFailure('');
        return result;
      } catch (error) {
        if (!signal.aborted && error.name !== 'AbortError') {
          client.setQueriesData({ queryKey: prefix }, () => null);
          if (alive.current) {
            setFailure(error.message);
            if ([401, 403].includes(error.status)) live.current.onAccessDenied?.();
          }
        }
        throw error;
      }
    },
    retry: false, gcTime: 0, staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  return { query, failure, data: enabled && query.isSuccess && !query.isFetching && !query.isError ? query.data : null };
}
