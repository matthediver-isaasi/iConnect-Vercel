import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { validateCampaignTimings } from './campaignTimingDisplay.mjs';

export default function useCampaignTimings(campaignId, open) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!open || !campaignId) return;
    return () => {
      queryClient.cancelQueries({ queryKey: ['campaign-timings', campaignId], exact: true });
    };
  }, [open, campaignId, queryClient]);
  return useQuery({
    queryKey: ['campaign-timings', campaignId],
    enabled: Boolean(open && campaignId),
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/email-campaigns/${encodeURIComponent(campaignId)}?timings=true`, {
        credentials: 'include', signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Unable to load campaign timings.');
      return validateCampaignTimings(data, campaignId);
    },
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => open && !query.state.error &&
      ['sending', 'preparing'].includes(query.state.data?.campaign?.status) ? 5000 : false,
    // Never use placeholderData/keepPreviousData here: a different campaign
    // must render a fresh loading state, not the previous campaign's timings.
  });
}
