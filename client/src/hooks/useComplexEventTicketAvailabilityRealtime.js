import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase, isSupabaseConfigured } from '@/api/supabaseClient';
import { toast } from 'sonner';

// Count-based ticket availability for COMPLEX (multi-session) events (Task #1760).
//
// `available_count` on each complex_event_ticket_class is a FIXED maximum
// (capacity), never mutated by bookings. Live availability is derived from the
// actual number of status='confirmed' rows in complex_event_booking per
// ticket_class_id. This hook keeps that derived availability fresh by:
//   1. counting confirmed bookings per finite ticket class, and
//   2. subscribing to realtime booking changes (INSERT/UPDATE/DELETE) for the
//      event, plus ticket-class changes (the admin can edit the maximum).
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
  const showSoldOutToastRef = useRef(showSoldOutToast);
  const ticketClassesRef = useRef(initialTicketClasses);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [ticketClassAvailability, setTicketClassAvailability] = useState({});
  const previousAvailabilityRef = useRef({});

  eventIdRef.current = complexEventId;
  onTicketSoldOutRef.current = onTicketSoldOut;
  onAvailabilityUpdatedRef.current = onAvailabilityUpdated;
  showSoldOutToastRef.current = showSoldOutToast;

  const invalidateQueries = useCallback(() => {
    if (eventIdRef.current) {
      queryClient.invalidateQueries({ queryKey: ['/api/entities/ComplexEventTicketClass'] });
      queryClient.invalidateQueries({ queryKey: ['complex-event-tickets', eventIdRef.current] });
    }
  }, [queryClient]);

  // True when a ticket class has no enforceable maximum.
  const isUnlimitedTicket = useCallback((tc) => {
    const availCount = tc.available_count;
    return tc.is_unlimited_tickets === true ||
      availCount === null ||
      availCount === undefined ||
      availCount === '';
  }, []);

  // Parse the admin-set maximum. Unlimited -> null; invalid -> 0 (sold out).
  const parseMax = useCallback((tc) => {
    if (isUnlimitedTicket(tc)) return null;
    const num = Number(tc.available_count);
    return isNaN(num) ? 0 : num;
  }, [isUnlimitedTicket]);

  // Build the availability map from the ticket classes and a map of confirmed
  // booking counts keyed by ticket class id. Falls back to any sold_count
  // already embedded on the ticket class (the public API provides it).
  const buildAvailability = useCallback((ticketClasses, soldCounts = {}) => {
    if (!Array.isArray(ticketClasses)) return {};

    const availability = {};
    ticketClasses.forEach(tc => {
      if (!tc || (!tc.id && tc.id !== 0)) return;
      const ticketId = String(tc.id);
      const isUnlimited = isUnlimitedTicket(tc);
      const max = parseMax(tc);

      let soldCount = 0;
      if (Object.prototype.hasOwnProperty.call(soldCounts, ticketId)) {
        soldCount = soldCounts[ticketId] || 0;
      } else if (typeof tc.sold_count === 'number') {
        soldCount = tc.sold_count;
      }

      const remaining = isUnlimited || max === null ? null : (max - soldCount);

      availability[ticketId] = {
        id: ticketId,
        name: tc.name,
        available_count: max, // fixed maximum (capacity)
        sold_count: soldCount,
        remaining,
        is_unlimited_tickets: isUnlimited,
        isSoldOut: !isUnlimited && remaining !== null && remaining <= 0
      };
    });
    return availability;
  }, [isUnlimitedTicket, parseMax]);

  // Detect ticket classes that just transitioned to sold out and notify.
  const detectSoldOut = useCallback((newAvailability) => {
    Object.keys(newAvailability).forEach(ticketClassId => {
      const newTicket = newAvailability[ticketClassId];
      const oldTicket = previousAvailabilityRef.current[ticketClassId];
      if (newTicket.isSoldOut && oldTicket && !oldTicket.isSoldOut) {
        if (showSoldOutToastRef.current) {
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
  }, []);

  // Fetch confirmed booking counts for the finite ticket classes and rebuild
  // the availability map.
  const refreshAvailability = useCallback(async () => {
    const ticketClasses = ticketClassesRef.current;
    const currentEventId = eventIdRef.current;
    if (!Array.isArray(ticketClasses) || !currentEventId) return;

    let soldCounts = {};

    if (isSupabaseConfigured && supabase) {
      const finiteIds = ticketClasses
        .filter(tc => tc && (tc.id || tc.id === 0) && !isUnlimitedTicket(tc))
        .map(tc => String(tc.id))
        .filter(id => id && id !== 'undefined' && id !== 'null');

      try {
        const results = await Promise.all(finiteIds.map(async (tcId) => {
          const { count, error } = await supabase
            .from('complex_event_booking')
            .select('id', { count: 'exact', head: true })
            .eq('event_id', currentEventId)
            .eq('ticket_class_id', tcId)
            .eq('status', 'confirmed');
          if (error) {
            console.error('[useComplexEventTicketAvailabilityRealtime] Count failed for ticket class', tcId, error.message);
            return [tcId, null];
          }
          return [tcId, count || 0];
        }));
        results.forEach(([tcId, count]) => {
          if (count !== null) soldCounts[tcId] = count;
        });
      } catch (err) {
        console.error('[useComplexEventTicketAvailabilityRealtime] Failed to refresh sold counts:', err.message);
      }
    }

    const newAvailability = buildAvailability(ticketClasses, soldCounts);
    setTicketClassAvailability(newAvailability);
    setLastUpdate({ ticketClassAvailability: newAvailability, timestamp: Date.now() });

    detectSoldOut(newAvailability);
    previousAvailabilityRef.current = newAvailability;

    if (onAvailabilityUpdatedRef.current) {
      onAvailabilityUpdatedRef.current(newAvailability);
    }
  }, [buildAvailability, detectSoldOut, isUnlimitedTicket]);

  // Seed availability immediately from the initial ticket classes (using any
  // sold_count the public API already supplied), then fetch authoritative counts.
  useEffect(() => {
    if (!initialTicketClasses || !Array.isArray(initialTicketClasses)) return;
    ticketClassesRef.current = initialTicketClasses;

    const seeded = buildAvailability(initialTicketClasses);
    if (Object.keys(seeded).length > 0) {
      setTicketClassAvailability(seeded);
      previousAvailabilityRef.current = seeded;
    }
    refreshAvailability();
  }, [initialTicketClasses, buildAvailability, refreshAvailability]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return;
    if (!eventIdRef.current) return;

    const currentEventId = eventIdRef.current;
    const channelName = `complex-ticket-availability-${currentEventId}-${Math.random().toString(36).substr(2, 9)}`;
    const channel = supabase
      .channel(channelName)
      // Bookings drive availability — any confirmed booking added/removed/changed
      // can change the derived count.
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'complex_event_booking',
          filter: `event_id=eq.${currentEventId}`
        },
        () => {
          refreshAvailability();
          invalidateQueries();
        }
      )
      // Admins can edit the maximum (available_count) on the ticket class.
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'complex_event_ticket_class',
          filter: `complex_event_id=eq.${currentEventId}`
        },
        (payload) => {
          const ticketClasses = ticketClassesRef.current;
          if (Array.isArray(ticketClasses) && payload.new?.id) {
            const idx = ticketClasses.findIndex(tc => String(tc.id) === String(payload.new.id));
            if (idx >= 0) {
              const merged = [...ticketClasses];
              merged[idx] = { ...merged[idx], ...payload.new };
              ticketClassesRef.current = merged;
            }
          }
          refreshAvailability();
          invalidateQueries();
        }
      )
      .subscribe((status) => {
        setIsConnected(status === 'SUBSCRIBED');
      });

    return () => {
      supabase.removeChannel(channel);
      setIsConnected(false);
    };
  }, [complexEventId, invalidateQueries, refreshAvailability]);

  const getTicketClassAvailability = useCallback((ticketClassId) => {
    if (ticketClassId === null || ticketClassId === undefined) return null;
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
    invalidateQueries,
    refreshAvailability
  };
}
