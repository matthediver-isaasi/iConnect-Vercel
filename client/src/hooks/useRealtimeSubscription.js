import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase, isSupabaseConfigured } from '@/api/supabaseClient';

export function useRealtimeSubscription(tableName, queryKeysToInvalidate = [], options = {}) {
  const queryClient = useQueryClient();
  const channelRef = useRef(null);
  const {
    enabled = true,
    schema = 'public',
    tenantId = null,
    filter: customFilter = null,  // Custom filter string, e.g. "organization_id=eq.123"
    event = '*',                  // Postgres change event(s) to listen for: '*', 'INSERT', 'UPDATE', 'DELETE'
    predicate = null,             // Optional (payload) => boolean gate; if provided and returns false, the event is ignored
    onEvent = null                // Optional (payload) => void side-effect, fired after invalidations when predicate passes
  } = options;

  // Stable refs for callbacks so changing identities don't churn the subscription
  const predicateRef = useRef(predicate);
  const onEventRef = useRef(onEvent);
  predicateRef.current = predicate;
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled || !isSupabaseConfigured || !supabase || !tableName) {
      return;
    }

    // Build filter: prefer custom filter, fall back to tenant_id filter
    const filter = customFilter || (tenantId ? `tenant_id=eq.${tenantId}` : undefined);

    // Build unique channel name based on filter and event
    const filterKey = filter || 'all';
    const channelName = `realtime:${tableName}:${event}:${filterKey}`;

    channelRef.current = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event,
          schema,
          table: tableName,
          filter
        },
        (payload) => {
          if (predicateRef.current && !predicateRef.current(payload)) {
            return;
          }
          queryKeysToInvalidate.forEach(queryKey => {
            queryClient.invalidateQueries({ queryKey });
          });
          if (onEventRef.current) {
            try { onEventRef.current(payload); } catch (e) { /* swallow listener errors */ }
          }
        }
      )
      .subscribe();

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [tableName, enabled, schema, tenantId, customFilter, event, queryClient, JSON.stringify(queryKeysToInvalidate)]);

  return { isSubscribed: !!channelRef.current };
}

export default useRealtimeSubscription;
