import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase, isSupabaseConfigured } from '@/api/supabaseClient';

export function useResourceRealtime(queryKeys = ['resources', 'public-resources', 'admin-resources']) {
  const queryClient = useQueryClient();
  const keysRef = useRef(queryKeys);
  keysRef.current = queryKeys;

  useEffect(() => {
    // SECURITY: If no query keys provided (e.g., auth not yet resolved), skip subscription
    if (!queryKeys || queryKeys.length === 0) {
      console.log('[useResourceRealtime] No query keys provided, skipping subscription (auth may be pending)');
      return;
    }
    
    if (!isSupabaseConfigured || !supabase) {
      console.log('[useResourceRealtime] Supabase not configured, skipping realtime subscription');
      return;
    }

    console.log('[useResourceRealtime] Setting up realtime subscription for resource table');

    const channelName = 'resource-changes-' + Math.random().toString(36).substr(2, 9);
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'resource'
        },
        (payload) => {
          console.log('[useResourceRealtime] Resource change detected:', payload.eventType, payload.new?.id || payload.old?.id);
          
          keysRef.current.forEach(key => {
            queryClient.invalidateQueries({ queryKey: [key] });
          });
        }
      )
      .subscribe((status) => {
        console.log('[useResourceRealtime] Subscription status:', status);
      });

    return () => {
      console.log('[useResourceRealtime] Cleaning up realtime subscription');
      supabase.removeChannel(channel);
    };
  }, [queryClient, JSON.stringify(queryKeys)]);
}
