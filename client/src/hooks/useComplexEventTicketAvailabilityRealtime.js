import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase, isSupabaseConfigured } from '@/api/supabaseClient';
import { toast } from 'sonner';

export function useComplexEventTicketAvailabilityRealtime(complexEventId, options = {}) {
  const {
    onTicketSoldOut = null,
    onAvailabilityUpdated = null,
    showSoldOutToast = true,
    initialTicketClasses = null
  } = options;

  const queryClient = useQueryClient();
  const eventIdRef = useRef(complexEventId);
  const onTicketSoldOutRef = useRef(onTicketSoldOut);
  const onAvailabilityUpdatedRef = useRef(onAvailabilityUpdated);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [ticketClassAvailability, setTicketClassAvailability] = useState({});
  const previousAvailabilityRef = useRef({});

  eventIdRef.current = complexEventId;
  onTicketSoldOutRef.current = onTicketSoldOut;
  onAvailabilityUpdatedRef.current = onAvailabilityUpdated;

  const invalidateQueries = useCallback(() => {
    if (eventIdRef.current) {
      queryClient.invalidateQueries({ queryKey: ['/api/entities/ComplexEventTicketClass'] });
      queryClient.invalidateQueries({ queryKey: ['complex-event-tickets', eventIdRef.current] });
    }
  }, [queryClient]);

  const buildAvailabilityMap = useCallback((ticketClass) => {
    if (!ticketClass || !ticketClass.id) return null;

    const ticketId = String(ticketClass.id);
    const availCount = ticketClass.available_count;
    const isUnlimited = ticketClass.is_unlimited_tickets === true ||
                        availCount === null ||
                        availCount === undefined ||
                        availCount === '';

    let parsedCount = null;
    if (availCount !== null && availCount !== undefined && availCount !== '') {
      const num = Number(availCount);
      parsedCount = isNaN(num) ? 0 : num;
    }

    return {
      id: ticketId,
      name: ticketClass.name,
      available_count: parsedCount,
      is_unlimited_tickets: isUnlimited,
      isSoldOut: !isUnlimited && parsedCount !== null && parsedCount <= 0
    };
  }, []);

  useEffect(() => {
    if (initialTicketClasses && Array.isArray(initialTicketClasses)) {
      const availability = {};
      initialTicketClasses.forEach(tc => {
        const entry = buildAvailabilityMap(tc);
        if (entry) {
          availability[entry.id] = entry;
        }
      });
      if (Object.keys(availability).length > 0) {
        setTicketClassAvailability(availability);
        previousAvailabilityRef.current = availability;
      }
    }
  }, [initialTicketClasses, buildAvailabilityMap]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      return;
    }

    if (!eventIdRef.current) {
      return;
    }

    const channelName = `complex-ticket-availability-${eventIdRef.current}-${Math.random().toString(36).substr(2, 9)}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'complex_event_ticket_class',
          filter: `complex_event_id=eq.${eventIdRef.current}`
        },
        (payload) => {
          const newData = payload.new;
          const oldData = payload.old;

          if (payload.eventType === 'DELETE' && oldData?.id) {
            setTicketClassAvailability(prev => {
              const next = { ...prev };
              delete next[String(oldData.id)];
              return next;
            });
            invalidateQueries();
            return;
          }

          if (newData) {
            const entry = buildAvailabilityMap(newData);
            if (entry) {
              setTicketClassAvailability(prev => {
                const next = { ...prev, [entry.id]: entry };
                return next;
              });

              setLastUpdate({
                ticketClassId: entry.id,
                timestamp: Date.now()
              });

              invalidateQueries();

              if (onAvailabilityUpdatedRef.current) {
                onAvailabilityUpdatedRef.current(entry);
              }

              const previousEntry = previousAvailabilityRef.current[entry.id];
              if (entry.isSoldOut && previousEntry && !previousEntry.isSoldOut) {
                if (showSoldOutToast) {
                  toast.warning(`"${entry.name}" is now sold out`, {
                    description: 'All available tickets for this class have been booked.',
                    duration: 4000
                  });
                }

                if (onTicketSoldOutRef.current) {
                  onTicketSoldOutRef.current(entry.id, entry.name);
                }
              }

              previousAvailabilityRef.current = {
                ...previousAvailabilityRef.current,
                [entry.id]: entry
              };
            }
          }
        }
      )
      .subscribe((status) => {
        setIsConnected(status === 'SUBSCRIBED');
      });

    return () => {
      supabase.removeChannel(channel);
      setIsConnected(false);
    };
  }, [queryClient, complexEventId, showSoldOutToast, invalidateQueries, buildAvailabilityMap]);

  const getTicketClassAvailability = useCallback((ticketClassId) => {
    return ticketClassAvailability[String(ticketClassId)] || null;
  }, [ticketClassAvailability]);

  const hasSoldOutTicketClasses = useMemo(() => {
    return Object.values(ticketClassAvailability).some(tc => tc.isSoldOut);
  }, [ticketClassAvailability]);

  return {
    isConnected,
    lastUpdate,
    ticketClassAvailability,
    getTicketClassAvailability,
    hasSoldOutTicketClasses,
    invalidateQueries
  };
}
