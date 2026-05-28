import { useQuery } from '@tanstack/react-query';
import { base44 } from '../api/base44Client';
import { publicClient } from '../api/publicClient';
import { useLayoutContext } from '../contexts/LayoutContext';

/**
 * Hybrid hook for fetching events data.
 * 
 * This hook automatically detects whether the user is authenticated and routes
 * to the appropriate data source:
 * - Authenticated users: base44.entities.Event (full data including member-only tickets)
 * - Public visitors: publicClient.listEvents() (public-safe data only)
 * 
 * SECURITY: Only trusts memberInfo from LayoutContext (validated via /api/auth/me).
 * Does NOT trust localStorage directly to prevent stale session attacks.
 * 
 * @param {Object} options - Query options
 * @param {boolean} options.forcePublic - Force using public API even if authenticated
 * @returns {Object} Query result with events data
 */
export function useEventsData({ forcePublic = false, includeGroupEvents = false } = {}) {
  const { memberInfo, forcePublicLayout, sessionValidated } = useLayoutContext();
  
  // SECURITY: Require BOTH memberInfo AND sessionValidated to treat as authenticated.
  // sessionValidated is set to true ONLY after /api/auth/me succeeds in Layout.jsx.
  // This prevents using stale localStorage data before server validation completes.
  const isAuthenticated = !!memberInfo && !!sessionValidated && !forcePublicLayout && !forcePublic;
  
  // Group events (member_group_id set) are private to a specific member group and
  // must never appear in generic event lists. Only the admin /Events page opts in
  // by passing includeGroupEvents=true; everywhere else strips them client-side.
  const stripGroupEvents = (list) => includeGroupEvents
    ? list
    : (list || []).filter((e) => !e?.member_group_id);

  return useQuery({
    queryKey: ['events', isAuthenticated ? 'authenticated' : 'public', includeGroupEvents ? 'with-group' : 'no-group'],
    queryFn: async () => {
      try {
        if (isAuthenticated) {
          // Authenticated path: use base44 entity API (session-scoped, full data)
          const data = await base44.entities.Event.list({ sort: { start_date: 'asc' } });
          return stripGroupEvents(data);
        } else {
          // Public path: use publicClient (tenant-scoped, filtered data)
          const data = await publicClient.listEvents();
          return stripGroupEvents(data);
        }
      } catch (error) {
        console.error('[useEventsData] Error loading events:', error);
        // If authenticated request fails (e.g., session expired), fall back to public
        if (isAuthenticated) {
          console.log('[useEventsData] Falling back to public API');
          try {
            const publicData = await publicClient.listEvents();
            return stripGroupEvents(publicData);
          } catch (fallbackError) {
            console.error('[useEventsData] Fallback also failed:', fallbackError);
            throw fallbackError;
          }
        }
        throw error;
      }
    },
    staleTime: 0,
    refetchOnMount: true,
  });
}

/**
 * Hybrid hook for fetching a single event by ID.
 * 
 * SECURITY: Only trusts memberInfo from LayoutContext (validated via /api/auth/me).
 * Does NOT trust localStorage directly to prevent stale session attacks.
 * 
 * @param {string} eventId - The event ID to fetch
 * @param {Object} options - Query options  
 * @param {boolean} options.forcePublic - Force using public API even if authenticated
 * @returns {Object} Query result with event data
 */
export function useEventData(eventId, { forcePublic = false } = {}) {
  const { memberInfo, forcePublicLayout, sessionValidated } = useLayoutContext();
  
  // SECURITY: Require BOTH memberInfo AND sessionValidated to treat as authenticated.
  const isAuthenticated = !!memberInfo && !!sessionValidated && !forcePublicLayout && !forcePublic;
  
  return useQuery({
    queryKey: ['event', eventId, isAuthenticated ? 'authenticated' : 'public'],
    enabled: !!eventId,
    queryFn: async () => {
      try {
        if (isAuthenticated) {
          const data = await base44.entities.Event.get(eventId);
          return data;
        } else {
          const data = await publicClient.getEvent(eventId);
          return data;
        }
      } catch (error) {
        console.error('[useEventData] Error loading event:', error);
        if (isAuthenticated) {
          console.log('[useEventData] Falling back to public API');
          try {
            return await publicClient.getEvent(eventId);
          } catch (fallbackError) {
            console.error('[useEventData] Fallback also failed:', fallbackError);
            throw fallbackError;
          }
        }
        throw error;
      }
    },
    staleTime: 30 * 1000,
  });
}

export function useEventDataBySlug(slug, { forcePublic = false } = {}) {
  const { memberInfo, forcePublicLayout, sessionValidated } = useLayoutContext();
  
  const isAuthenticated = !!memberInfo && !!sessionValidated && !forcePublicLayout && !forcePublic;
  
  return useQuery({
    queryKey: ['event-by-slug', slug, isAuthenticated ? 'authenticated' : 'public'],
    enabled: !!slug,
    queryFn: async () => {
      try {
        if (isAuthenticated) {
          const allEvents = await base44.entities.Event.list();
          const event = allEvents.find(e => e.slug === slug);
          if (!event) throw new Error('Event not found');
          return event;
        } else {
          const data = await publicClient.getEventBySlug(slug);
          return data;
        }
      } catch (error) {
        console.error('[useEventDataBySlug] Error loading event:', error);
        if (isAuthenticated) {
          try {
            return await publicClient.getEventBySlug(slug);
          } catch (fallbackError) {
            throw fallbackError;
          }
        }
        throw error;
      }
    },
    staleTime: 30 * 1000,
  });
}
