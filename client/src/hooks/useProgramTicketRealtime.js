import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase, isSupabaseConfigured } from '@/api/supabaseClient';

export function useProgramTicketRealtime(organizationId, queryKeys = [], onOrganizationUpdate = null) {
  const queryClient = useQueryClient();
  const keysRef = useRef(queryKeys);
  const orgIdRef = useRef(organizationId);
  const onUpdateRef = useRef(onOrganizationUpdate);
  keysRef.current = queryKeys;
  orgIdRef.current = organizationId;
  onUpdateRef.current = onOrganizationUpdate;

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      console.log('[useProgramTicketRealtime] Supabase not configured, skipping realtime subscription');
      return;
    }

    if (!orgIdRef.current) {
      console.log('[useProgramTicketRealtime] No organization ID, skipping subscription');
      return;
    }

    console.log('[useProgramTicketRealtime] Setting up realtime subscriptions for org:', orgIdRef.current);

    const channelName = 'program-ticket-changes-' + Math.random().toString(36).substr(2, 9);
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'program_ticket_transaction'
        },
        (payload) => {
          console.log('[useProgramTicketRealtime] Transaction change detected:', payload.eventType, payload.new?.id || payload.old?.id);
          
          keysRef.current.forEach(key => {
            queryClient.invalidateQueries({ queryKey: [key] });
          });
          
          queryClient.invalidateQueries({ queryKey: ['/api/entities/ProgramTicketTransaction'] });
          queryClient.invalidateQueries({ queryKey: ['/api/entities/Organization'] });
          
          if (onUpdateRef.current) {
            console.log('[useProgramTicketRealtime] Calling organization refresh callback');
            onUpdateRef.current();
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'organization',
          filter: `id=eq.${orgIdRef.current}`
        },
        (payload) => {
          console.log('[useProgramTicketRealtime] Organization update detected:', payload.new?.id);
          
          keysRef.current.forEach(key => {
            queryClient.invalidateQueries({ queryKey: [key] });
          });
          
          queryClient.invalidateQueries({ queryKey: ['/api/entities/Organization'] });
          
          if (onUpdateRef.current) {
            console.log('[useProgramTicketRealtime] Calling organization refresh callback');
            onUpdateRef.current();
          }
        }
      )
      .subscribe((status) => {
        console.log('[useProgramTicketRealtime] Subscription status:', status);
      });

    return () => {
      console.log('[useProgramTicketRealtime] Cleaning up realtime subscription');
      supabase.removeChannel(channel);
    };
  }, [queryClient, organizationId]);
}
