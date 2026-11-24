import { useQuery } from '@tanstack/react-query';
import { adminFetch } from '@/lib/adminFetch';
import { memberBalancesVisible } from '@shared/memberBalancesVisibility.js';
import { memberCpdPresentation, MEMBER_CPD_DEFAULT_LABEL } from '@shared/memberCpdPresentation.js';

export const memberRecordPreferencesKey = tenantId => ['member-record-preferences', tenantId];

export function useMemberBalancesVisibility(tenantId) {
  const query = useQuery({
    queryKey: memberRecordPreferencesKey(tenantId),
    enabled: !!tenantId,
    staleTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await adminFetch('/api/member-record-preferences', { signal }, tenantId);
      if (!response.ok) throw new Error('Member record preferences unavailable');
      const data = await response.json();
      if (data.tenantId !== tenantId || typeof data.show_member_balances_tab !== 'boolean'
        || typeof data.show_member_cpd_points !== 'boolean' || typeof data.member_cpd_tab_label !== 'string') {
        throw new Error('Invalid member record preferences');
      }
      return data;
    },
  });
  return {
    visible: !!tenantId && query.isSuccess && !query.isFetching && memberBalancesVisible(query.data),
    resolved: !!tenantId && query.isSuccess && !query.isFetching,
    cpdVisible: !!tenantId && query.isSuccess && !query.isFetching && memberCpdPresentation(query.data).show_member_cpd_points,
    cpdTabLabel: !!tenantId && query.isSuccess && !query.isFetching
      ? memberCpdPresentation(query.data).member_cpd_tab_label : MEMBER_CPD_DEFAULT_LABEL,
    error: query.isError,
    retry: query.refetch,
  };
}
