import { useRef, useSyncExternalStore } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getActiveTenantId, subscribeToActiveTenantId } from '@/api/base44Client';
import { useLayoutContext } from '@/contexts/LayoutContext';
import { useMemberAccess } from '@/hooks/useMemberAccess';
import { apiRequest } from '@/lib/queryClient';

export function useMemberGroupCustomFields(enabled = true) {
  const tenant = useSyncExternalStore(subscribeToActiveTenantId, getActiveTenantId, () => null);
  const { memberInfo, sessionValidated, authResolved, sessionWorkPaused, sessionRoleSnapshot } = useLayoutContext();
  const { isAdmin, isAccessReady } = useMemberAccess();
  const tenantId = tenant || memberInfo?.tenant_id;
  const allowed = enabled && authResolved && sessionValidated && !sessionWorkPaused
    && isAccessReady && isAdmin && !!memberInfo?.id && !!tenantId
    && (!tenant || !memberInfo?.tenant_id || tenant === memberInfo.tenant_id);
  const queryKey = ['member-group-custom-fields', tenantId || null, memberInfo?.id || null,
    memberInfo?.role_id || null, sessionRoleSnapshot?.session_key || null];
  const scopeKey = JSON.stringify(queryKey);
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey,
    enabled: !!allowed,
    queryFn: async ({ signal }) => {
      const data = await apiRequest('GET', '/api/member-groups/custom-fields', undefined, {
        headers: { 'X-Tenant-Id': tenantId }, signal,
      });
      if (!Array.isArray(data?.fields) || !Number.isInteger(data.revision)) throw new Error('Invalid custom field definitions response.');
      return data;
    },
    staleTime: 0,
    retry: false,
  });
  const save = useMutation({
    mutationFn: (snapshot) => {
      if (!snapshot.allowed || scopeRef.current !== snapshot.scopeKey) throw new Error('Your administrator session must be verified before saving.');
      return apiRequest('PUT', '/api/member-groups/custom-fields', snapshot.payload, {
        headers: { 'X-Tenant-Id': snapshot.tenantId },
      });
    },
    onSuccess: (data, snapshot) => {
      if (scopeRef.current !== snapshot.scopeKey) return;
      queryClient.setQueryData(snapshot.queryKey, data);
      queryClient.invalidateQueries({ queryKey: ['member-group-custom-fields'] });
      queryClient.invalidateQueries({ queryKey: ['member-groups'] });
      queryClient.invalidateQueries({ queryKey: ['member-group'] });
    },
  });
  return { ...query, save: { ...save, mutateAsync: (payload) => save.mutateAsync({
    payload, tenantId, scopeKey, queryKey,
    allowed: allowed && query.isSuccess && !query.isFetching && !query.isError && query.data?.available !== false,
  }) }, scopeKey, allowed: !!allowed,
    ready: !!allowed && query.isSuccess && !query.isFetching && !query.isError };
}
