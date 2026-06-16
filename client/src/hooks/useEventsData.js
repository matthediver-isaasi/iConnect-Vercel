import { useQuery } from '@tanstack/react-query';
import { base44 } from '../api/base44Client';
import { publicClient } from '../api/publicClient';
import { useLayoutContext } from '../contexts/LayoutContext';

/**
 * Task #1519 — /Events visibility helpers for group events.
 *
 * Group events are real events that carry a `member_group_id`. They behave like
 * normal events on /Events, gated by audience:
 *   - group_event_public === true  → visible to everyone (incl. anonymous)
 *   - group_event_public !== true  → "Members only": visible ONLY to members
 *                                     (or admins) of that group, never anon.
 * Old bespoke RSVP-style group events (a simple event with a member_group_id
 * but no ticket classes) are dormant and must be hidden from /Events.
 */

// A simple group event with no ticket classes is a dormant bespoke RSVP event.
export function isBespokeRsvpEvent(e) {
  if (!e?.member_group_id) return false;
  if (e.is_complex) return false;
  const tc = e?.pricing_config?.ticket_classes;
  return !Array.isArray(tc) || tc.length === 0;
}

// A group event restricted to its group's members (not public).
export function isGroupOnlyEvent(e) {
  return !!e?.member_group_id && e?.group_event_public !== true;
}

/**
 * Filter a list of events for /Events visibility.
 * @param {Array} list
 * @param {Object} opts
 * @param {boolean} opts.isAdmin - tenant admins see all group events
 * @param {Set<string>|Array<string>} opts.myGroupIds - groups the caller belongs to
 */
export function filterGroupEventVisibility(list, { isAdmin = false, myGroupIds } = {}) {
  const ids = myGroupIds instanceof Set ? myGroupIds : new Set(myGroupIds || []);
  return (list || []).filter((e) => {
    // Ordinary (non-group) events are always visible.
    if (!e?.member_group_id) return true;
    // Hide dormant bespoke RSVP events entirely.
    if (isBespokeRsvpEvent(e)) return false;
    // Public group events are visible to everyone.
    if (e.group_event_public === true) return true;
    // Group-only events: visible to admins and members of the group only.
    if (isAdmin) return true;
    return ids.has(e.member_group_id);
  });
}

/**
 * Returns the member_group ids the current caller is an active member of.
 * Empty for anonymous visitors. Used to gate group-only event visibility.
 */
export function useMyGroupIds() {
  const { memberInfo, sessionValidated } = useLayoutContext();
  const enabled = !!memberInfo && !!sessionValidated;
  return useQuery({
    queryKey: ['my-group-ids'],
    enabled,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      try {
        const res = await fetch('/api/member-group-events/my-groups', { credentials: 'include' });
        if (!res.ok) return [];
        const data = await res.json().catch(() => ({}));
        return Array.isArray(data.groupIds) ? data.groupIds : [];
      } catch {
        return [];
      }
    },
  });
}

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
export function useEventsData({ forcePublic = false, includeGroupEvents = false, isAdmin = false } = {}) {
  const { memberInfo, forcePublicLayout, sessionValidated } = useLayoutContext();
  
  // SECURITY: Require BOTH memberInfo AND sessionValidated to treat as authenticated.
  // sessionValidated is set to true ONLY after /api/auth/me succeeds in Layout.jsx.
  // This prevents using stale localStorage data before server validation completes.
  const isAuthenticated = !!memberInfo && !!sessionValidated && !forcePublicLayout && !forcePublic;

  // Groups the caller belongs to — used to gate group-only event visibility.
  const { data: myGroupIds = [] } = useMyGroupIds();

  // Group event visibility (Task #1519):
  // - includeGroupEvents=false (default, e.g. spotlight widgets): strip ALL
  //   group events for backwards-compatible behaviour.
  // - includeGroupEvents=true (the /Events page): apply audience rules — public
  //   group events for everyone, group-only events for members/admins, dormant
  //   bespoke RSVP events hidden.
  const applyVisibility = (list) => includeGroupEvents
    ? filterGroupEventVisibility(list, { isAdmin, myGroupIds })
    : (list || []).filter((e) => !e?.member_group_id);

  return useQuery({
    queryKey: ['events', isAuthenticated ? 'authenticated' : 'public'],
    queryFn: async () => {
      try {
        if (isAuthenticated) {
          // Authenticated path: use base44 entity API (session-scoped, full data)
          return await base44.entities.Event.list({ sort: { start_date: 'asc' } });
        } else {
          // Public path: use publicClient (tenant-scoped, filtered data)
          return await publicClient.listEvents();
        }
      } catch (error) {
        console.error('[useEventsData] Error loading events:', error);
        // If authenticated request fails (e.g., session expired), fall back to public
        if (isAuthenticated) {
          console.log('[useEventsData] Falling back to public API');
          try {
            return await publicClient.listEvents();
          } catch (fallbackError) {
            console.error('[useEventsData] Fallback also failed:', fallbackError);
            throw fallbackError;
          }
        }
        throw error;
      }
    },
    select: applyVisibility,
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
