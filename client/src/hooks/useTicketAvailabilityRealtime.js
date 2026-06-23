import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase, isSupabaseConfigured } from '@/api/supabaseClient';
import { toast } from 'sonner';

// Count-based ticket availability (Task #1758).
//
// `available_count` on each standard-event ticket class is a FIXED maximum
// (capacity), never mutated by bookings. Live availability is derived from the
// actual number of status='confirmed' bookings per ticket_class_id. This hook
// keeps that derived availability fresh by:
//   1. counting confirmed bookings per finite ticket class, and
//   2. subscribing to realtime booking changes (INSERT/UPDATE/DELETE) for the
//      event, plus event pricing_config changes (max can be edited by admins).
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
  const showSoldOutToastRef = useRef(showSoldOutToast);
  const pricingConfigRef = useRef(initialPricingConfig);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [ticketClassAvailability, setTicketClassAvailability] = useState({});
  const previousAvailabilityRef = useRef({});

  eventIdRef.current = eventId;
  onTicketSoldOutRef.current = onTicketSoldOut;
  onAvailabilityUpdatedRef.current = onAvailabilityUpdated;
  showSoldOutToastRef.current = showSoldOutToast;

  const invalidateEventQueries = useCallback(() => {
    if (eventIdRef.current) {
      queryClient.invalidateQueries({ queryKey: ['event', eventIdRef.current] });
      queryClient.invalidateQueries({ queryKey: ['/api/entities/Event', eventIdRef.current] });
      queryClient.invalidateQueries({ queryKey: ['/api/entities/Event'] });
    }
  }, [queryClient]);

  // Returns true when a ticket class has no enforceable maximum.
  const isUnlimitedTicket = useCallback((tc) => {
    const availCount = tc.available_count;
    return tc.is_unlimited_tickets === true ||
      availCount === null ||
      availCount === undefined ||
      availCount === '';
  }, []);

  // Parse the admin-set maximum. Unlimited -> null; invalid number -> 0 (treat
  // as sold out for safety).
  const parseMax = useCallback((tc) => {
    if (isUnlimitedTicket(tc)) return null;
    const num = Number(tc.available_count);
    return isNaN(num) ? 0 : num;
  }, [isUnlimitedTicket]);

  // Build the availability map from a pricing config and a map of confirmed
  // booking counts keyed by ticket class id. Falls back to any sold_count
  // already embedded on the ticket class (the public API provides it).
  const buildAvailability = useCallback((pricingConfig, soldCounts = {}) => {
    if (!pricingConfig?.ticket_classes) return {};

    const availability = {};
    pricingConfig.ticket_classes.forEach(tc => {
      if (!tc.id && tc.id !== 0) return;
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
    const pricingConfig = pricingConfigRef.current;
    const currentEventId = eventIdRef.current;
    if (!pricingConfig?.ticket_classes || !currentEventId) return;

    let soldCounts = {};

    if (isSupabaseConfigured && supabase) {
      const finiteIds = pricingConfig.ticket_classes
        .filter(tc => (tc.id || tc.id === 0) && !isUnlimitedTicket(tc))
        .map(tc => String(tc.id))
        .filter(id => id && id !== 'undefined' && id !== 'null');

      try {
        const results = await Promise.all(finiteIds.map(async (tcId) => {
          const { count, error } = await supabase
            .from('booking')
            .select('id', { count: 'exact', head: true })
            .eq('event_id', currentEventId)
            .eq('ticket_class_id', tcId)
            .eq('status', 'confirmed');
          if (error) {
            console.error('[useTicketAvailabilityRealtime] Count failed for ticket class', tcId, error.message);
            return [tcId, null];
          }
          return [tcId, count || 0];
        }));
        results.forEach(([tcId, count]) => {
          // null => count failed; leave it out so buildAvailability can fall
          // back to any embedded sold_count rather than reading it as 0.
          if (count !== null) soldCounts[tcId] = count;
        });
      } catch (err) {
        console.error('[useTicketAvailabilityRealtime] Failed to refresh sold counts:', err.message);
      }
    }

    const newAvailability = buildAvailability(pricingConfig, soldCounts);
    setTicketClassAvailability(newAvailability);
    setLastUpdate({ ticketClassAvailability: newAvailability, timestamp: Date.now() });

    detectSoldOut(newAvailability);
    previousAvailabilityRef.current = newAvailability;

    if (onAvailabilityUpdatedRef.current) {
      onAvailabilityUpdatedRef.current(newAvailability);
    }
  }, [buildAvailability, detectSoldOut, isUnlimitedTicket]);

  // Seed availability immediately from the initial pricing config (using any
  // sold_count the public API already supplied), then fetch authoritative
  // counts.
  useEffect(() => {
    if (!initialPricingConfig) return;
    pricingConfigRef.current = initialPricingConfig;

    const seeded = buildAvailability(initialPricingConfig);
    if (Object.keys(seeded).length > 0) {
      setTicketClassAvailability(seeded);
      previousAvailabilityRef.current = seeded;
    }
    refreshAvailability();
  }, [initialPricingConfig, buildAvailability, refreshAvailability]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      console.log('[useTicketAvailabilityRealtime] Supabase not configured, skipping realtime subscription');
      return;
    }

    if (!eventIdRef.current) {
      console.log('[useTicketAvailabilityRealtime] No event ID, skipping subscription');
      return;
    }

    const currentEventId = eventIdRef.current;
    console.log('[useTicketAvailabilityRealtime] Setting up realtime subscription for event:', currentEventId);

    const channelName = `ticket-availability-${currentEventId}-${Math.random().toString(36).substr(2, 9)}`;
    const channel = supabase
      .channel(channelName)
      // Bookings drive availability — any confirmed booking added/removed/changed
      // can change the derived count.
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'booking',
          filter: `event_id=eq.${currentEventId}`
        },
        () => {
          refreshAvailability();
          invalidateEventQueries();
        }
      )
      // Admins can edit the maximum (available_count) on the event pricing config.
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'event',
          filter: `id=eq.${currentEventId}`
        },
        (payload) => {
          if (payload.new?.pricing_config) {
            pricingConfigRef.current = payload.new.pricing_config;
          }
          refreshAvailability();
          invalidateEventQueries();
        }
      )
      .subscribe((status) => {
        console.log('[useTicketAvailabilityRealtime] Subscription status:', status);
        setIsConnected(status === 'SUBSCRIBED');
      });

    return () => {
      console.log('[useTicketAvailabilityRealtime] Cleaning up realtime subscription for event:', currentEventId);
      supabase.removeChannel(channel);
      setIsConnected(false);
    };
  }, [eventId, invalidateEventQueries, refreshAvailability]);

  // Helper function to get availability for a specific ticket class
  const getTicketClassAvailability = useCallback((ticketClassId) => {
    if (ticketClassId === null || ticketClassId === undefined) return null;
    return ticketClassAvailability[String(ticketClassId)] || null;
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
    invalidateEventQueries,
    refreshAvailability
  };
}
