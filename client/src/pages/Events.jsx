import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, Calendar, Plus, History, Tag, Check, ChevronDown, Layers, X, MapPin, FileEdit, Clock, Users, Ticket, Pencil, Trash2, UsersRound, List, Star, ArrowUpDown, Download, Upload, ChevronLeft, ChevronRight, Loader2, CheckCircle2, XCircle, AlertTriangle, AlertCircle, Send, Copy } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { parseISO, format } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { Link, useSearchParams } from "react-router-dom";
import { getFocalPointStyle } from "@/components/FocalPointPicker";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import EventCard from "../components/events/EventCard";
import PageTour from "../components/tour/PageTour";
import TourButton from "../components/tour/TourButton";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
import { useLayoutContext } from "@/contexts/LayoutContext";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useEventsData } from "@/hooks/useEventsData";
import { createPageUrl } from "@/utils";
import { useEventTypes } from "@/hooks/useEventTypes";
import { 
  createFilterTagKey, 
  parseFilterTagKey, 
  buildFilterTagKeyMap, 
  normalizeFilterTags,
  getFilterTagLabels,
  parseEventTypes
} from "@/lib/utils";

const DEFAULT_TIMEZONE = "Europe/London";

const isEventInPast = (event) => {
  const dateStr = event.end_date || event.start_date;
  if (!dateStr) return false;
  try {
    const eventDate = typeof dateStr === 'string' 
      ? parseISO(dateStr) 
      : new Date(dateStr);
    return eventDate < new Date();
  } catch {
    return false;
  }
};

const getEventTypeStyle = (eventTypeName, systemSettings) => {
  const defaultStyle = { bgColor: '#dcfce7', textColor: '#15803d' };
  if (!eventTypeName || !systemSettings?.length) return defaultStyle;
  const eventTypesSetting = systemSettings.find(s => s.setting_key === 'event_types');
  if (!eventTypesSetting?.setting_value) return defaultStyle;
  try {
    const eventTypes = JSON.parse(eventTypesSetting.setting_value);
    const eventType = eventTypes.find(t => 
      (typeof t === 'string' && t === eventTypeName) ||
      (typeof t === 'object' && t.name === eventTypeName)
    );
    if (eventType && typeof eventType === 'object') {
      return {
        bgColor: eventType.bgColor || defaultStyle.bgColor,
        textColor: eventType.textColor || defaultStyle.textColor
      };
    }
  } catch (e) {
    console.error('Error parsing event types:', e);
  }
  return defaultStyle;
};

const getCtaButtonConfig = (systemSettings) => {
  const defaultConfig = { style: 'default', label: 'Register' };
  if (!systemSettings?.length) return defaultConfig;
  const ctaSetting = systemSettings.find(s => s.setting_key === 'event_cta_button');
  if (!ctaSetting?.setting_value) return defaultConfig;
  try {
    const config = JSON.parse(ctaSetting.setting_value);
    return {
      style: config.style || 'default',
      label: config.label || 'Register'
    };
  } catch (e) {
    console.error('Error parsing CTA button config:', e);
    return defaultConfig;
  }
};

const stripHtmlTags = (html) => {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
};

export default function EventsPage({
  organizationInfo: propsOrganizationInfo,
  isFeatureExcluded,
  memberInfo: propsMemberInfo,
  memberRole,
  reloadMemberInfo,
}) {
  // Get hasBanner, refreshOrganizationInfo, organizationInfo and memberInfo from layout context
  const { 
    hasBanner, 
    refreshOrganizationInfo,
    organizationInfo: contextOrganizationInfo,
    memberInfo: contextMemberInfo,
    isFeatureExcluded: contextIsFeatureExcluded
  } = useLayoutContext();
  
  // Use context values if available, otherwise fall back to props
  // This fixes the issue where PublicLayout doesn't pass memberInfo props
  const organizationInfo = contextOrganizationInfo || propsOrganizationInfo;
  const memberInfo = contextMemberInfo || propsMemberInfo;
  // Use context isFeatureExcluded if available, otherwise use prop
  const resolvedIsFeatureExcluded = contextIsFeatureExcluded || isFeatureExcluded || (() => false);
  const { isFeatureExcluded: hookIsFeatureExcluded, memberRole: hookMemberRole } = useMemberAccess();
  // Use prop memberRole if available, otherwise fall back to hook
  const resolvedMemberRole = memberRole || hookMemberRole;
  // Derive admin status from feature exclusion - admins can create/manage events
  const isAdmin = !hookIsFeatureExcluded('events.browse-events.create');
  const queryClient = useQueryClient();
  const { eventTypes } = useEventTypes();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchQuery, setSearchQuery] = useState("");
  const [complexDeleteTarget, setComplexDeleteTarget] = useState(null);
  const [complexDeleteConfirmText, setComplexDeleteConfirmText] = useState("");
  const [selectedDeliveryMode, setSelectedDeliveryMode] = useState("all");
  const [sortBy, setSortBy] = useState("date");
  const [showPastEvents, setShowPastEvents] = useState(false);
  const [showDraftEvents, setShowDraftEvents] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [showCreateEventModal, setShowCreateEventModal] = useState(false);
  const [tourAutoShow, setTourAutoShow] = useState(false);

  const [complexAttendeesEvent, setComplexAttendeesEvent] = useState(null);
  const [complexAttendeesOrgFilter, setComplexAttendeesOrgFilter] = useState("all");
  const [complexAttendeesSearch, setComplexAttendeesSearch] = useState("");
  const [complexAttendeesPage, setComplexAttendeesPage] = useState(1);
  const complexAttendeesPerPage = 25;
  const [showComplexImportDialog, setShowComplexImportDialog] = useState(false);
  const [complexImportEmailsText, setComplexImportEmailsText] = useState("");
  const [complexImportResults, setComplexImportResults] = useState(null);
  const [complexImportTicketClassId, setComplexImportTicketClassId] = useState("");
  const [complexImportSendConfirmations, setComplexImportSendConfirmations] = useState(true);
  const [complexImportTicketClasses, setComplexImportTicketClasses] = useState([]);

  // Determine if tours should be shown for this user based on role setting
  const shouldShowTours = resolvedMemberRole?.show_tours !== false;

  // Check if user has seen this page's tour
  const hasSeenTour = memberInfo?.page_tours_seen?.Events === true;

  // Refresh organization info on mount to get latest ticket balances
  useEffect(() => {
    if (refreshOrganizationInfo) {
      refreshOrganizationInfo();
    }
  }, []); // Only run on mount

  // Auto-show tour on first visit if tours are enabled
  useEffect(() => {
    if (shouldShowTours && !hasSeenTour && memberInfo) {
      setTourAutoShow(true);
      setShowTour(true);
    }
  }, [shouldShowTours, hasSeenTour, memberInfo]);

  // Load simple events using hybrid hook (authenticated: base44, public: publicClient)
  const {
    data: simpleEvents = [],
    isLoading: isLoadingSimple,
    error: eventsError,
  } = useEventsData({ includeGroupEvents: true });

  const { data: complexEvents = [], isLoading: isLoadingComplex } = useQuery({
    queryKey: ['complex-events-for-listing', !!memberInfo],
    queryFn: async () => {
      let data;
      if (memberInfo) {
        data = await base44.entities.ComplexEvent.list();
        const events = data || [];
        const eventIds = events.map(e => e.id);
        if (eventIds.length > 0) {
          const [allSessions, allTracks, allTicketClasses] = await Promise.all([
            base44.entities.ComplexEventSession.listAll(),
            base44.entities.ComplexEventTrack.listAll(),
            base44.entities.ComplexEventTicketClass.listAll()
          ]);
          const sessionCounts = {};
          const trackCounts = {};
          const cheapestPrices = {};
          (allSessions || []).forEach(s => {
            if (eventIds.includes(s.complex_event_id)) {
              sessionCounts[s.complex_event_id] = (sessionCounts[s.complex_event_id] || 0) + 1;
            }
          });
          (allTracks || []).forEach(t => {
            if (eventIds.includes(t.complex_event_id)) {
              trackCounts[t.complex_event_id] = (trackCounts[t.complex_event_id] || 0) + 1;
            }
          });
          (allTicketClasses || []).forEach(tc => {
            if (eventIds.includes(tc.complex_event_id)) {
              const price = Number(tc.price);
              if (Number.isFinite(price)) {
                if (cheapestPrices[tc.complex_event_id] === undefined || price < cheapestPrices[tc.complex_event_id]) {
                  cheapestPrices[tc.complex_event_id] = price;
                }
              }
            }
          });
          return events.map(e => ({
            ...e,
            is_complex: true,
            session_count: sessionCounts[e.id] || 0,
            track_count: trackCounts[e.id] || 0,
            cheapest_price: cheapestPrices[e.id] ?? null
          }));
        }
        return events.map(e => ({ ...e, is_complex: true, session_count: 0, track_count: 0, cheapest_price: null }));
      } else {
        data = await publicClient.listComplexEvents();
        return (data || []).map(e => ({ ...e, is_complex: true }));
      }
    },
    staleTime: 0
  });

  const events = useMemo(() => {
    return [...simpleEvents, ...complexEvents];
  }, [simpleEvents, complexEvents]);

  const isLoading = isLoadingSimple || isLoadingComplex;

  // Query for all system settings (using public endpoint for unauthenticated access)
  const { data: systemSettings = [] } = useQuery({
    queryKey: ['public-system-settings'],
    queryFn: () => publicClient.listSystemSettings()
  });

  const [complexDeleteOrganiserMessage, setComplexDeleteOrganiserMessage] = useState("");
  const [complexDeleteResultSummary, setComplexDeleteResultSummary] = useState(null);
  const [complexDeletePreview, setComplexDeletePreview] = useState(null);
  const [complexDeletePreviewLoading, setComplexDeletePreviewLoading] = useState(false);
  const [complexDeletePreviewError, setComplexDeletePreviewError] = useState(null);

  useEffect(() => {
    if (!complexDeleteTarget?.id) {
      setComplexDeletePreview(null);
      setComplexDeletePreviewError(null);
      return;
    }
    let cancelled = false;
    setComplexDeletePreviewLoading(true);
    setComplexDeletePreview(null);
    setComplexDeletePreviewError(null);
    fetch(`/api/complex-events/${complexDeleteTarget.id}/delete-preview`, { credentials: 'include' })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) setComplexDeletePreviewError(data.error || `Preview failed (${r.status})`);
        else setComplexDeletePreview(data);
      })
      .catch((err) => { if (!cancelled) setComplexDeletePreviewError(err.message || 'Preview failed'); })
      .finally(() => { if (!cancelled) setComplexDeletePreviewLoading(false); });
    return () => { cancelled = true; };
  }, [complexDeleteTarget?.id]);

  const deleteComplexEventMutation = useMutation({
    mutationFn: async (id) => {
      const response = await fetch(`/api/complex-events/${id}/delete-with-cancellations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ organiser_message: complexDeleteOrganiserMessage || null }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const err = new Error(data.error || `Delete failed (${response.status})`);
        err.payload = data;
        throw err;
      }
      return data;
    },
    onSuccess: (data) => {
      const total = data.totalBookings || 0;
      const succeeded = (data.succeeded || 0) + (data.alreadyCancelled || 0);
      const manual = (data.requiresManualAction || []).length;
      let msg = total === 0
        ? 'Complex event deleted successfully'
        : `Complex event deleted — ${succeeded}/${total} bookings cancelled`;
      if (manual > 0) msg += ` (${manual} need manual refund/credit-note follow-up)`;
      toast.success(msg);
      queryClient.invalidateQueries({ queryKey: ['complex-events-for-listing'] });
      setComplexDeleteTarget(null);
      setComplexDeleteConfirmText("");
      setComplexDeleteOrganiserMessage("");
      setComplexDeleteResultSummary(null);
    },
    onError: (error) => {
      console.error('Delete complex event error:', error);
      const payload = error.payload;
      if (payload && Array.isArray(payload.failed) && payload.failed.length > 0) {
        setComplexDeleteResultSummary(payload);
        toast.error(`${payload.failed.length} booking(s) failed to cancel — see details below. Resolve and re-run.`);
      } else {
        toast.error('Failed to delete event: ' + (error.message || 'Unknown error'));
      }
    }
  });

  // Query for webinar join link visibility settings (using public endpoint)
  const { data: joinLinkSettings } = useQuery({
    queryKey: ['public-webinar-join-link-settings'],
    queryFn: async () => {
      const allSettings = await publicClient.listSystemSettings();
      const setting = allSettings.find(s => s.setting_key === 'webinar_show_join_link');
      if (setting && setting.setting_value) {
        try {
          return JSON.parse(setting.setting_value);
        } catch {
          return {};
        }
      }
      return {};
    }
  });

  // Query for webinars to match URLs to webinar IDs
  // Only runs for authenticated users - skipped on public pages
  const { data: webinars = [] } = useQuery({
    queryKey: ['/api/zoom/webinars'],
    queryFn: async () => {
      try {
        const response = await fetch('/api/zoom/webinars');
        if (!response.ok) return [];
        return await response.json();
      } catch {
        return [];
      }
    },
    enabled: !!memberInfo // Only fetch when authenticated
  });

  // Query for categories that apply to Events content type - return full categories with subcategories
  // Runs for both authenticated (base44) and public (publicClient) visitors so the
  // category URL filter works when logged out. Both sources return the same shape.
  const { data: eventCategories = [] } = useQuery({
    queryKey: ['event-filter-categories', !!memberInfo],
    queryFn: async () => {
      try {
        // Get all active categories that have 'Events' in their applies_to_content_types
        const categories = memberInfo
          ? await base44.entities.ResourceCategory.list('display_order')
          : await publicClient.listResourceCategories();
        const filtered = categories.filter(cat => 
          cat.is_active && 
          Array.isArray(cat.applies_to_content_types) && 
          cat.applies_to_content_types.includes('Events') &&
          Array.isArray(cat.subcategories) &&
          cat.subcategories.length > 0
        );
        // Return full category objects with id, name, and subcategories
        return filtered.map(cat => ({
          id: cat.id,
          name: cat.name,
          subcategories: cat.subcategories || []
        }));
      } catch (error) {
        console.error('[Events] Error loading filter categories:', error);
        return [];
      }
    }
  });

  if (eventsError) {
    console.error("[Events] eventsError:", eventsError);
  }

  // Build filter tag key map for display and filtering
  const filterTagKeyMap = useMemo(() => buildFilterTagKeyMap(eventCategories), [eventCategories]);

  // Check if user can toggle draft visibility - requires authentication
  const canToggleDrafts = !!memberInfo && !hookIsFeatureExcluded('events.browse-events.toggle-drafts');

  // Filter events by status and access level
  // - Draft events are hidden by default for everyone
  // - Users with toggle-drafts permission can enable draft visibility
  // - Everyone sees published and tbc events
  // - Non-logged-in users can view member-only events but tickets will be locked
  //   This allows advertising member-only events to encourage membership signup
  const accessibleEvents = useMemo(() => {
    let filtered = events;
    
    // Filter by event_state - drafts are hidden by default, shown only when toggle is on
    // Active and closed events are always shown (closed = visible but registration disabled)
    // Note: event.status now stores timing (published/tbc), event_state stores visibility (active/draft/closed)
    filtered = filtered.filter(event => {
      // Check if event is a draft (new field or legacy fallback)
      const isDraft = event.event_state === 'draft' || (!event.event_state && event.status === 'draft');
      if (isDraft) {
        // Only show drafts if user has permission AND toggle is on
        return canToggleDrafts && showDraftEvents;
      }
      // Show all non-draft events (active, closed, or legacy published/tbc)
      return true;
    });
    
    return filtered;
  }, [events, canToggleDrafts, showDraftEvents]);

  // Helper to check if event is in the past (timezone-aware)
  const isEventPast = (event) => {
    const dateStr = event.end_date || event.start_date;
    if (!dateStr) return false;
    try {
      const eventDate = typeof dateStr === 'string' 
        ? parseISO(dateStr) 
        : new Date(dateStr);
      const now = new Date();
      return eventDate < now;
    } catch {
      return false;
    }
  };

  console.log('[Events] Debug - accessibleEvents count:', accessibleEvents.length);
  console.log('[Events] Debug - searchQuery:', searchQuery);
  console.log('[Events] Debug - showPastEvents:', showPastEvents);
  console.log('[Events] Debug - memberInfo exists:', !!memberInfo);
  console.log('[Events] Debug - memberInfo source:', contextMemberInfo ? 'context' : (propsMemberInfo ? 'props' : 'none'));
  
  // Check if categories are loaded - needed for composite key filtering
  const categoriesLoaded = eventCategories.length > 0;

  // The URL query string is the single source of truth for the category & type
  // filters, so the filtered view can be linked to, refreshed, shared, and moved
  // through with browser back/forward (works for authenticated & public). Filter
  // values are derived from `searchParams` on each render and dropdown handlers
  // write straight back to the URL — there is no separate filter state to keep in
  // sync, which removes the bidirectional effect loop entirely.
  //
  // Stale/unknown params are ignored gracefully: an invalid `type` reads as "all"
  // and unknown category keys are dropped from the active selection. Validation
  // only kicks in once the relevant data has loaded so a valid param present
  // before load is never treated as invalid (and we never write the URL back to
  // strip it).
  const selectedEventType = useMemo(() => {
    const rawType = searchParams.get("type") || "all";
    if (rawType === "all") return "all";
    const typeNames = eventTypes.map((t) => (typeof t === "object" ? t.name : t));
    // Accept tentatively while types are still loading; validate once loaded.
    if (typeNames.length === 0 || typeNames.includes(rawType)) {
      return rawType;
    }
    return "all";
  }, [searchParams, eventTypes]);

  const selectedFilterTags = useMemo(() => {
    const rawTags = searchParams.getAll("category");
    return categoriesLoaded
      ? rawTags.filter((key) => filterTagKeyMap.has(key))
      : rawTags;
  }, [searchParams, categoriesLoaded, filterTagKeyMap]);

  // Mutate only the filter params on the URL, preserving any unrelated params.
  // Uses { replace: true } so adjusting filters doesn't flood browser history;
  // genuine navigation (shared links, back/forward) still restores state because
  // the values above are derived directly from `searchParams`.
  const updateFilterParams = useCallback((mutate) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      mutate(next);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const setSelectedEventType = useCallback((type) => {
    updateFilterParams((next) => {
      if (!type || type === "all") {
        next.delete("type");
      } else {
        next.set("type", type);
      }
    });
  }, [updateFilterParams]);

  const setFilterTagSelected = useCallback((tagKey, selected) => {
    updateFilterParams((next) => {
      const current = next.getAll("category");
      next.delete("category");
      const updated = selected
        ? [...current, tagKey]
        : current.filter((t) => t !== tagKey);
      for (const t of updated) next.append("category", t);
    });
  }, [updateFilterParams]);

  const clearFilterTags = useCallback(() => {
    updateFilterParams((next) => next.delete("category"));
  }, [updateFilterParams]);

  let filteredEvents = accessibleEvents.filter((event) => {
    const matchesSearch =
      event.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      event.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      event.location?.toLowerCase().includes(searchQuery.toLowerCase());
    
    // Handle filter tag filtering - match if event has ANY of the selected tags
    // Skip filter tag check if categories not loaded (prevents false filtering on initial load)
    let matchesFilterTag = true;
    if (selectedFilterTags.length > 0 && categoriesLoaded) {
      const rawEventTags = event.filter_tags || [];
      const normalizedEventTags = normalizeFilterTags(rawEventTags, eventCategories);
      matchesFilterTag = selectedFilterTags.some(tag => normalizedEventTags.includes(tag));
    }
    
    // Handle event type filtering
    let matchesEventType = true;
    if (selectedEventType !== "all") {
      matchesEventType = parseEventTypes(event.event_type).includes(selectedEventType);
    }
    
    // Handle delivery mode filtering (online/in-person)
    // Uses is_online boolean field - events without it are treated as in-person (false)
    let matchesDeliveryMode = true;
    if (selectedDeliveryMode !== "all") {
      const eventIsOnline = event.is_online === true;
      if (selectedDeliveryMode === "online") {
        matchesDeliveryMode = eventIsOnline;
      } else if (selectedDeliveryMode === "offline") {
        matchesDeliveryMode = !eventIsOnline;
      }
    }
    
    // Filter out past events unless showPastEvents is enabled
    const isPast = isEventPast(event);
    const matchesTimeFilter = showPastEvents || !isPast;
    
    // Debug log for each event
    if (!matchesTimeFilter || !matchesSearch || !matchesFilterTag || !matchesEventType || !matchesDeliveryMode) {
      console.log(`[Events] Filtered out: "${event.title}" - search:${matchesSearch}, filterTag:${matchesFilterTag}, eventType:${matchesEventType}, deliveryMode:${matchesDeliveryMode} (is_online: ${event.is_online}), time:${matchesTimeFilter}, isPast:${isPast}, start_date:${event.start_date}`);
    }
    
    return matchesSearch && matchesFilterTag && matchesEventType && matchesDeliveryMode && matchesTimeFilter;
  });
  
  console.log('[Events] Debug - filteredEvents count:', filteredEvents.length);

  const getEventPrice = (event) => {
    if (event.cheapest_price !== undefined && event.cheapest_price !== null) {
      return Number(event.cheapest_price);
    }
    const tcs = event.pricing_config?.ticket_classes;
    if (!tcs?.length) return null;
    const prices = tcs.map(tc => Number(tc.price)).filter(p => Number.isFinite(p));
    return prices.length > 0 ? Math.min(...prices) : null;
  };

  if (sortBy === 'price_asc' || sortBy === 'price_desc') {
    filteredEvents.sort((a, b) => {
      const priceA = getEventPrice(a);
      const priceB = getEventPrice(b);
      if (priceA === null && priceB === null) return 0;
      if (priceA === null) return 1;
      if (priceB === null) return -1;
      return sortBy === 'price_asc' ? priceA - priceB : priceB - priceA;
    });
  } else {
    filteredEvents.sort((a, b) => {
      const aIsTbc = a.status === 'tbc' || !a.start_date;
      const bIsTbc = b.status === 'tbc' || !b.start_date;
      if (aIsTbc && !bIsTbc) return 1;
      if (!aIsTbc && bIsTbc) return -1;
      if (aIsTbc && bIsTbc) {
        return (a.title || '').localeCompare(b.title || '');
      }
      const dateA = new Date(a.start_date);
      const dateB = new Date(b.start_date);
      return dateA.getTime() - dateB.getTime();
    });
  }

  const featuredEvents = filteredEvents.filter(e => e.is_featured === true);
  const nonFeaturedEvents = filteredEvents.filter(e => e.is_featured !== true);

  const featuredBgSetting = (() => {
    const setting = Array.isArray(systemSettings)
      ? systemSettings.find(item => item.setting_key === 'featured_events_background')
      : null;
    if (setting?.setting_value) {
      try { return JSON.parse(setting.setting_value); } catch { return null; }
    }
    return null;
  })();

  const featuredBgStyle = featuredBgSetting
    ? featuredBgSetting.mode === 'gradient'
      ? { background: `linear-gradient(to right, ${featuredBgSetting.from}, ${featuredBgSetting.to})` }
      : { background: featuredBgSetting.color }
    : { background: '#f0f9ff' };
  
  // Count past events for the toggle label
  const pastEventsCount = accessibleEvents.filter(event => {
    const matchesSearch =
      event.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      event.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      event.location?.toLowerCase().includes(searchQuery.toLowerCase());
    
    // Use same filter tag matching logic with normalization (skip if categories not loaded)
    let matchesFilterTag = true;
    if (selectedFilterTags.length > 0 && categoriesLoaded) {
      const rawEventTags = event.filter_tags || [];
      const normalizedEventTags = normalizeFilterTags(rawEventTags, eventCategories);
      matchesFilterTag = selectedFilterTags.some(tag => normalizedEventTags.includes(tag));
    }
    
    // Use same event type matching logic
    let matchesEventType = true;
    if (selectedEventType !== "all") {
      matchesEventType = parseEventTypes(event.event_type).includes(selectedEventType);
    }
    
    // Use same delivery mode matching logic
    // Uses is_online boolean field - events without it are treated as in-person (false)
    let matchesDeliveryMode = true;
    if (selectedDeliveryMode !== "all") {
      const eventIsOnline = event.is_online === true;
      if (selectedDeliveryMode === "online") {
        matchesDeliveryMode = eventIsOnline;
      } else if (selectedDeliveryMode === "offline") {
        matchesDeliveryMode = !eventIsOnline;
      }
    }
    
    return matchesSearch && matchesFilterTag && matchesEventType && matchesDeliveryMode && isEventPast(event);
  }).length;

  // Count draft events for the toggle label (only count if user has permission)
  // Check event_state for new events, with backward compatibility for legacy events
  const draftEventsCount = canToggleDrafts ? events.filter(event => {
    const isDraft = event.event_state === 'draft' || (!event.event_state && event.status === 'draft');
    if (!isDraft) return false;
    
    const matchesSearch =
      event.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      event.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      event.location?.toLowerCase().includes(searchQuery.toLowerCase());
    
    let matchesFilterTag = true;
    if (selectedFilterTags.length > 0 && categoriesLoaded) {
      const rawEventTags = event.filter_tags || [];
      const normalizedEventTags = normalizeFilterTags(rawEventTags, eventCategories);
      matchesFilterTag = selectedFilterTags.some(tag => normalizedEventTags.includes(tag));
    }
    
    let matchesEventType = true;
    if (selectedEventType !== "all") {
      matchesEventType = parseEventTypes(event.event_type).includes(selectedEventType);
    }
    
    let matchesDeliveryMode = true;
    if (selectedDeliveryMode !== "all") {
      const eventIsOnline = event.is_online === true;
      if (selectedDeliveryMode === "online") {
        matchesDeliveryMode = eventIsOnline;
      } else if (selectedDeliveryMode === "offline") {
        matchesDeliveryMode = !eventIsOnline;
      }
    }
    
    return matchesSearch && matchesFilterTag && matchesEventType && matchesDeliveryMode;
  }).length : 0;

  // Update member tour status via base44 client
  const updateMemberTourStatus = async (tourKey) => {
    if (!memberInfo || memberInfo.is_team_member) {
      return;
    }

    if (!memberInfo.id) {
      return;
    }

    try {
      const updatedTours = {
        ...(memberInfo.page_tours_seen || {}),
        [tourKey]: true,
      };

      await base44.entities.Member.update(memberInfo.id, { page_tours_seen: updatedTours });

      const updatedMemberInfo = { ...memberInfo, page_tours_seen: updatedTours };
      localStorage.setItem("agcas_member", JSON.stringify(updatedMemberInfo));

      // Notify Layout to reload memberInfo
      if (typeof reloadMemberInfo === "function") {
        reloadMemberInfo();
      }
    } catch (error) {
      console.error("[Events] Exception updating tour status:", error);
    }
  };

  const handleTourComplete = async () => {
    setShowTour(false);
    setTourAutoShow(false);
  };

  const handleTourDismiss = async () => {
    setShowTour(false);
    setTourAutoShow(false);
    await updateMemberTourStatus("Events");
  };

  const handleStartTour = () => {
    // First reset the states
    setShowTour(false);
    setTourAutoShow(false);

    // Then set them to true after a brief delay to ensure PageTour remounts
    setTimeout(() => {
      setShowTour(true);
      setTourAutoShow(true);
    }, 10);
  };

  const showComplexAttendeesModal = !!complexAttendeesEvent;

  const { data: complexBookingsData, isLoading: complexBookingsLoading } = useQuery({
    queryKey: ['event-bookings', complexAttendeesEvent?.id],
    queryFn: async () => {
      return await base44.entities.Booking.filter({ event_id: complexAttendeesEvent.id });
    },
    enabled: showComplexAttendeesModal && isAdmin,
  });

  const { data: complexOrganizationsData } = useQuery({
    queryKey: ['organizations-for-attendees'],
    queryFn: async () => {
      return await base44.entities.Organization.listAll();
    },
    enabled: showComplexAttendeesModal && isAdmin,
  });

  const { data: complexMembersData } = useQuery({
    queryKey: ['members-for-attendees'],
    queryFn: async () => {
      return await base44.entities.Member.listAll();
    },
    enabled: showComplexAttendeesModal && isAdmin,
  });

  const complexOrgMap = useMemo(() => {
    if (!complexOrganizationsData) return {};
    return complexOrganizationsData.reduce((acc, org) => {
      acc[org.id] = org.name;
      return acc;
    }, {});
  }, [complexOrganizationsData]);

  const complexMemberJobTitleMap = useMemo(() => {
    if (!complexMembersData) return {};
    return complexMembersData.reduce((acc, member) => {
      acc[member.id] = member.job_title || '';
      return acc;
    }, {});
  }, [complexMembersData]);

  const complexActiveBookings = useMemo(() => {
    if (!complexBookingsData) return [];
    return complexBookingsData.filter(b => b.status !== 'cancelled');
  }, [complexBookingsData]);

  const complexUniqueOrganizations = useMemo(() => {
    if (!complexActiveBookings || complexActiveBookings.length === 0) return [];
    const orgIds = [...new Set(complexActiveBookings.map(b => b.organization_id).filter(Boolean))];
    const orgs = orgIds.map(id => ({
      id,
      name: complexOrgMap[id] || 'Unknown Organization'
    })).sort((a, b) => a.name.localeCompare(b.name));
    const hasNonMemberBookings = complexActiveBookings.some(b => !b.organization_id);
    if (hasNonMemberBookings) {
      orgs.push({ id: 'non-member', name: 'Non-member' });
    }
    return orgs;
  }, [complexActiveBookings, complexOrgMap]);

  const complexFilteredAttendees = useMemo(() => {
    if (!complexActiveBookings) return [];
    return complexActiveBookings
      .filter(booking => {
        if (complexAttendeesOrgFilter !== "all") {
          if (complexAttendeesOrgFilter === "non-member") {
            if (booking.organization_id) return false;
          } else if (booking.organization_id !== complexAttendeesOrgFilter) {
            return false;
          }
        }
        if (complexAttendeesSearch) {
          const search = complexAttendeesSearch.toLowerCase();
          const name = `${booking.attendee_first_name || ''} ${booking.attendee_last_name || ''}`.toLowerCase();
          const email = (booking.attendee_email || '').toLowerCase();
          const org = booking.organization_id ? (complexOrgMap[booking.organization_id] || '').toLowerCase() : 'non-member';
          return name.includes(search) || email.includes(search) || org.includes(search);
        }
        return true;
      })
      .sort((a, b) => {
        const nameA = `${a.attendee_first_name || ''} ${a.attendee_last_name || ''}`;
        const nameB = `${b.attendee_first_name || ''} ${b.attendee_last_name || ''}`;
        return nameA.localeCompare(nameB);
      });
  }, [complexActiveBookings, complexAttendeesOrgFilter, complexAttendeesSearch, complexOrgMap]);

  const complexTotalPages = Math.ceil(complexFilteredAttendees.length / complexAttendeesPerPage);
  const complexStartIndex = (complexAttendeesPage - 1) * complexAttendeesPerPage;
  const complexEndIndex = complexStartIndex + complexAttendeesPerPage;
  const complexPaginatedAttendees = complexFilteredAttendees.slice(complexStartIndex, complexEndIndex);

  const getComplexPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;
    if (complexTotalPages <= maxVisible) {
      for (let i = 1; i <= complexTotalPages; i++) pages.push(i);
    } else {
      if (complexAttendeesPage <= 3) {
        for (let i = 1; i <= 4; i++) pages.push(i);
        pages.push('...');
        pages.push(complexTotalPages);
      } else if (complexAttendeesPage >= complexTotalPages - 2) {
        pages.push(1);
        pages.push('...');
        for (let i = complexTotalPages - 3; i <= complexTotalPages; i++) pages.push(i);
      } else {
        pages.push(1);
        pages.push('...');
        for (let i = complexAttendeesPage - 1; i <= complexAttendeesPage + 1; i++) pages.push(i);
        pages.push('...');
        pages.push(complexTotalPages);
      }
    }
    return pages;
  };

  useEffect(() => {
    setComplexAttendeesPage(1);
  }, [complexAttendeesOrgFilter, complexAttendeesSearch]);

  const complexExportToCSV = () => {
    if (!complexFilteredAttendees.length) {
      toast.error('No attendees to export');
      return;
    }
    const headers = ['Name', 'Job Title', 'Organisation', 'Email'];
    const rows = complexFilteredAttendees.map(booking => [
      `${booking.attendee_first_name || ''} ${booking.attendee_last_name || ''}`.trim(),
      booking.member_id ? (complexMemberJobTitleMap[booking.member_id] || '') : '',
      booking.organization_id ? (complexOrgMap[booking.organization_id] || '') : 'Non-member',
      booking.attendee_email || ''
    ]);
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${(cell || '').replace(/"/g, '""')}"`).join(','))
    ].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `attendees-${(complexAttendeesEvent?.title || 'event').replace(/[^a-z0-9]/gi, '-')}-${format(new Date(), 'yyyy-MM-dd')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast.success('Attendees exported to CSV');
  };

  const complexImportAttendeesMutation = useMutation({
    mutationFn: async ({ payload, clientParseErrors: _ }) => {
      const response = await fetch(`/api/admin/events/${complexAttendeesEvent.id}/attendees/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Import failed');
      }
      return response.json();
    },
    onSuccess: (data, variables) => {
      const merged = { ...(data.results || {}) };
      const clientErrors = (variables?.clientParseErrors || []).map(e => ({
        row: e.row,
        email: e.email || null,
        error: e.reason,
      }));
      merged.errors = [...clientErrors, ...(merged.errors || [])];
      setComplexImportResults(merged);
      queryClient.invalidateQueries({ queryKey: ['event-bookings', complexAttendeesEvent?.id] });
      const memberCount = merged.registeredMembers?.length || 0;
      const guestCount = merged.registeredGuests?.length || 0;
      const total = memberCount + guestCount;
      if (total > 0) {
        toast.success(`Successfully registered ${total} attendee(s) (${memberCount} member${memberCount === 1 ? '' : 's'}, ${guestCount} guest${guestCount === 1 ? '' : 's'})`);
      }
      if (merged.errors.length > 0) {
        toast.error(`${merged.errors.length} row(s) could not be imported`);
      }
    },
    onError: (error) => {
      console.error('Import attendees error:', error);
      toast.error('Failed to import attendees: ' + (error.message || 'Unknown error'));
    }
  });

  const loadComplexImportTicketClasses = async (event) => {
    if (!event) {
      setComplexImportTicketClasses([]);
      return;
    }
    try {
      if (event.is_complex) {
        const tcs = await base44.entities.ComplexEventTicketClass.filter({ complex_event_id: event.id });
        setComplexImportTicketClasses(Array.isArray(tcs) ? tcs : []);
      } else {
        let pricingConfig = event.pricing_config;
        if (typeof pricingConfig === 'string') {
          try { pricingConfig = JSON.parse(pricingConfig); } catch { pricingConfig = null; }
        }
        const tcs = pricingConfig?.ticket_classes;
        setComplexImportTicketClasses(Array.isArray(tcs) ? tcs : []);
      }
    } catch (e) {
      console.error('Failed to load ticket classes for import:', e);
      setComplexImportTicketClasses([]);
    }
  };

  const handleComplexImportClick = () => {
    setComplexImportResults(null);
    setComplexImportEmailsText("");
    setComplexImportTicketClassId("");
    setComplexImportSendConfirmations(true);
    setComplexImportTicketClasses([]);
    if (complexAttendeesEvent) {
      loadComplexImportTicketClasses(complexAttendeesEvent);
    }
    setShowComplexImportDialog(true);
  };

  const [complexResendingBookingId, setComplexResendingBookingId] = useState(null);

  const complexResendConfirmationMutation = useMutation({
    mutationFn: async (bookingId) => {
      const response = await fetch(`/api/admin/events/${complexAttendeesEvent.id}/attendees/resend-confirmation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ bookingId })
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to resend confirmation email');
      }
      return response.json();
    },
    onMutate: (bookingId) => {
      setComplexResendingBookingId(bookingId);
    },
    onSuccess: (data) => {
      toast.success(`Confirmation email resent to ${data.email}`);
    },
    onError: (error) => {
      console.error('Resend confirmation error:', error);
      toast.error(error.message || 'Failed to resend confirmation email');
    },
    onSettled: () => {
      setComplexResendingBookingId(null);
    }
  });

  const parseComplexImportCsv = (text) => {
    const trimmed = (text || '').replace(/\r\n/g, '\n').trim();
    if (!trimmed) return { rows: [], errors: [] };

    const splitCsvLine = (line) => {
      const out = [];
      let cur = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
          if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (ch === '"') { inQuotes = false; }
          else { cur += ch; }
        } else {
          if (ch === '"') { inQuotes = true; }
          else if (ch === ',') { out.push(cur); cur = ''; }
          else { cur += ch; }
        }
      }
      out.push(cur);
      return out.map(s => s.trim());
    };

    const lines = trimmed.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const expectedHeaders = ['first_name', 'last_name', 'email', 'organization', 'job_title'];
    let columnOrder = expectedHeaders;
    let startIndex = 0;

    const firstFields = splitCsvLine(lines[0]).map(s => s.toLowerCase());
    const looksLikeHeader = firstFields.some(f => expectedHeaders.includes(f));
    if (looksLikeHeader) {
      columnOrder = firstFields.map(f => expectedHeaders.includes(f) ? f : null);
      startIndex = 1;
    }

    const emailIndex = columnOrder.indexOf('email');
    const rows = [];
    const errors = [];
    for (let i = startIndex; i < lines.length; i++) {
      const rowNumber = i + 1;
      const fields = splitCsvLine(lines[i]);
      if (fields.length === 0 || fields.every(f => f === '')) continue;

      // Single-column rows (no commas) are treated as just an email.
      let row;
      if (fields.length === 1 && !looksLikeHeader) {
        row = { email: fields[0] };
      } else {
        row = {};
        columnOrder.forEach((key, idx) => {
          if (key) row[key] = fields[idx] || '';
        });
        if (emailIndex === -1 && fields[2]) {
          row.email = fields[2];
        }
      }

      const email = (row.email || '').trim();
      if (!email) {
        errors.push({ row: rowNumber, reason: 'Missing email' });
        continue;
      }
      if (!email.includes('@')) {
        errors.push({ row: rowNumber, reason: 'Invalid email', email });
        continue;
      }
      rows.push({
        first_name: (row.first_name || '').trim(),
        last_name: (row.last_name || '').trim(),
        email: email.trim().toLowerCase(),
        organization: (row.organization || '').trim(),
        job_title: (row.job_title || '').trim(),
      });
    }

    return { rows, errors };
  };

  const handleComplexImportSubmit = () => {
    const { rows, errors } = parseComplexImportCsv(complexImportEmailsText);

    if (rows.length === 0) {
      if (errors.length === 0) {
        toast.error('Please paste at least one row with a valid email address.');
        return;
      }
      // Surface parse errors directly without an API call so the user can see
      // exactly which rows were rejected and why.
      setComplexImportResults({
        registered: [],
        registeredMembers: [],
        registeredGuests: [],
        alreadyRegistered: [],
        warnings: [],
        errors: errors.map(e => ({ row: e.row, email: e.email || null, error: e.reason })),
        emailsSent: [],
        emailsFailed: [],
        sendConfirmations: complexImportSendConfirmations,
      });
      toast.error(`${errors.length} row(s) could not be parsed`);
      return;
    }

    complexImportAttendeesMutation.mutate({
      payload: {
        rows,
        ticket_class_id: complexImportTicketClassId || undefined,
        send_confirmations: complexImportSendConfirmations,
      },
      clientParseErrors: errors,
    });
  };

  const handleComplexAttendeesClick = (e, event) => {
    e.stopPropagation();
    setComplexAttendeesEvent(event);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      {showTour && shouldShowTours && (
        <PageTour
          tourGroupName="Events"
          viewId={null}
          onComplete={handleTourComplete}
          onDismissPermanently={handleTourDismiss}
          autoShow={tourAutoShow}
        />
      )}

      <div className="max-w-7xl mx-auto">
        {/* Header - hidden when custom banner is present */}
        {!hasBanner && (
          <div className="mb-8">
            <div className="flex items-center justify-between mb-2">
              <h1 className="text-3xl md:text-4xl font-bold text-slate-900">
                Events
              </h1>
              <div className="flex items-center gap-2">
                {shouldShowTours && typeof handleStartTour === "function" && (
                  <TourButton onClick={handleStartTour} />
                )}
              </div>
            </div>
          </div>
        )}

        {/* Search and Filters */}
        {!resolvedIsFeatureExcluded('events.browse-events.search-filters') && (
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-8">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
                <Input
                  placeholder="Search events by name, description or location..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
            
            {/* Filter Dropdowns Row */}
            <div className="flex flex-wrap gap-2 mt-4">
                {/* Filter Tags - Multi-select with grouped subcategories */}
                {eventCategories.length > 0 && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button 
                        variant="outline" 
                        className="w-full md:w-auto justify-between gap-2"
                        data-testid="filter-tags-trigger"
                      >
                        <div className="flex items-center gap-2">
                          <Tag className="w-4 h-4" />
                          {selectedFilterTags.length === 0 ? (
                            <span>Filter by category</span>
                          ) : selectedFilterTags.length === 1 ? (
                            <span className="truncate max-w-[200px]">{parseFilterTagKey(selectedFilterTags[0]).label}</span>
                          ) : (
                            <span>{selectedFilterTags.length} selected</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          {selectedFilterTags.length > 0 && (
                            <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                              {selectedFilterTags.length}
                            </Badge>
                          )}
                          <ChevronDown className="w-4 h-4 opacity-50" />
                        </div>
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-72 p-0" align="start">
                      <div className="p-2 border-b border-slate-100">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-slate-700">Filter by category</span>
                          {selectedFilterTags.length > 0 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs text-slate-500 hover:text-slate-700"
                              onClick={() => clearFilterTags()}
                              data-testid="filter-tags-clear"
                            >
                              Clear all
                            </Button>
                          )}
                        </div>
                      </div>
                      <div className="max-h-[320px] overflow-y-auto p-1">
                        {eventCategories.map((category) => (
                          <div key={category.id} className="mb-2">
                            <div className="px-2 py-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                              {category.name}
                            </div>
                            {category.subcategories.map((subcategory) => {
                              const tagKey = createFilterTagKey(category.id, subcategory);
                              const isSelected = selectedFilterTags.includes(tagKey);
                              return (
                                <button
                                  key={tagKey}
                                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors ${
                                    isSelected 
                                      ? "bg-slate-100 text-slate-900 font-medium" 
                                      : "text-slate-600 hover:bg-slate-50"
                                  }`}
                                  onClick={() => setFilterTagSelected(tagKey, !isSelected)}
                                  data-testid={`filter-tag-${subcategory}`}
                                >
                                  <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                                    isSelected ? "bg-primary border-primary" : "border-slate-300"
                                  }`}>
                                    {isSelected && <Check className="w-3 h-3 text-white" />}
                                  </div>
                                  <span className="truncate">{subcategory}</span>
                                </button>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                )}
                
                {/* Event Type Filter */}
                {eventTypes.length > 0 && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button 
                        variant="outline" 
                        className="w-full md:w-auto justify-between gap-2"
                        data-testid="filter-event-type-trigger"
                      >
                        <div className="flex items-center gap-2">
                          <Layers className="w-4 h-4" />
                          {selectedEventType === "all" ? (
                            <span>Filter by type</span>
                          ) : (
                            <span className="truncate max-w-[200px]">{selectedEventType}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          {selectedEventType !== "all" && (
                            <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                              1
                            </Badge>
                          )}
                          <ChevronDown className="w-4 h-4 opacity-50" />
                        </div>
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-64 p-0" align="start">
                      <div className="p-2 border-b border-slate-100">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-slate-700">Filter by type</span>
                          {selectedEventType !== "all" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs text-slate-500 hover:text-slate-700"
                              onClick={() => setSelectedEventType("all")}
                              data-testid="filter-event-type-clear"
                            >
                              Clear
                            </Button>
                          )}
                        </div>
                      </div>
                      <div className="max-h-[280px] overflow-y-auto p-1">
                        <button
                          className={`w-full flex items-center gap-2 px-2 py-2 text-sm rounded-md transition-colors ${
                            selectedEventType === "all" 
                              ? "bg-slate-100 text-slate-900 font-medium" 
                              : "text-slate-600 hover:bg-slate-50"
                          }`}
                          onClick={() => setSelectedEventType("all")}
                          data-testid="filter-event-type-all"
                        >
                          <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                            selectedEventType === "all" ? "bg-primary border-primary" : "border-slate-300"
                          }`}>
                            {selectedEventType === "all" && <Check className="w-3 h-3 text-white" />}
                          </div>
                          All types
                        </button>
                        {eventTypes.map((type) => {
                          const typeName = typeof type === 'object' ? type.name : type;
                          const typeKey = typeName || 'unknown';
                          const isSelected = selectedEventType === typeName;
                          return (
                            <button
                              key={typeKey}
                              className={`w-full flex items-center gap-2 px-2 py-2 text-sm rounded-md transition-colors ${
                                isSelected 
                                  ? "bg-slate-100 text-slate-900 font-medium" 
                                  : "text-slate-600 hover:bg-slate-50"
                              }`}
                              onClick={() => setSelectedEventType(typeName)}
                              data-testid={`filter-event-type-${typeKey}`}
                            >
                              <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                                isSelected ? "bg-primary border-primary" : "border-slate-300"
                              }`}>
                                {isSelected && <Check className="w-3 h-3 text-white" />}
                              </div>
                              <span className="truncate">{typeName}</span>
                            </button>
                          );
                        })}
                      </div>
                    </PopoverContent>
                  </Popover>
                )}
                
                {/* Delivery Mode Filter */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button 
                      variant="outline" 
                      className="w-full md:w-auto justify-between gap-2"
                      data-testid="filter-delivery-mode-trigger"
                    >
                      <div className="flex items-center gap-2">
                        <MapPin className="w-4 h-4" />
                        {selectedDeliveryMode === "all" ? (
                          <span>Delivery</span>
                        ) : selectedDeliveryMode === "online" ? (
                          <span>Online</span>
                        ) : (
                          <span>In person</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        {selectedDeliveryMode !== "all" && (
                          <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                            1
                          </Badge>
                        )}
                        <ChevronDown className="w-4 h-4 opacity-50" />
                      </div>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-48 p-0" align="start">
                    <div className="p-2 border-b border-slate-100">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-slate-700">Delivery</span>
                        {selectedDeliveryMode !== "all" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs text-slate-500 hover:text-slate-700"
                            onClick={() => setSelectedDeliveryMode("all")}
                            data-testid="filter-delivery-mode-clear"
                          >
                            Clear
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="p-1">
                      <button
                        className={`w-full flex items-center gap-2 px-2 py-2 text-sm rounded-md transition-colors ${
                          selectedDeliveryMode === "all" 
                            ? "bg-slate-100 text-slate-900 font-medium" 
                            : "text-slate-600 hover:bg-slate-50"
                        }`}
                        onClick={() => setSelectedDeliveryMode("all")}
                        data-testid="filter-delivery-mode-all"
                      >
                        <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                          selectedDeliveryMode === "all" ? "bg-primary border-primary" : "border-slate-300"
                        }`}>
                          {selectedDeliveryMode === "all" && <Check className="w-3 h-3 text-white" />}
                        </div>
                        All
                      </button>
                      <button
                        className={`w-full flex items-center gap-2 px-2 py-2 text-sm rounded-md transition-colors ${
                          selectedDeliveryMode === "online" 
                            ? "bg-slate-100 text-slate-900 font-medium" 
                            : "text-slate-600 hover:bg-slate-50"
                        }`}
                        onClick={() => setSelectedDeliveryMode("online")}
                        data-testid="filter-delivery-mode-online"
                      >
                        <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                          selectedDeliveryMode === "online" ? "bg-primary border-primary" : "border-slate-300"
                        }`}>
                          {selectedDeliveryMode === "online" && <Check className="w-3 h-3 text-white" />}
                        </div>
                        Online
                      </button>
                      <button
                        className={`w-full flex items-center gap-2 px-2 py-2 text-sm rounded-md transition-colors ${
                          selectedDeliveryMode === "offline" 
                            ? "bg-slate-100 text-slate-900 font-medium" 
                            : "text-slate-600 hover:bg-slate-50"
                        }`}
                        onClick={() => setSelectedDeliveryMode("offline")}
                        data-testid="filter-delivery-mode-in-person"
                      >
                        <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                          selectedDeliveryMode === "offline" ? "bg-primary border-primary" : "border-slate-300"
                        }`}>
                          {selectedDeliveryMode === "offline" && <Check className="w-3 h-3 text-white" />}
                        </div>
                        In person
                      </button>
                    </div>
                  </PopoverContent>
                </Popover>

                <Popover>
                  <PopoverTrigger asChild>
                    <Button 
                      variant="outline" 
                      className="w-full md:w-auto justify-between gap-2"
                      data-testid="sort-by-trigger"
                    >
                      <div className="flex items-center gap-2">
                        <ArrowUpDown className="w-4 h-4" />
                        {sortBy === "date" ? (
                          <span>Sort: Date</span>
                        ) : sortBy === "price_asc" ? (
                          <span>Sort: Price Low to High</span>
                        ) : (
                          <span>Sort: Price High to Low</span>
                        )}
                      </div>
                      <ChevronDown className="w-4 h-4 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-52 p-0" align="start">
                    <div className="p-2 border-b border-slate-100">
                      <span className="text-sm font-medium text-slate-700">Sort by</span>
                    </div>
                    <div className="p-1">
                      {[
                        { value: "date", label: "Date (default)" },
                        { value: "price_asc", label: "Price: Low to High" },
                        { value: "price_desc", label: "Price: High to Low" },
                      ].map((option) => (
                        <button
                          key={option.value}
                          className={`w-full flex items-center gap-2 px-2 py-2 text-sm rounded-md transition-colors ${
                            sortBy === option.value
                              ? "bg-slate-100 text-slate-900 font-medium" 
                              : "text-slate-600 hover:bg-slate-50"
                          }`}
                          onClick={() => setSortBy(option.value)}
                          data-testid={`sort-by-${option.value}`}
                        >
                          <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                            sortBy === option.value ? "bg-primary border-primary" : "border-slate-300"
                          }`}>
                            {sortBy === option.value && <Check className="w-3 h-3 text-white" />}
                          </div>
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>

                {memberInfo && !resolvedIsFeatureExcluded('events.browse-events.create') && (
                  <Button
                    onClick={() => setShowCreateEventModal(true)}
                    className="bg-blue-600 hover:bg-blue-700 ml-auto"
                    data-testid="button-create-event"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Create Event
                  </Button>
                )}
              </div>
            
            {/* Toggle Row for Past Events and Drafts */}
            {(pastEventsCount > 0 || canToggleDrafts) && (
              <div className="flex flex-wrap items-center gap-6 mt-4 pt-4 border-t border-slate-200">
                {/* Show Past Events Toggle */}
                {pastEventsCount > 0 && (
                  <div className="flex items-center gap-3">
                    <Switch
                      id="show-past-events"
                      checked={showPastEvents}
                      onCheckedChange={setShowPastEvents}
                      data-testid="switch-show-past-events"
                    />
                    <Label 
                      htmlFor="show-past-events" 
                      className="text-sm text-slate-600 cursor-pointer flex items-center gap-2"
                    >
                      <History className="w-4 h-4" />
                      Show past events ({pastEventsCount})
                    </Label>
                  </div>
                )}
                
                {/* Show Drafts Toggle - always visible to users with toggle-drafts permission */}
                {canToggleDrafts && (
                  <div className="flex items-center gap-3">
                    <Switch
                      id="show-draft-events"
                      checked={showDraftEvents}
                      onCheckedChange={setShowDraftEvents}
                      data-testid="switch-show-draft-events"
                    />
                    <Label 
                      htmlFor="show-draft-events" 
                      className="text-sm text-slate-600 cursor-pointer flex items-center gap-2"
                    >
                      <FileEdit className="w-4 h-4" />
                      Show drafts{draftEventsCount > 0 ? ` (${draftEventsCount})` : ''}
                    </Label>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Events Display */}
        {isLoading ? (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
            {Array(6)
              .fill(0)
              .map((_, i) => (
                <Card key={i} className="animate-pulse">
                  <div className="h-48 bg-slate-200" />
                  <CardContent className="p-6">
                    <div className="h-4 bg-slate-200 rounded mb-2" />
                    <div className="h-4 bg-slate-200 rounded w-2/3" />
                  </CardContent>
                </Card>
              ))}
          </div>
        ) : eventsError ? (
          <div className="text-center py-16">
            <Calendar className="w-16 h-16 text-red-300 mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-red-700 mb-2">
              Error loading events
            </h3>
            <p className="text-slate-600">
              Please check your Supabase connection and event table.
            </p>
          </div>
        ) : (
          <>
            {filteredEvents.length === 0 ? (
              <div className="text-center py-16">
                <Calendar className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                <h3 className="text-xl font-semibold text-slate-900 mb-2">
                  No events found
                </h3>
                <p className="text-slate-600">
                  Try adjusting your search or filters
                </p>
              </div>
            ) : (
              <>
              {featuredEvents.length > 0 && (
                <div className="mb-6 rounded-lg p-4 -mx-[10px]" style={featuredBgStyle} data-testid="card-featured-events">
                  <div className="flex items-center gap-2 mb-4">
                    <Star className="h-5 w-5 text-warning" />
                    <h2 className="text-lg font-semibold">Featured Events</h2>
                  </div>
                  <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
                    {featuredEvents.map((event) => {
                      if (event.is_complex) {
                        const eventTimezone = event.timezone || DEFAULT_TIMEZONE;
                        const detailUrl = event.slug
                          ? `/session-events/${event.slug}`
                          : `/ComplexEventDetail?id=${event.id}`;
                        const hasUnlimitedCapacity = event.available_seats === 0 || event.available_seats === null;
                        const isEventPast = isEventInPast(event);
                        const isRegistrationClosed = event.event_state === 'closed' || 
                          (!event.event_state && event.status === 'closed') ||
                          (event.registration_closes_at && new Date() > new Date(event.registration_closes_at));
                        const cheapest = event.cheapest_price ?? (() => {
                          const tcs = event.pricing_config?.ticket_classes;
                          if (!tcs?.length) return null;
                          const prices = tcs.map(tc => Number(tc.price)).filter(p => Number.isFinite(p));
                          return prices.length > 0 ? Math.min(...prices) : null;
                        })();
                        const showPricesSetting = Array.isArray(systemSettings) 
                          ? systemSettings.find(s => s.setting_key === 'show_event_card_prices')
                          : null;
                        const showPricesOnCard = showPricesSetting?.setting_value === 'true';
                        const eventParsedTypes = parseEventTypes(event.event_type);
                        const hasBadges = event.status === 'draft' || event.status === 'tbc' || isEventPast || eventParsedTypes.length > 0 || isRegistrationClosed;
                        const descriptionText = event.summary || stripHtmlTags(event.description);

                        return (
                          <Card
                            key={`featured-complex-${event.id}`}
                            className="overflow-hidden hover:shadow-lg transition-shadow duration-300 border-slate-200 bg-white"
                            data-testid={`card-featured-event-${event.id}`}
                          >
                            <div className="relative">
                              {event.image_url ? (
                                <div className="h-48 overflow-hidden bg-slate-100">
                                  <img
                                    src={event.image_url}
                                    alt={event.title}
                                    className="w-full h-full object-cover hover:scale-105 transition-transform duration-300"
                                    style={getFocalPointStyle(event.image_focal_point)}
                                  />
                                </div>
                              ) : (
                                <div className={`h-24 ${isEventPast ? 'bg-gradient-to-r from-slate-100 to-slate-50' : 'bg-gradient-to-r from-slate-50 to-blue-50'}`} />
                              )}
                              {hasBadges && (
                                <div className="absolute top-2 left-2 flex flex-wrap items-center gap-1.5 max-w-[calc(100%-1rem)]">
                                  {event.status === 'draft' && (
                                    <Badge variant="warning" className="shadow-sm">Draft</Badge>
                                  )}
                                  {event.status === 'tbc' && (
                                    <Badge variant="secondary" className="bg-blue-100/95 text-blue-700 border-blue-200 shadow-sm">TBC</Badge>
                                  )}
                                  {isRegistrationClosed && (
                                    <Badge variant="secondary" className="bg-red-100/95 text-red-700 border-red-200 shadow-sm" data-testid={`badge-closed-event-${event.id}`}>Registration Closed</Badge>
                                  )}
                                  {isEventPast && (
                                    <Badge variant="secondary" className="bg-slate-200/95 text-slate-600 border-slate-300 shadow-sm">Past Event</Badge>
                                  )}
                                  {eventParsedTypes.map((typeName, etIdx) => {
                                    const eventTypeStyle = getEventTypeStyle(typeName, systemSettings);
                                    return (
                                      <Badge key={etIdx} variant="secondary" className="border-0 shadow-sm" style={{ backgroundColor: `${eventTypeStyle.bgColor}f2`, color: eventTypeStyle.textColor }}>
                                        {typeName}
                                      </Badge>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                            <CardHeader className="pb-3">
                              <h3 className="font-bold text-lg text-slate-900 line-clamp-2">{event.title}</h3>
                              {descriptionText && (
                                <p className="text-sm text-slate-600 mt-2 line-clamp-2" data-testid="text-event-summary">{descriptionText}</p>
                              )}
                            </CardHeader>
                            <CardContent className="space-y-3">
                              {event.status === 'tbc' ? (
                                <div className="flex items-center gap-2 text-sm text-blue-600">
                                  <Calendar className="w-4 h-4 text-blue-400" />
                                  <span className="font-medium">Date to be confirmed</span>
                                </div>
                              ) : event.start_date && (
                                <div className="flex items-center gap-2 text-sm text-slate-600">
                                  <Calendar className="w-4 h-4 text-slate-400 shrink-0" />
                                  <span>
                                    {formatInTimeZone(parseISO(event.start_date), eventTimezone, "MMM d, yyyy")}
                                    {event.end_date && ` - ${formatInTimeZone(parseISO(event.end_date), eventTimezone, "MMM d, yyyy")}`}
                                  </span>
                                </div>
                              )}
                              {(event.track_count > 0 || event.session_count > 0) && (
                                <div className="flex items-center gap-4 text-sm text-slate-600">
                                  {event.session_count > 0 && (
                                    <div className="flex items-center gap-1.5" data-testid={`text-session-count-${event.id}`}>
                                      <List className="w-4 h-4 text-slate-400 shrink-0" />
                                      <span>{event.session_count} {event.session_count === 1 ? 'Session' : 'Sessions'}</span>
                                    </div>
                                  )}
                                  {event.track_count > 0 && (
                                    <div className="flex items-center gap-1.5" data-testid={`text-track-count-${event.id}`}>
                                      <Layers className="w-4 h-4 text-slate-400 shrink-0" />
                                      <span>{event.track_count} {event.track_count === 1 ? 'Track' : 'Tracks'}</span>
                                    </div>
                                  )}
                                </div>
                              )}
                              {event.location && (
                                <div className="flex items-center gap-2 text-sm text-slate-600">
                                  <MapPin className="w-4 h-4 text-slate-400 shrink-0" />
                                  <span className="line-clamp-1">{event.location}</span>
                                </div>
                              )}
                              {event.show_seat_count !== false && (
                                <div className="flex items-center gap-2 text-sm">
                                  <Users className="w-4 h-4 text-slate-400 shrink-0" />
                                  {hasUnlimitedCapacity ? (
                                    <span className="text-green-600 font-medium">Open Registration</span>
                                  ) : event.available_seats > 0 ? (
                                    <span className="text-green-600 font-medium">{event.available_seats} seats available</span>
                                  ) : (
                                    <span className="text-red-600 font-medium">Sold out</span>
                                  )}
                                </div>
                              )}
                              {showPricesOnCard && cheapest !== null && (
                                <div className="flex items-center gap-2 text-sm" data-testid={`text-ticket-price-${event.id}`}>
                                  <Ticket className="w-4 h-4 text-slate-400 shrink-0" />
                                  {cheapest === 0 ? (
                                    <span className="text-green-600 font-medium">Free to register</span>
                                  ) : (
                                    <span className="text-slate-600">
                                      Price from <span className="font-semibold text-slate-800">{`\u00a3${cheapest.toFixed(2)}`}</span>
                                    </span>
                                  )}
                                </div>
                              )}
                              <div className="pt-3 border-t border-slate-100">
                                {memberInfo && (!resolvedIsFeatureExcluded?.('events.browse-events.create') || !resolvedIsFeatureExcluded?.('events.browse-events.view-attendees')) && (
                                  <div className="flex items-center gap-2 mb-3">
                                    {!resolvedIsFeatureExcluded?.('events.browse-events.create') && (
                                      <Button 
                                        variant="outline" 
                                        size="sm"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          window.location.href = createPageUrl("CreateComplexEvent") + "?id=" + event.id;
                                        }}
                                        className="flex-1"
                                        data-testid={`button-edit-event-${event.id}`}
                                      >
                                        <Pencil className="w-4 h-4 mr-1" />
                                        Edit
                                      </Button>
                                    )}
                                    {!resolvedIsFeatureExcluded?.('events.browse-events.view-attendees') && (
                                      <Button 
                                        variant="outline" 
                                        size="sm"
                                        onClick={(e) => handleComplexAttendeesClick(e, event)}
                                        className="flex-1 text-purple-600 hover:text-purple-700 hover:bg-purple-50 border-purple-200"
                                        data-testid={`button-attendees-event-${event.id}`}
                                      >
                                        <UsersRound className="w-4 h-4 mr-1" />
                                        Attendees
                                      </Button>
                                    )}
                                    {!resolvedIsFeatureExcluded?.('events.browse-events.create') && (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={async (e) => {
                                          e.stopPropagation();
                                          try {
                                            const resp = await fetch(`/api/complex-events/${event.id}/duplicate`, {
                                              method: 'POST',
                                              credentials: 'include',
                                              headers: { 'Content-Type': 'application/json' },
                                            });
                                            if (!resp.ok) {
                                              const err = await resp.json().catch(() => ({}));
                                              throw new Error(err.error || 'Duplicate failed');
                                            }
                                            const data = await resp.json();
                                            toast.success('Complex event duplicated as draft');
                                            queryClient.invalidateQueries({ queryKey: ['complex-events'] });
                                            window.location.href = createPageUrl('CreateComplexEvent') + '?id=' + data.id;
                                          } catch (err) {
                                            toast.error('Duplicate failed: ' + err.message);
                                          }
                                        }}
                                        className="flex-1"
                                        data-testid={`button-duplicate-complex-event-${event.id}`}
                                      >
                                        <Copy className="w-4 h-4 mr-1" />
                                        Duplicate
                                      </Button>
                                    )}
                                    {!resolvedIsFeatureExcluded?.('events.browse-events.create') && (
                                      <Button 
                                        variant="outline" 
                                        size="sm"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setComplexDeleteTarget(event);
                                        }}
                                        className="flex-1 text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
                                        data-testid={`button-delete-event-${event.id}`}
                                      >
                                        <Trash2 className="w-4 h-4 mr-1" />
                                        Delete
                                      </Button>
                                    )}
                                  </div>
                                )}
                                {!resolvedIsFeatureExcluded?.('events.event-details') && (
                                  <>
                                    {isEventPast ? (
                                      <Button className="w-full" variant="secondary" disabled data-testid={`button-event-ended-${event.id}`}>
                                        Event Ended
                                      </Button>
                                    ) : (() => {
                                      const ctaConfig = getCtaButtonConfig(systemSettings);
                                      const isSoldOut = !hasUnlimitedCapacity && event.available_seats === 0;
                                      const buttonLabel = isRegistrationClosed ? "Registration Closed" : (isSoldOut ? "Sold Out" : ctaConfig.label);
                                      const isGradient = ctaConfig.style === 'gradient';
                                      return (
                                        <Link to={detailUrl}>
                                          <Button 
                                            variant={isRegistrationClosed ? "secondary" : "default"}
                                            className={`w-full ${!isRegistrationClosed && isGradient 
                                              ? 'bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 text-white shadow-lg' 
                                              : !isRegistrationClosed ? 'bg-blue-600' : ''}`}
                                            disabled={isSoldOut}
                                            data-testid={`button-register-event-${event.id}`}
                                          >
                                            {buttonLabel}
                                          </Button>
                                        </Link>
                                      );
                                    })()}
                                  </>
                                )}
                              </div>
                            </CardContent>
                          </Card>
                        );
                      }

                      return (
                        <EventCard
                          key={`featured-${event.id}`}
                          event={event}
                          organizationInfo={organizationInfo}
                          isFeatureExcluded={resolvedIsFeatureExcluded}
                          isAdmin={isAdmin}
                          joinLinkSettings={joinLinkSettings}
                          webinars={webinars}
                          systemSettings={systemSettings}
                          memberInfo={memberInfo}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
                {nonFeaturedEvents.map((event) => {
                  if (event.is_complex) {
                    const eventTimezone = event.timezone || DEFAULT_TIMEZONE;
                    const detailUrl = event.slug
                      ? `/session-events/${event.slug}`
                      : `/ComplexEventDetail?id=${event.id}`;
                    const hasUnlimitedCapacity = event.available_seats === 0 || event.available_seats === null;
                    const isEventPast = isEventInPast(event);
                    const isRegistrationClosed = event.event_state === 'closed' || 
                      (!event.event_state && event.status === 'closed') ||
                      (event.registration_closes_at && new Date() > new Date(event.registration_closes_at));
                    const cheapest = event.cheapest_price ?? (() => {
                      const tcs = event.pricing_config?.ticket_classes;
                      if (!tcs?.length) return null;
                      const prices = tcs.map(tc => Number(tc.price)).filter(p => Number.isFinite(p));
                      return prices.length > 0 ? Math.min(...prices) : null;
                    })();
                    const showPricesSetting = Array.isArray(systemSettings) 
                      ? systemSettings.find(s => s.setting_key === 'show_event_card_prices')
                      : null;
                    const showPricesOnCard = showPricesSetting?.setting_value === 'true';
                    const eventParsedTypes = parseEventTypes(event.event_type);
                    const hasBadges = event.status === 'draft' || event.status === 'tbc' || isEventPast || eventParsedTypes.length > 0 || isRegistrationClosed;
                    const descriptionText = event.summary || stripHtmlTags(event.description);

                    return (
                      <Card
                        key={`complex-${event.id}`}
                        className="overflow-hidden hover:shadow-lg transition-shadow duration-300 border-slate-200 bg-white"
                        data-testid={`card-event-${event.id}`}
                      >
                        <div className="relative">
                          {event.image_url ? (
                            <div className="h-48 overflow-hidden bg-slate-100">
                              <img
                                src={event.image_url}
                                alt={event.title}
                                className="w-full h-full object-cover hover:scale-105 transition-transform duration-300"
                                style={getFocalPointStyle(event.image_focal_point)}
                              />
                            </div>
                          ) : (
                            <div className={`h-24 ${isEventPast ? 'bg-gradient-to-r from-slate-100 to-slate-50' : 'bg-gradient-to-r from-slate-50 to-blue-50'}`} />
                          )}

                          {hasBadges && (
                            <div className="absolute top-2 left-2 flex flex-wrap items-center gap-1.5 max-w-[calc(100%-1rem)]">
                              {event.status === 'draft' && (
                                <Badge variant="warning" className="shadow-sm">
                                  Draft
                                </Badge>
                              )}
                              {event.status === 'tbc' && (
                                <Badge variant="secondary" className="bg-blue-100/95 text-blue-700 border-blue-200 shadow-sm">
                                  TBC
                                </Badge>
                              )}
                              {isRegistrationClosed && (
                                <Badge variant="secondary" className="bg-red-100/95 text-red-700 border-red-200 shadow-sm" data-testid={`badge-closed-event-${event.id}`}>
                                  Registration Closed
                                </Badge>
                              )}
                              {isEventPast && (
                                <Badge variant="secondary" className="bg-slate-200/95 text-slate-600 border-slate-300 shadow-sm">
                                  Past Event
                                </Badge>
                              )}
                              {eventParsedTypes.map((typeName, etIdx) => {
                                const eventTypeStyle = getEventTypeStyle(typeName, systemSettings);
                                return (
                                  <Badge 
                                    key={etIdx}
                                    variant="secondary" 
                                    className="border-0 shadow-sm"
                                    style={{ 
                                      backgroundColor: `${eventTypeStyle.bgColor}f2`,
                                      color: eventTypeStyle.textColor 
                                    }}
                                  >
                                    {typeName}
                                  </Badge>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        <CardHeader className="pb-3">
                          <h3 className="font-bold text-lg text-slate-900 line-clamp-2">
                            {event.title}
                          </h3>
                          {descriptionText && (
                            <p className="text-sm text-slate-600 mt-2 line-clamp-2" data-testid="text-event-summary">
                              {descriptionText}
                            </p>
                          )}
                        </CardHeader>
                        <CardContent className="space-y-3">
                          {event.status === 'tbc' ? (
                            <div className="flex items-center gap-2 text-sm text-blue-600">
                              <Calendar className="w-4 h-4 text-blue-400" />
                              <span className="font-medium">Date to be confirmed</span>
                            </div>
                          ) : event.start_date && (
                            <div className="flex items-center gap-2 text-sm text-slate-600">
                              <Calendar className="w-4 h-4 text-slate-400 shrink-0" />
                              <span>
                                {formatInTimeZone(parseISO(event.start_date), eventTimezone, "MMM d, yyyy")}
                                {event.end_date && ` - ${formatInTimeZone(parseISO(event.end_date), eventTimezone, "MMM d, yyyy")}`}
                              </span>
                            </div>
                          )}
                          {(event.track_count > 0 || event.session_count > 0) && (
                            <div className="flex items-center gap-4 text-sm text-slate-600">
                              {event.session_count > 0 && (
                                <div className="flex items-center gap-1.5" data-testid={`text-session-count-${event.id}`}>
                                  <List className="w-4 h-4 text-slate-400 shrink-0" />
                                  <span>{event.session_count} {event.session_count === 1 ? 'Session' : 'Sessions'}</span>
                                </div>
                              )}
                              {event.track_count > 0 && (
                                <div className="flex items-center gap-1.5" data-testid={`text-track-count-${event.id}`}>
                                  <Layers className="w-4 h-4 text-slate-400 shrink-0" />
                                  <span>{event.track_count} {event.track_count === 1 ? 'Track' : 'Tracks'}</span>
                                </div>
                              )}
                            </div>
                          )}
                          {event.location && (
                            <div className="flex items-center gap-2 text-sm text-slate-600">
                              <MapPin className="w-4 h-4 text-slate-400 shrink-0" />
                              <span className="line-clamp-1">{event.location}</span>
                            </div>
                          )}
                          {event.show_seat_count !== false && (
                            <div className="flex items-center gap-2 text-sm">
                              <Users className="w-4 h-4 text-slate-400 shrink-0" />
                              {hasUnlimitedCapacity ? (
                                <span className="text-green-600 font-medium">Open Registration</span>
                              ) : event.available_seats > 0 ? (
                                <span className="text-green-600 font-medium">
                                  {event.available_seats} seats available
                                </span>
                              ) : (
                                <span className="text-red-600 font-medium">Sold out</span>
                              )}
                            </div>
                          )}
                          {showPricesOnCard && cheapest !== null && (
                            <div className="flex items-center gap-2 text-sm" data-testid={`text-ticket-price-${event.id}`}>
                              <Ticket className="w-4 h-4 text-slate-400 shrink-0" />
                              {cheapest === 0 ? (
                                <span className="text-green-600 font-medium">Free to register</span>
                              ) : (
                                <span className="text-slate-600">
                                  Price from <span className="font-semibold text-slate-800">{`\u00a3${cheapest.toFixed(2)}`}</span>
                                </span>
                              )}
                            </div>
                          )}
                          <div className="pt-3 border-t border-slate-100">
                            {memberInfo && (!resolvedIsFeatureExcluded?.('events.browse-events.create') || !resolvedIsFeatureExcluded?.('events.browse-events.view-attendees')) && (
                              <div className="flex items-center gap-2 mb-3">
                                {!resolvedIsFeatureExcluded?.('events.browse-events.create') && (
                                  <Button 
                                    variant="outline" 
                                    size="sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      window.location.href = createPageUrl("CreateComplexEvent") + "?id=" + event.id;
                                    }}
                                    className="flex-1"
                                    data-testid={`button-edit-event-${event.id}`}
                                  >
                                    <Pencil className="w-4 h-4 mr-1" />
                                    Edit
                                  </Button>
                                )}
                                {!resolvedIsFeatureExcluded?.('events.browse-events.view-attendees') && (
                                  <Button 
                                    variant="outline" 
                                    size="sm"
                                    onClick={(e) => handleComplexAttendeesClick(e, event)}
                                    className="flex-1 text-purple-600 hover:text-purple-700 hover:bg-purple-50 border-purple-200"
                                    data-testid={`button-attendees-event-${event.id}`}
                                  >
                                    <UsersRound className="w-4 h-4 mr-1" />
                                    Attendees
                                  </Button>
                                )}
                                {!resolvedIsFeatureExcluded?.('events.browse-events.create') && (
                                  <Button 
                                    variant="outline" 
                                    size="sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setComplexDeleteTarget(event);
                                    }}
                                    className="flex-1 text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
                                    data-testid={`button-delete-event-${event.id}`}
                                  >
                                    <Trash2 className="w-4 h-4 mr-1" />
                                    Delete
                                  </Button>
                                )}
                              </div>
                            )}

                            {!resolvedIsFeatureExcluded?.('events.event-details') && (
                              <>
                                {isEventPast ? (
                                  <Button 
                                    className="w-full"
                                    variant="secondary"
                                    disabled
                                    data-testid={`button-event-ended-${event.id}`}
                                  >
                                    Event Ended
                                  </Button>
                                ) : (() => {
                                  const ctaConfig = getCtaButtonConfig(systemSettings);
                                  const isSoldOut = !hasUnlimitedCapacity && event.available_seats === 0;
                                  const buttonLabel = isRegistrationClosed ? "Registration Closed" : (isSoldOut ? "Sold Out" : ctaConfig.label);
                                  const isGradient = ctaConfig.style === 'gradient';
                                  
                                  return (
                                    <Link to={detailUrl}>
                                      <Button 
                                        variant={isRegistrationClosed ? "secondary" : "default"}
                                        className={`w-full ${!isRegistrationClosed && isGradient 
                                          ? 'bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 text-white shadow-lg' 
                                          : !isRegistrationClosed ? 'bg-blue-600' : ''}`}
                                        disabled={isSoldOut}
                                        data-testid={`button-register-event-${event.id}`}
                                      >
                                        {buttonLabel}
                                      </Button>
                                    </Link>
                                  );
                                })()}
                              </>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  }

                  return (
                    <EventCard
                      key={event.id}
                      event={event}
                      organizationInfo={organizationInfo}
                      isFeatureExcluded={resolvedIsFeatureExcluded}
                      isAdmin={isAdmin}
                      joinLinkSettings={joinLinkSettings}
                      webinars={webinars}
                      systemSettings={systemSettings}
                      memberInfo={memberInfo}
                    />
                  );
                })}
              </div>
              </>
            )}
          </>
        )}
      </div>

      <Dialog open={!!complexDeleteTarget} onOpenChange={(open) => {
        if (!open) {
          setComplexDeleteTarget(null);
          setComplexDeleteConfirmText("");
          setComplexDeleteOrganiserMessage("");
          setComplexDeleteResultSummary(null);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Complex Event</DialogTitle>
            <DialogDescription>
              All active bookings for "{complexDeleteTarget?.title}" will be cancelled, refunds processed, credit notes raised, Zoom registrations removed, and attendees emailed. The event and its tracks/sessions/ticket classes will then be deleted. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            {complexDeletePreviewLoading && (
              <div className="text-sm text-slate-500" data-testid="text-complex-delete-preview-loading">Loading preview…</div>
            )}
            {complexDeletePreviewError && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700" data-testid="text-complex-delete-preview-error">{complexDeletePreviewError}</div>
            )}
            {complexDeletePreview && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs space-y-1" data-testid="text-complex-delete-preview-summary">
                <p><strong>{complexDeletePreview.activeBookings}</strong> active booking(s) will be cancelled
                  {complexDeletePreview.alreadyCancelledBookings > 0 ? ` (${complexDeletePreview.alreadyCancelledBookings} already cancelled)` : ''}.</p>
                {complexDeletePreview.stripeRefundCount > 0 && (
                  <p>{complexDeletePreview.stripeRefundCount} card refund(s) — total {Object.entries(complexDeletePreview.refundByCurrency || {}).map(([c, a]) => `${c} ${Number(a).toFixed(2)}`).join(', ') || '£0.00'}</p>
                )}
                {complexDeletePreview.xeroCreditNoteCount > 0 && (
                  <p>{complexDeletePreview.xeroCreditNoteCount} Xero credit note(s) — total £{Number(complexDeletePreview.totalCreditNote || 0).toFixed(2)}</p>
                )}
                {(complexDeletePreview.totalTrainingFundReinstatement > 0 || complexDeletePreview.totalVoucherReinstatement > 0) && (
                  <p>Training fund: £{Number(complexDeletePreview.totalTrainingFundReinstatement || 0).toFixed(2)} · Vouchers: £{Number(complexDeletePreview.totalVoucherReinstatement || 0).toFixed(2)} reinstated</p>
                )}
                {complexDeletePreview.cleanup?.complexChildren && (
                  <p className="text-slate-600">Will also delete {complexDeletePreview.cleanup.complexChildren.tracks} track(s), {complexDeletePreview.cleanup.complexChildren.sessions} session(s), {complexDeletePreview.cleanup.complexChildren.ticketClasses} ticket class(es).</p>
                )}
                {complexDeletePreview.requiresManualActionCount > 0 && (
                  <p className="text-warning">⚠ {complexDeletePreview.requiresManualActionCount} booking(s) will need manual refund/credit-note follow-up.</p>
                )}
              </div>
            )}
            <div>
              <label className="text-sm font-medium text-slate-700 block mb-1">Optional message to attendees</label>
              <textarea
                className="w-full rounded-md border border-slate-200 p-2 text-sm focus:border-slate-400 focus:outline-none"
                rows={3}
                placeholder="e.g. We're very sorry — the venue had to cancel at short notice."
                value={complexDeleteOrganiserMessage}
                onChange={(e) => setComplexDeleteOrganiserMessage(e.target.value)}
                data-testid="textarea-complex-delete-organiser-message"
              />
            </div>
            <p className="text-sm text-slate-600">Type <span className="font-bold">DELETE EVENT</span> to confirm:</p>
            <Input
              value={complexDeleteConfirmText}
              onChange={(e) => setComplexDeleteConfirmText(e.target.value)}
              placeholder="DELETE EVENT"
              data-testid="input-delete-confirm"
            />
            {complexDeleteResultSummary && Array.isArray(complexDeleteResultSummary.failed) && complexDeleteResultSummary.failed.length > 0 && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs space-y-1" data-testid="text-complex-delete-failure-summary">
                <p className="font-semibold text-red-700">{complexDeleteResultSummary.failed.length} booking(s) failed:</p>
                <ul className="list-disc pl-4 text-red-700 max-h-32 overflow-auto">
                  {complexDeleteResultSummary.failed.slice(0, 10).map((f, i) => (
                    <li key={i}>{f.bookingReference || f.bookingId}: {f.error}</li>
                  ))}
                </ul>
                <p className="text-red-700">Event left in 'cancelling' state. Resolve and re-run delete.</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setComplexDeleteTarget(null); setComplexDeleteConfirmText(""); }} data-testid="button-cancel-delete">
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={complexDeleteConfirmText !== "DELETE EVENT" || deleteComplexEventMutation.isPending}
              onClick={() => deleteComplexEventMutation.mutate(complexDeleteTarget?.id)}
              data-testid="button-confirm-delete"
            >
              {deleteComplexEventMutation.isPending ? "Deleting..." : "Delete Event"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showCreateEventModal} onOpenChange={setShowCreateEventModal}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create New Event</DialogTitle>
            <DialogDescription>
              What type of event would you like to create?
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <button
              type="button"
              className="flex items-start gap-4 p-4 rounded-lg border border-slate-200 text-left hover-elevate transition-colors"
              data-testid="button-create-single-event"
              onClick={() => {
                setShowCreateEventModal(false);
                window.location.href = createPageUrl('CreateEvent');
              }}
            >
              <div className="mt-0.5 p-2 rounded-lg bg-blue-50 text-blue-600 shrink-0">
                <Calendar className="h-5 w-5" />
              </div>
              <div>
                <p className="font-semibold text-sm">Single Session Event</p>
                <p className="text-xs text-muted-foreground mt-1">
                  A standalone event with one session, such as a workshop, webinar, or social gathering. Ideal for simple events with a single date and time.
                </p>
              </div>
            </button>
            <button
              type="button"
              className="flex items-start gap-4 p-4 rounded-lg border border-slate-200 text-left hover-elevate transition-colors"
              data-testid="button-create-complex-event"
              onClick={() => {
                setShowCreateEventModal(false);
                window.location.href = createPageUrl('CreateComplexEvent');
              }}
            >
              <div className="mt-0.5 p-2 rounded-lg bg-purple-50 text-purple-600 shrink-0">
                <Layers className="h-5 w-5" />
              </div>
              <div>
                <p className="font-semibold text-sm">Multi-Session Event</p>
                <p className="text-xs text-muted-foreground mt-1">
                  A complex event with multiple tracks, sessions, and ticket classes. Suited for conferences, courses, or multi-day programmes with separate bookable sessions.
                </p>
              </div>
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {isAdmin && (
        <Dialog open={showComplexAttendeesModal} onOpenChange={(open) => {
          if (!open) {
            setComplexAttendeesEvent(null);
            setComplexAttendeesOrgFilter("all");
            setComplexAttendeesSearch("");
            setComplexAttendeesPage(1);
            setShowComplexImportDialog(false);
            setComplexImportEmailsText("");
            setComplexImportResults(null);
          }
        }}>
          <DialogContent className="sm:max-w-5xl max-h-[80vh] flex flex-col">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <UsersRound className="w-5 h-5 text-purple-600" />
                Attendees - {complexAttendeesEvent?.title}
              </DialogTitle>
              <DialogDescription>
                {complexActiveBookings?.length || 0} registered attendee{complexActiveBookings?.length !== 1 ? 's' : ''}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col sm:flex-row gap-3 py-4 border-b">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search by name, email or organisation..."
                  value={complexAttendeesSearch}
                  onChange={(e) => setComplexAttendeesSearch(e.target.value)}
                  className="pl-9"
                  data-testid="input-complex-attendee-search"
                />
              </div>
              <Select value={complexAttendeesOrgFilter} onValueChange={setComplexAttendeesOrgFilter}>
                <SelectTrigger className="w-full sm:w-[200px]" data-testid="select-complex-organization-filter">
                  <SelectValue placeholder="Filter by organisation" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Organisations</SelectItem>
                  {complexUniqueOrganizations.map(org => (
                    <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button 
                variant="outline" 
                onClick={handleComplexImportClick}
                data-testid="button-complex-import-attendees"
              >
                <Upload className="w-4 h-4 mr-2" />
                Import
              </Button>
              <Button 
                variant="outline" 
                onClick={complexExportToCSV}
                disabled={!complexFilteredAttendees.length}
                data-testid="button-complex-export-csv"
              >
                <Download className="w-4 h-4 mr-2" />
                Export CSV
              </Button>
            </div>

            <div className="flex-1 overflow-auto">
              {complexBookingsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
                </div>
              ) : complexFilteredAttendees.length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                  {complexActiveBookings?.length === 0 ? (
                    <p>No attendees registered for this event yet.</p>
                  ) : (
                    <p>No attendees match your search criteria.</p>
                  )}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Job Title</TableHead>
                      <TableHead>Organisation</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {complexPaginatedAttendees.map((booking, index) => {
                      const isResending = complexResendingBookingId === booking.id;
                      return (
                        <TableRow key={booking.id || index} data-testid={`row-complex-attendee-${booking.id || index}`}>
                          <TableCell className="font-medium">
                            {`${booking.attendee_first_name || ''} ${booking.attendee_last_name || ''}`.trim() || '-'}
                          </TableCell>
                          <TableCell>
                            {booking.member_id
                              ? (complexMemberJobTitleMap[booking.member_id] || '-')
                              : <span className="text-muted-foreground">-</span>
                            }
                          </TableCell>
                          <TableCell>
                            {booking.organization_id 
                              ? (complexOrgMap[booking.organization_id] || '-')
                              : <span className="text-muted-foreground italic">Non-member</span>
                            }
                          </TableCell>
                          <TableCell>
                            <a 
                              href={`mailto:${booking.attendee_email}`} 
                              className="text-blue-600 hover:underline"
                            >
                              {booking.attendee_email || '-'}
                            </a>
                          </TableCell>
                          <TableCell className="text-right">
                            <TooltipProvider delayDuration={100}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    onClick={() => booking.id && complexResendConfirmationMutation.mutate(booking.id)}
                                    disabled={!booking.id || isResending}
                                    aria-label="Resend confirmation email"
                                    data-testid={`button-resend-confirmation-${booking.id}`}
                                  >
                                    {isResending ? (
                                      <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                      <Send className="w-4 h-4" />
                                    )}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  Resend confirmation email
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </div>

            {complexFilteredAttendees.length > 0 && (
              <div className="pt-3 border-t flex flex-col sm:flex-row items-center justify-between gap-3">
                <div className="text-sm text-slate-500">
                  Showing {complexStartIndex + 1}-{Math.min(complexEndIndex, complexFilteredAttendees.length)} of {complexFilteredAttendees.length} attendee{complexFilteredAttendees.length !== 1 ? 's' : ''}
                  {complexAttendeesOrgFilter !== "all" || complexAttendeesSearch ? ` (filtered from ${complexActiveBookings?.length || 0})` : ''}
                </div>
                
                {complexTotalPages > 1 && (
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setComplexAttendeesPage(prev => Math.max(1, prev - 1))}
                      disabled={complexAttendeesPage === 1}
                      data-testid="button-complex-prev-page"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    
                    {getComplexPageNumbers().map((page, idx) => (
                      page === '...' ? (
                        <span key={`ellipsis-${idx}`} className="px-2 text-slate-400">...</span>
                      ) : (
                        <Button
                          key={page}
                          variant={complexAttendeesPage === page ? "default" : "outline"}
                          size="sm"
                          onClick={() => setComplexAttendeesPage(page)}
                          className="min-w-[36px]"
                          data-testid={`button-complex-page-${page}`}
                        >
                          {page}
                        </Button>
                      )
                    ))}
                    
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setComplexAttendeesPage(prev => Math.min(complexTotalPages, prev + 1))}
                      disabled={complexAttendeesPage === complexTotalPages}
                      data-testid="button-complex-next-page"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}

      {isAdmin && (
        <Dialog open={showComplexImportDialog} onOpenChange={(open) => {
          setShowComplexImportDialog(open);
          if (!open) {
            setComplexImportEmailsText("");
            setComplexImportResults(null);
            setComplexImportTicketClassId("");
            setComplexImportSendConfirmations(true);
            setComplexImportTicketClasses([]);
          }
        }}>
          <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Upload className="w-5 h-5 text-purple-600" />
                Import Attendees
              </DialogTitle>
              <DialogDescription>
                Paste a CSV-style list to register both members and guests. Existing members are matched by email; any non-matching email is added as a guest using the supplied details.
              </DialogDescription>
            </DialogHeader>

            <div className="py-4 space-y-4">
              {complexImportTicketClasses.length > 0 && (
                <div className="space-y-1.5">
                  <Label htmlFor="complex-import-ticket-class">Ticket class</Label>
                  <Select
                    value={complexImportTicketClassId || "__default__"}
                    onValueChange={(v) => setComplexImportTicketClassId(v === "__default__" ? "" : v)}
                    disabled={complexImportAttendeesMutation.isPending}
                  >
                    <SelectTrigger id="complex-import-ticket-class" data-testid="select-complex-import-ticket-class">
                      <SelectValue placeholder="Select a ticket class" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">
                        {complexAttendeesEvent?.is_complex ? 'Default (cheapest)' : 'No ticket class'}
                      </SelectItem>
                      {complexImportTicketClasses.map(tc => {
                        const isMembersOnly = tc.visibility_mode
                          ? tc.visibility_mode === 'members_only'
                          : tc.is_public === false;
                        return (
                          <SelectItem key={tc.id} value={String(tc.id)}>
                            {tc.name || 'Ticket'}{isMembersOnly ? ' (members-only)' : ''}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div>
                <Label htmlFor="complex-import-textarea">Attendees (CSV)</Label>
                <textarea
                  id="complex-import-textarea"
                  className="mt-1.5 w-full h-40 p-3 border rounded-md text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-purple-500"
                  placeholder={"first_name,last_name,email,organization,job_title\nJane,Doe,jane@example.com,Acme Ltd,Manager\nJohn,Smith,john@example.com,,"}
                  value={complexImportEmailsText}
                  onChange={(e) => setComplexImportEmailsText(e.target.value)}
                  disabled={complexImportAttendeesMutation.isPending}
                  data-testid="textarea-complex-import-emails"
                />
                <p className="text-xs text-slate-500 mt-2">
                  Format: <code className="font-mono">first_name, last_name, email, organization, job_title</code>. A header row is supported. Only the email column is required; the rest is used for guests.
                </p>
              </div>

              <div className="flex items-start gap-2">
                <Checkbox
                  id="complex-import-send-confirmations"
                  checked={complexImportSendConfirmations}
                  onCheckedChange={(v) => setComplexImportSendConfirmations(v === true)}
                  disabled={complexImportAttendeesMutation.isPending}
                  data-testid="checkbox-complex-import-send-confirmations"
                />
                <div className="-mt-0.5">
                  <Label
                    htmlFor="complex-import-send-confirmations"
                    className="cursor-pointer"
                  >
                    Send confirmation emails now
                  </Label>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Sends the event's confirmation email to every newly-imported attendee (members and guests).
                  </p>
                </div>
              </div>
            </div>

            {complexImportResults && (
              <div className="space-y-3 py-2 border-t">
                {(complexImportResults.registeredMembers?.length || 0) > 0 && (
                  <div className="flex items-start gap-2 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-green-700">Registered — Members ({complexImportResults.registeredMembers.length})</p>
                      <p className="text-slate-600 text-xs mt-1">{complexImportResults.registeredMembers.join(', ')}</p>
                    </div>
                  </div>
                )}
                {(complexImportResults.registeredGuests?.length || 0) > 0 && (
                  <div className="flex items-start gap-2 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-green-700">Registered — Guests ({complexImportResults.registeredGuests.length})</p>
                      <p className="text-slate-600 text-xs mt-1">{complexImportResults.registeredGuests.join(', ')}</p>
                    </div>
                  </div>
                )}
                {(complexImportResults.alreadyRegistered?.length || 0) > 0 && (
                  <div className="flex items-start gap-2 text-sm">
                    <AlertTriangle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-warning">Already Registered ({complexImportResults.alreadyRegistered.length})</p>
                      <p className="text-slate-600 text-xs mt-1">{complexImportResults.alreadyRegistered.join(', ')}</p>
                    </div>
                  </div>
                )}
                {(complexImportResults.warnings?.length || 0) > 0 && (
                  <div className="flex items-start gap-2 text-sm">
                    <AlertTriangle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-warning">Warnings ({complexImportResults.warnings.length})</p>
                      <p className="text-slate-600 text-xs mt-1">
                        {complexImportResults.warnings.map(w => `${w.email}: ${w.reason}`).join('; ')}
                      </p>
                    </div>
                  </div>
                )}
                {(complexImportResults.errors?.length || 0) > 0 && (
                  <div className="flex items-start gap-2 text-sm">
                    <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-red-700">Errors ({complexImportResults.errors.length})</p>
                      <p className="text-slate-600 text-xs mt-1">
                        {complexImportResults.errors.map(e => {
                          const prefix = e.row ? `Row ${e.row}` : (e.email || 'Row');
                          return `${prefix}${e.email && e.row ? ` (${e.email})` : ''}: ${e.error}`;
                        }).join('; ')}
                      </p>
                    </div>
                  </div>
                )}
                {complexImportResults.sendConfirmations && (
                  <div className="flex items-start gap-2 text-sm">
                    <Send className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-blue-700">
                        Emails sent ({complexImportResults.emailsSent?.length || 0})
                        {(complexImportResults.emailsFailed?.length || 0) > 0
                          ? ` · failed (${complexImportResults.emailsFailed.length})`
                          : ''}
                      </p>
                      {(complexImportResults.emailsFailed?.length || 0) > 0 && (
                        <p className="text-slate-600 text-xs mt-1">
                          Failed: {complexImportResults.emailsFailed.map(f => `${f.email}: ${f.error}`).join('; ')}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            <DialogFooter className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setShowComplexImportDialog(false)}
                disabled={complexImportAttendeesMutation.isPending}
                data-testid="button-complex-cancel-import"
              >
                {complexImportResults ? 'Close' : 'Cancel'}
              </Button>
              {!complexImportResults && (
                <Button
                  onClick={handleComplexImportSubmit}
                  disabled={!complexImportEmailsText.trim() || complexImportAttendeesMutation.isPending}
                  data-testid="button-complex-submit-import"
                >
                  {complexImportAttendeesMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Importing...
                    </>
                  ) : (
                    'Import Attendees'
                  )}
                </Button>
              )}
              {complexImportResults && (
                <Button
                  onClick={() => {
                    setComplexImportResults(null);
                    setComplexImportEmailsText("");
                  }}
                  data-testid="button-complex-import-more"
                >
                  Import More
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
