import { useSyncExternalStore } from 'react';
import { getActiveTenantId, subscribeToActiveTenantId } from '@/api/base44Client';
import { publicClient } from '@/api/publicClient';

// Include the displayed workspace even when the member ID does not change.
export function useTicketViewerKey(member) {
  const activeTenant = useSyncExternalStore(subscribeToActiveTenantId, getActiveTenantId, () => null);
  return [activeTenant || member?.tenant_id || publicClient.getTenantSlug?.() || null, member?.id || null];
}
