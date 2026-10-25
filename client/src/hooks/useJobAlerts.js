import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLayoutContext } from '@/contexts/LayoutContext';
import { jobAlertsKey, invalidateJobAlertPreferences } from '@/lib/jobAlerts.mjs';

export async function readJobAlertsResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Unable to save job postings preferences. Please try again.');
  return data;
}

export function useJobAlerts() {
  const { memberInfo, sessionValidated, sessionWorkPaused } = useLayoutContext();
  const tenantId = memberInfo?.tenant_id;
  const memberId = memberInfo?.id;
  const queryClient = useQueryClient();
  const enabled = !!(tenantId && memberId && sessionValidated && !sessionWorkPaused);
  const queryKey = jobAlertsKey(tenantId, memberId);
  const query = useQuery({
    queryKey,
    enabled,
    queryFn: async ({ signal }) => readJobAlertsResponse(await fetch('/api/member/job-alerts', {
      credentials: 'include', signal,
    })),
    staleTime: 0,
    refetchOnMount: 'always',
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: async action => {
      if (!enabled) throw new Error('Please sign in again before changing your preferences.');
      return readJobAlertsResponse(await fetch('/api/member/job-alerts', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action),
      }));
    },
    onSuccess: data => {
      queryClient.setQueryData(queryKey, data);
      void invalidateJobAlertPreferences(queryClient, tenantId);
    },
  });
  return { query, mutation, enabled };
}
