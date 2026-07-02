import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase, isSupabaseConfigured } from '@/api/supabaseClient';
import { toast } from 'sonner';

export function useEventSeatRealtime(eventId, options = {}) {
  const {
    onSoldOut = null,
    onSeatsUpdated = null,
    showSoldOutToast = true
  } = options;

  const queryClient = useQueryClient();
  const eventIdRef = useRef(eventId);
  const onSoldOutRef = useRef(onSoldOut);
  const onSeatsUpdatedRef = useRef(onSeatsUpdated);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const previousSeatsRef = useRef(null);

  eventIdRef.current = eventId;
  onSoldOutRef.current = onSoldOut;
  onSeatsUpdatedRef.current = onSeatsUpdated;

  const invalidateEventQueries = useCallback(() => {
    if (eventIdRef.current) {
      // Invalidate the specific event query used in EventDetails
      queryClient.invalidateQueries({ queryKey: ['event', eventIdRef.current] });
      // Also invalidate any entity-style queries
      queryClient.invalidateQueries({ queryKey: ['/api/entities/Event', eventIdRef.current] });
      queryClient.invalidateQueries({ queryKey: ['/api/entities/Event'] });
    }
  }, [queryClient]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      console.log('[useEventSeatRealtime] Supabase not configured, skipping realtime subscription');
      return;
    }

    if (!eventIdRef.current) {
      console.log('[useEventSeatRealtime] No event ID, skipping subscription');
      return;
    }

    console.log('[useEventSeatRealtime] Setting up realtime subscription for event:', eventIdRef.current);

    const channelName = `event-seats-${eventIdRef.current}-${Math.random().toString(36).substr(2, 9)}`;
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

          const availableSeats = newData?.available_seats;
          const oldAvailableSeats = oldData?.available_seats;

          console.log('[useEventSeatRealtime] Event update detected:', {
            eventId: newData?.id,
            oldAvailableSeats,
            newAvailableSeats: availableSeats,
            isUnlimitedRegistration: newData?.is_unlimited_registration
          });

          // Check explicit flag, with legacy fallback (null available_seats = unlimited)
          const isUnlimitedRegistration = newData?.is_unlimited_registration === true || 
            (newData?.is_unlimited_registration !== false && availableSeats === null);

          setLastUpdate({
            availableSeats,
            isUnlimitedRegistration,
            timestamp: Date.now()
          });

          invalidateEventQueries();

          if (onSeatsUpdatedRef.current) {
            onSeatsUpdatedRef.current({
              availableSeats,
              isUnlimitedRegistration
            });
          }

          // Seed previousSeatsRef from old data if not yet set
          if (previousSeatsRef.current === null) {
            previousSeatsRef.current = oldAvailableSeats;
          }

          // Only check for sold out if not unlimited registration
          // Sold out = available_seats is 0 (or less) and not unlimited
          if (!isUnlimitedRegistration && availableSeats !== null && availableSeats <= 0) {
            console.log('[useEventSeatRealtime] Event sold out!');
            
            // Show toast if transitioning to sold out (previous was above 0)
            if (showSoldOutToast && previousSeatsRef.current !== null && previousSeatsRef.current > 0) {
              toast.error('This event has just sold out!', {
                description: 'All available tickets have been booked.',
                duration: 5000
              });
            }

            if (onSoldOutRef.current) {
              onSoldOutRef.current();
            }
          }

          previousSeatsRef.current = availableSeats;
        }
      )
      .subscribe((status) => {
        console.log('[useEventSeatRealtime] Subscription status:', status);
        setIsConnected(status === 'SUBSCRIBED');
      });

    return () => {
      console.log('[useEventSeatRealtime] Cleaning up realtime subscription for event:', eventIdRef.current);
      supabase.removeChannel(channel);
      setIsConnected(false);
    };
  }, [queryClient, eventId, showSoldOutToast, invalidateEventQueries]);

  return {
    isConnected,
    lastUpdate,
    invalidateEventQueries
  };
}
