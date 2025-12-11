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

          console.log('[useEventSeatRealtime] Event update detected:', {
            eventId: newData?.id,
            oldSeatsBooked: oldData?.seats_booked,
            newSeatsBooked: newData?.seats_booked,
            seatCapacity: newData?.seat_capacity
          });

          const seatsBooked = Number(newData?.seats_booked) || 0;
          const seatCapacity = Number(newData?.seat_capacity) || 0;
          const availableSeats = seatCapacity > 0 ? seatCapacity - seatsBooked : null;

          setLastUpdate({
            seatsBooked,
            seatCapacity,
            availableSeats,
            timestamp: Date.now()
          });

          invalidateEventQueries();

          if (onSeatsUpdatedRef.current) {
            onSeatsUpdatedRef.current({
              seatsBooked,
              seatCapacity,
              availableSeats
            });
          }

          // Seed previousSeatsRef from old data if not yet set
          if (previousSeatsRef.current === null) {
            previousSeatsRef.current = Number(oldData?.seats_booked) || 0;
          }

          if (seatCapacity > 0 && seatsBooked >= seatCapacity) {
            console.log('[useEventSeatRealtime] Event sold out!');
            
            // Show toast if transitioning to sold out (previous was below capacity)
            if (showSoldOutToast && previousSeatsRef.current < seatCapacity) {
              toast.error('This event has just sold out!', {
                description: 'All available tickets have been booked.',
                duration: 5000
              });
            }

            if (onSoldOutRef.current) {
              onSoldOutRef.current();
            }
          }

          previousSeatsRef.current = seatsBooked;
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
