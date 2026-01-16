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
export function useEventsData({ forcePublic = false } = {}) {
  const { memberInfo, forcePublicLayout, sessionValidated } = useLayoutContext();
  
  // SECURITY: Require BOTH memberInfo AND sessionValidated to treat as authenticated.
  // sessionValidated is set to true ONLY after /api/auth/me succeeds in Layout.jsx.
  // This prevents using stale localStorage data before server validation completes.
  const isAuthenticated = !!memberInfo && !!sessionValidated && !forcePublicLayout && !forcePublic;
  
  return useQuery({
    queryKey: ['events', isAuthenticated ? 'authenticated' : 'public'],
    queryFn: async () => {
      try {
        if (isAuthenticated) {
          // Authenticated path: use base44 entity API (session-scoped, full data)
          const data = await base44.entities.Event.list({ sort: { start_date: 'asc' } });
          return data || [];
        } else {
          // Public path: use publicClient (tenant-scoped, filtered data)
          const data = await publicClient.listEvents();
          return data || [];
        }
      } catch (error) {
        console.error('[useEventsData] Error loading events:', error);
        // If authenticated request fails (e.g., session expired), fall back to public
        if (isAuthenticated) {
          console.log('[useEventsData] Falling back to public API');
          try {
            const publicData = await publicClient.listEvents();
            return publicData || [];
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
