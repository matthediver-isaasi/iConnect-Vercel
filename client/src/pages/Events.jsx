import React, { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, Calendar, Plus, History, Tag, Check, ChevronDown, Layers, X, MapPin, FileEdit, Clock, Users, Ticket, Pencil, Trash2, UsersRound, List, Star } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { parseISO } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { Link } from "react-router-dom";
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
  getFilterTagLabels 
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
  const [searchQuery, setSearchQuery] = useState("");
  const [complexDeleteTarget, setComplexDeleteTarget] = useState(null);
  const [complexDeleteConfirmText, setComplexDeleteConfirmText] = useState("");
  const [selectedFilterTags, setSelectedFilterTags] = useState([]);
  const [selectedEventType, setSelectedEventType] = useState("all");
  const [selectedDeliveryMode, setSelectedDeliveryMode] = useState("all");
  const [showPastEvents, setShowPastEvents] = useState(false);
  const [showDraftEvents, setShowDraftEvents] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [tourAutoShow, setTourAutoShow] = useState(false);

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
  } = useEventsData();

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

  const deleteComplexEventMutation = useMutation({
    mutationFn: async (id) => {
      const ticketClasses = await base44.entities.ComplexEventTicketClass.filter({ complex_event_id: id });
      for (const tc of ticketClasses) {
        await base44.entities.ComplexEventTicketClass.delete(tc.id);
      }
      const tracks = await base44.entities.ComplexEventTrack.filter({ complex_event_id: id });
      for (const track of tracks) {
        const sessions = await base44.entities.ComplexEventSession.filter({ complex_event_track_id: track.id });
        for (const session of sessions) {
          await base44.entities.ComplexEventSession.delete(session.id);
        }
        await base44.entities.ComplexEventTrack.delete(track.id);
      }
      await base44.entities.ComplexEvent.delete(id);
    },
    onSuccess: () => {
      toast.success('Complex event deleted successfully');
      queryClient.invalidateQueries({ queryKey: ['complex-events-for-listing'] });
      setComplexDeleteTarget(null);
      setComplexDeleteConfirmText("");
    },
    onError: (error) => {
      console.error('Delete complex event error:', error);
      toast.error('Failed to delete event: ' + (error.message || 'Unknown error'));
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
  // Only runs for authenticated users - skipped on public pages
  const { data: eventCategories = [] } = useQuery({
    queryKey: ['event-filter-categories'],
    queryFn: async () => {
      try {
        // Get all active categories that have 'Events' in their applies_to_content_types
        const categories = await base44.entities.ResourceCategory.list('display_order');
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
    },
    enabled: !!memberInfo // Only fetch when authenticated
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
      matchesEventType = event.event_type === selectedEventType;
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

  // Sort events: dated events first (by date), then TBC events at the end
  filteredEvents.sort((a, b) => {
    const aIsTbc = a.status === 'tbc' || !a.start_date;
    const bIsTbc = b.status === 'tbc' || !b.start_date;
    
    // TBC events go to the end
    if (aIsTbc && !bIsTbc) return 1;
    if (!aIsTbc && bIsTbc) return -1;
    
    // Both TBC or both dated - sort by title for TBC, by date for dated
    if (aIsTbc && bIsTbc) {
      return (a.title || '').localeCompare(b.title || '');
    }
    
    const dateA = new Date(a.start_date);
    const dateB = new Date(b.start_date);
    return dateA.getTime() - dateB.getTime();
  });

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
      matchesEventType = event.event_type === selectedEventType;
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
      matchesEventType = event.event_type === selectedEventType;
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
            {(eventCategories.length > 0 || eventTypes.length > 0) && (
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
                              onClick={() => setSelectedFilterTags([])}
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
                                  onClick={() => {
                                    if (isSelected) {
                                      setSelectedFilterTags(prev => prev.filter(t => t !== tagKey));
                                    } else {
                                      setSelectedFilterTags(prev => [...prev, tagKey]);
                                    }
                                  }}
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

                {/* Create Event Button - shown only when logged in and not excluded */}
                {memberInfo && !resolvedIsFeatureExcluded('events.browse-events.create') && (
                  <Button
                    onClick={() => window.location.href = createPageUrl('CreateEvent')}
                    className="bg-blue-600 hover:bg-blue-700 ml-auto"
                    data-testid="button-create-event"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Create Event
                  </Button>
                )}
              </div>
            )}

            {/* Create Event Button - shown when no filter row, only when logged in and not excluded */}
            {memberInfo && !resolvedIsFeatureExcluded('events.browse-events.create') && !(eventCategories.length > 0 || eventTypes.length > 0) && (
              <div className="flex justify-end mt-4">
                <Button
                  onClick={() => window.location.href = createPageUrl('CreateEvent')}
                  className="bg-blue-600 hover:bg-blue-700"
                  data-testid="button-create-event-no-filters"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Create Event
                </Button>
              </div>
            )}
            
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
                    <Star className="h-5 w-5 text-amber-500" />
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
                        const hasBadges = event.status === 'draft' || event.status === 'tbc' || isEventPast || event.event_type || isRegistrationClosed;
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
                                    <Badge variant="secondary" className="bg-amber-100/95 text-amber-700 border-amber-200 shadow-sm">Draft</Badge>
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
                                  {event.event_type && (() => {
                                    const eventTypeStyle = getEventTypeStyle(event.event_type, systemSettings);
                                    return (
                                      <Badge variant="secondary" className="border-0 shadow-sm" style={{ backgroundColor: `${eventTypeStyle.bgColor}f2`, color: eventTypeStyle.textColor }}>
                                        {event.event_type}
                                      </Badge>
                                    );
                                  })()}
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
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          window.location.href = detailUrl + (detailUrl.includes('?') ? '&' : '?') + 'tab=attendees';
                                        }}
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
                    const hasBadges = event.status === 'draft' || event.status === 'tbc' || isEventPast || event.event_type || isRegistrationClosed;
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
                                <Badge variant="secondary" className="bg-amber-100/95 text-amber-700 border-amber-200 shadow-sm">
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
                              {event.event_type && (() => {
                                const eventTypeStyle = getEventTypeStyle(event.event_type, systemSettings);
                                return (
                                  <Badge 
                                    variant="secondary" 
                                    className="border-0 shadow-sm"
                                    style={{ 
                                      backgroundColor: `${eventTypeStyle.bgColor}f2`,
                                      color: eventTypeStyle.textColor 
                                    }}
                                  >
                                    {event.event_type}
                                  </Badge>
                                );
                              })()}
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
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      window.location.href = detailUrl + (detailUrl.includes('?') ? '&' : '?') + 'tab=attendees';
                                    }}
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
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Complex Event</DialogTitle>
            <DialogDescription>
              This will permanently delete "{complexDeleteTarget?.title}" and all its tracks, sessions, and ticket classes. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <p className="text-sm text-slate-600">Type <span className="font-bold">DELETE EVENT</span> to confirm:</p>
            <Input
              value={complexDeleteConfirmText}
              onChange={(e) => setComplexDeleteConfirmText(e.target.value)}
              placeholder="DELETE EVENT"
              data-testid="input-delete-confirm"
            />
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
    </div>
  );
}
