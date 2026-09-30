import { useRealtimeSubscription } from '@/hooks/useRealtimeSubscription';
import { showZohoInboundUpdateToast } from '@/lib/zohoCrmSyncToast';

/**
 * Subscribe to inbound Zoho CRM updates for a single record (organization or member)
 * the user is currently viewing. When a successful inbound apply lands on that exact
 * record, fire a toast and invalidate the supplied React Query keys so the UI refreshes.
 *
 * Filtering happens at two levels:
 *  - Supabase channel filter scopes events to entity_id=eq.<id> on zoho_crm_sync_log
 *  - In-handler predicate further restricts to direction='inbound', status='success'
 *    and matching entity_type, so outbound pushes the viewer themselves triggered
 *    (and skipped/failed sync attempts) never produce a toast or refetch.
 */
export function useZohoInboundUpdateNotifier({
  entityType,
  entityId,
  queryKeysToInvalidate = [],
  enabled = true
} = {}) {
  const subscriptionEnabled = !!enabled && !!entityType && !!entityId;

  return useRealtimeSubscription(
    'zoho_crm_sync_log',
    queryKeysToInvalidate,
    {
      enabled: subscriptionEnabled,
      event: 'INSERT',
      filter: entityId ? `entity_id=eq.${entityId}` : null,
      predicate: (payload) => {
        const row = payload?.new;
        if (!row) return false;
        if (row.entity_type !== entityType) return false;
        if (row.direction !== 'inbound') return false;
        if (row.status !== 'success') return false;
        return true;
      },
      onEvent: () => {
        showZohoInboundUpdateToast({ entityType });
      }
    }
  );
}

export default useZohoInboundUpdateNotifier;
