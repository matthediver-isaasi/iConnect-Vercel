import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getActiveTenantId, subscribeToActiveTenantId } from '@/api/base44Client';
import { normalizeBiographyHelperText } from '../../../shared/biographyHelperText.js';

export const biographyHelperKey = tenantId => ['biography-helper-settings', tenantId];

export async function requestBiographyHelperSettings(tenantId, helperText, signal) {
  const response = await fetch('/api/biography-helper-settings', {
    method: helperText === undefined ? 'GET' : 'PUT',
    credentials: 'include', signal,
    headers: { 'X-Tenant-Id': tenantId, ...(helperText === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(helperText === undefined ? {} : { body: JSON.stringify({ helperText }) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || 'Unable to load or save biography helper settings.');
  if (data?.tenantId !== tenantId || typeof data.helperText !== 'string' || typeof data.canManage !== 'boolean'
    || normalizeBiographyHelperText(data.helperText) !== data.helperText) {
    throw new Error('Biography helper settings are incomplete. Please retry.');
  }
  return data;
}

export function useBiographyHelperSettings(memberTenantId) {
  const activeTenantId = useSyncExternalStore(subscribeToActiveTenantId, getActiveTenantId, () => null);
  // Role-based member administrators can visit PreferenceSettings without an
  // admin-dashboard tenant bootstrap. Resolve their session, not a global row.
  const session = useQuery({
    queryKey: ['biography-helper-session', activeTenantId],
    enabled: memberTenantId === undefined && !activeTenantId,
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/auth/me', { credentials: 'include', signal });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.tenant_id) throw new Error('Unable to determine your tenant. Reload and try again.');
      return data;
    },
    retry: false, staleTime: 0, gcTime: 0,
  });
  const tenantId = memberTenantId || activeTenantId || (memberTenantId === undefined ? session.data?.tenant_id : null);
  const mismatch = !!memberTenantId && !!activeTenantId && memberTenantId !== activeTenantId;
  const query = useQuery({
    queryKey: biographyHelperKey(tenantId),
    enabled: !!tenantId && !mismatch,
    queryFn: ({ signal }) => requestBiographyHelperSettings(tenantId, undefined, signal),
    retry: false, staleTime: 0, refetchOnWindowFocus: true,
  });
  return { ...query, tenantId, data: mismatch ? undefined : query.data,
    isLoading: query.isLoading || (!tenantId && session.isLoading),
    refetch: !tenantId ? session.refetch : query.refetch,
    error: mismatch ? new Error('Your tenant session changed. Reload to load biography helper text.') : query.error || (!tenantId ? session.error : null) };
}
