import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase, isSupabaseConfigured } from '@/api/supabaseClient';

export function useRealtimeSubscription(tableName, queryKeysToInvalidate = [], options = {}) {
  const queryClient = useQueryClient();
  const channelRef = useRef(null);
  const { enabled = true, schema = 'public', tenantId = null } = options;

  useEffect(() => {
    if (!enabled || !isSupabaseConfigured || !supabase || !tableName) {
      return;
    }

    const channelName = tenantId 
      ? `realtime:${tableName}:${tenantId}` 
      : `realtime:${tableName}`;

    const filter = tenantId ? `tenant_id=eq.${tenantId}` : undefined;

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
  }, [tableName, enabled, schema, tenantId, queryClient, JSON.stringify(queryKeysToInvalidate)]);

  return { isSubscribed: !!channelRef.current };
}

export default useRealtimeSubscription;
