import React, { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, Calendar, Plus, History, Tag, Check, ChevronDown, Layers, X, MapPin } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { parseISO } from "date-fns";
import EventCard from "../components/events/EventCard";
import PageTour from "../components/tour/PageTour";
import TourButton from "../components/tour/TourButton";
import { base44 } from "@/api/base44Client";
import { useLayoutContext } from "@/contexts/LayoutContext";
import { useMemberAccess } from "@/hooks/useMemberAccess";
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
  const { eventTypes } = useEventTypes();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFilterTags, setSelectedFilterTags] = useState([]);
  const [selectedEventType, setSelectedEventType] = useState("all");
  const [selectedDeliveryMode, setSelectedDeliveryMode] = useState("all");
  const [showPastEvents, setShowPastEvents] = useState(false);
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

  // Load events using base44 client proxy
  const {
    data: events = [],
    isLoading,
    error: eventsError,
  } = useQuery({
    queryKey: ["events"],
    queryFn: async () => {
      try {
        const data = await base44.entities.Event.list({ sort: { start_date: 'asc' } });
        return data || [];
      } catch (error) {
        console.error("[Events] Error loading events:", error);
        throw error;
      }
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  // Query for all system settings
  const { data: systemSettings = [] } = useQuery({
    queryKey: ['system-settings'],
    queryFn: () => base44.entities.SystemSettings.list()
  });

  // Query for webinar join link visibility settings
  const { data: joinLinkSettings } = useQuery({
    queryKey: ['webinar-join-link-settings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
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
    }
  });

  // Query for categories that apply to Events content type - return full categories with subcategories
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
    }
  });

  if (eventsError) {
    console.error("[Events] eventsError:", eventsError);
  }

  // Build filter tag key map for display and filtering
  const filterTagKeyMap = useMemo(() => buildFilterTagKeyMap(eventCategories), [eventCategories]);

  // Filter events by status and access level
  // - Admins see all events (including drafts)
  // - Everyone else (members and non-logged-in users) sees published and tbc events
  // - Non-logged-in users can view member-only events but tickets will be locked
  //   This allows advertising member-only events to encourage membership signup
  const accessibleEvents = useMemo(() => {
    let filtered = events;
    
    // Filter by status based on admin status
    // Admins see all events, everyone else sees only published and tbc
    if (!isAdmin) {
      filtered = filtered.filter(event => 
        event.status === 'published' || event.status === 'tbc' || !event.status
      );
    }
    
    return filtered;
  }, [events, isAdmin]);

  // Helper to check if event is in the past (timezone-aware)
  const isEventPast = (event) => {
    if (!event.start_date) return false;
    try {
      // Parse the date string properly - the date is stored in ISO format
      const eventDate = typeof event.start_date === 'string' 
        ? parseISO(event.start_date) 
        : new Date(event.start_date);
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

                {/* Create Event Button - shown unless excluded */}
                {!resolvedIsFeatureExcluded('events.browse-events.create') && (
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

            {/* Create Event Button - shown when no filter row, unless excluded */}
            {!resolvedIsFeatureExcluded('events.browse-events.create') && !(eventCategories.length > 0 || eventTypes.length > 0) && (
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
            
            {/* Show Past Events Toggle */}
            {pastEventsCount > 0 && (
              <div className="flex items-center gap-3 mt-4 pt-4 border-t border-slate-200">
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
          </div>
        )}

        {/* Events Display */}
        {isLoading ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
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
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredEvents.map((event) => (
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
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
