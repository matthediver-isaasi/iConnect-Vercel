import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase, isSupabaseConfigured } from '@/api/supabaseClient';
import { toast } from 'sonner';

export function useTicketAvailabilityRealtime(eventId, options = {}) {
  const {
    onTicketSoldOut = null,
    onAvailabilityUpdated = null,
    showSoldOutToast = true,
    initialPricingConfig = null // Initial pricing config to seed state immediately
  } = options;

  const queryClient = useQueryClient();
  const eventIdRef = useRef(eventId);
  const onTicketSoldOutRef = useRef(onTicketSoldOut);
  const onAvailabilityUpdatedRef = useRef(onAvailabilityUpdated);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [ticketClassAvailability, setTicketClassAvailability] = useState({});
  const previousAvailabilityRef = useRef({});

  eventIdRef.current = eventId;
  onTicketSoldOutRef.current = onTicketSoldOut;
  onAvailabilityUpdatedRef.current = onAvailabilityUpdated;

  const invalidateEventQueries = useCallback(() => {
    if (eventIdRef.current) {
      queryClient.invalidateQueries({ queryKey: ['event', eventIdRef.current] });
      queryClient.invalidateQueries({ queryKey: ['/api/entities/Event', eventIdRef.current] });
      queryClient.invalidateQueries({ queryKey: ['/api/entities/Event'] });
    }
  }, [queryClient]);

  const extractTicketClassAvailability = useCallback((pricingConfig) => {
    if (!pricingConfig?.ticket_classes) return {};
    
    const availability = {};
    pricingConfig.ticket_classes.forEach(tc => {
      // Skip tickets without valid IDs - these can't be tracked reliably
      if (!tc.id && tc.id !== 0) return;
      
      // Always normalize IDs to strings for consistent lookups
      const ticketId = String(tc.id);
      const availCount = tc.available_count;
      
      // Check if unlimited: explicit flag, null, undefined, or empty string all mean unlimited
      const isUnlimited = tc.is_unlimited_tickets === true || 
                          availCount === null || 
                          availCount === undefined || 
                          availCount === '';
      
      // Parse available_count safely
      // Empty string, null, undefined -> null (unlimited)
      // Invalid number -> treat as 0 (sold out for safety)
      let parsedCount = null;
      if (availCount !== null && availCount !== undefined && availCount !== '') {
        const num = Number(availCount);
        parsedCount = isNaN(num) ? 0 : num;
      }
      
      availability[ticketId] = {
        name: tc.name,
        available_count: parsedCount,
        is_unlimited_tickets: isUnlimited,
        isSoldOut: !isUnlimited && parsedCount !== null && parsedCount <= 0
      };
    });
    return availability;
  }, []);

  // Seed ticketClassAvailability from initial pricing config
  useEffect(() => {
    if (initialPricingConfig) {
      const initialAvailability = extractTicketClassAvailability(initialPricingConfig);
      if (Object.keys(initialAvailability).length > 0) {
        setTicketClassAvailability(initialAvailability);
        previousAvailabilityRef.current = initialAvailability;
        console.log('[useTicketAvailabilityRealtime] Seeded initial ticket class availability:', initialAvailability);
      }
    }
  }, [initialPricingConfig, extractTicketClassAvailability]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      console.log('[useTicketAvailabilityRealtime] Supabase not configured, skipping realtime subscription');
      return;
    }

    if (!eventIdRef.current) {
      console.log('[useTicketAvailabilityRealtime] No event ID, skipping subscription');
      return;
    }

    console.log('[useTicketAvailabilityRealtime] Setting up realtime subscription for event:', eventIdRef.current);

    const channelName = `ticket-availability-${eventIdRef.current}-${Math.random().toString(36).substr(2, 9)}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'event',
          filter: `id=eq.${eventIdRef.current}`
        },
        (payload) => {
          const newData = payload.new;
          const oldData = payload.old;

          const newPricingConfig = newData?.pricing_config;
          const oldPricingConfig = oldData?.pricing_config;

          console.log('[useTicketAvailabilityRealtime] Event update detected, checking pricing_config changes');

          const newAvailability = extractTicketClassAvailability(newPricingConfig);
          const oldAvailability = extractTicketClassAvailability(oldPricingConfig);

          setTicketClassAvailability(newAvailability);
          setLastUpdate({
            ticketClassAvailability: newAvailability,
            timestamp: Date.now()
          });

          invalidateEventQueries();

          if (onAvailabilityUpdatedRef.current) {
            onAvailabilityUpdatedRef.current(newAvailability);
          }

          // Check for newly sold out ticket classes
          Object.keys(newAvailability).forEach(ticketClassId => {
            const newTicket = newAvailability[ticketClassId];
            const oldTicket = oldAvailability[ticketClassId] || previousAvailabilityRef.current[ticketClassId];

            if (newTicket.isSoldOut && oldTicket && !oldTicket.isSoldOut) {
              console.log('[useTicketAvailabilityRealtime] Ticket class sold out:', newTicket.name);
              
              if (showSoldOutToast) {
                toast.warning(`"${newTicket.name}" is now sold out`, {
                  description: 'All available tickets for this class have been booked.',
                  duration: 4000
                });
              }

              if (onTicketSoldOutRef.current) {
                onTicketSoldOutRef.current(ticketClassId, newTicket.name);
              }
            }
          });

          previousAvailabilityRef.current = newAvailability;
        }
      )
      .subscribe((status) => {
        console.log('[useTicketAvailabilityRealtime] Subscription status:', status);
        setIsConnected(status === 'SUBSCRIBED');
      });

    return () => {
      console.log('[useTicketAvailabilityRealtime] Cleaning up realtime subscription for event:', eventIdRef.current);
      supabase.removeChannel(channel);
      setIsConnected(false);
    };
  }, [queryClient, eventId, showSoldOutToast, invalidateEventQueries, extractTicketClassAvailability]);

  // Helper function to get availability for a specific ticket class
  const getTicketClassAvailability = useCallback((ticketClassId) => {
    return ticketClassAvailability[ticketClassId] || null;
  }, [ticketClassAvailability]);

  // Check if any ticket class is sold out
  const hasSoldOutTicketClasses = useMemo(() => {
    return Object.values(ticketClassAvailability).some(tc => tc.isSoldOut);
  }, [ticketClassAvailability]);

  return {
    isConnected,
    lastUpdate,
    ticketClassAvailability,
    getTicketClassAvailability,
    hasSoldOutTicketClasses,
    invalidateEventQueries
  };
}
