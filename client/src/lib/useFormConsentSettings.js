import { useQuery } from '@tanstack/react-query';
import { publicClient } from '@/api/publicClient';

export function useFormConsentSettings() {
  return useQuery({
    queryKey: ['formDefaultConsentMessage', publicClient.tenantSlug, window.location.host],
    queryFn: () => publicClient.getFormConsentMessage(),
    staleTime: 5 * 60 * 1000,
  }).data;
}
