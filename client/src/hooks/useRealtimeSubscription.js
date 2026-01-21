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
    filter: customFilter = null  // Custom filter string, e.g. "organization_id=eq.123"
  } = options;

  useEffect(() => {
    if (!enabled || !isSupabaseConfigured || !supabase || !tableName) {
      return;
    }

    // Build filter: prefer custom filter, fall back to tenant_id filter
    const filter = customFilter || (tenantId ? `tenant_id=eq.${tenantId}` : undefined);
    
    // Build unique channel name based on filter
    const filterKey = filter || 'all';
    const channelName = `realtime:${tableName}:${filterKey}`;

    channelRef.current = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { 
          event: '*', 
          schema, 
          table: tableName,
          filter
        },
        (payload) => {
          queryKeysToInvalidate.forEach(queryKey => {
            queryClient.invalidateQueries({ queryKey });
          });
        }
      )
      .subscribe();

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [tableName, enabled, schema, tenantId, customFilter, queryClient, JSON.stringify(queryKeysToInvalidate)]);

  return { isSubscribed: !!channelRef.current };
}

export default useRealtimeSubscription;
