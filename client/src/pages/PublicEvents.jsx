import React, { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar, CalendarDays, MapPin, Clock, Users, Ticket, Star, List, Layers, Info } from "lucide-react";
import { format, parseISO } from "date-fns";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import { publicClient } from "@/api/publicClient";
import { getFocalPointStyle } from "@/components/FocalPointPicker";
import { parseEventTypes } from "@/lib/utils";
import { Link } from "react-router-dom";
import TenantCtaButton from "@/components/common/TenantCtaButton";

const DEFAULT_TIMEZONE = "Europe/London";

const formatEventDate = (dateStr, timezone = DEFAULT_TIMEZONE, formatStr = "MMM d, yyyy") => {
  if (!dateStr) return null;
  try {
    const date = typeof dateStr === 'string' ? parseISO(dateStr) : dateStr;
    return formatInTimeZone(date, timezone, formatStr);
  } catch (e) {
    console.error('Error formatting date:', e);
    return format(new Date(dateStr), formatStr);
  }
};

const formatEventTime = (dateStr, timezone = DEFAULT_TIMEZONE) => {
  if (!dateStr) return null;
  try {
    const date = typeof dateStr === 'string' ? parseISO(dateStr) : dateStr;
    return formatInTimeZone(date, timezone, "h:mm a");
  } catch (e) {
    console.error('Error formatting time:', e);
    return format(new Date(dateStr), "h:mm a");
  }
};

const getTimezoneAbbr = (dateStr, timezone = DEFAULT_TIMEZONE) => {
  try {
    const eventDate = dateStr ? (typeof dateStr === 'string' ? parseISO(dateStr) : dateStr) : new Date();
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      timeZoneName: 'short'
    });
    const parts = formatter.formatToParts(eventDate);
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    return tzPart ? tzPart.value : timezone;
  } catch {
    return timezone;
  }
};

const hasPublicTickets = (event) => {
  if (event.pricing_config?.ticket_classes && Array.isArray(event.pricing_config.ticket_classes)) {
    return event.pricing_config.ticket_classes.some(tc => {
      if (tc.visibility_mode) {
        return tc.visibility_mode === 'members_and_public' || tc.visibility_mode === 'public_only';
      }
      return tc.is_public === true;
    });
  }
  return false;
};

const getCheapestPrice = (pricingConfig) => {
  if (!pricingConfig?.ticket_classes?.length) return null;
  const prices = pricingConfig.ticket_classes
    .map(tc => Number(tc.price))
    .filter(p => Number.isFinite(p));
  if (prices.length === 0) return null;
  return Math.min(...prices);
};

const getEventDetailUrl = (event) => {
  if (event.is_complex) {
    if (event.slug) {
      return `/session-events/${event.slug}`;
    }
    return `/ComplexEventDetail?id=${event.id}`;
  }
  if (event.slug) {
    return `/events/${event.slug}`;
  }
  return `/EventDetails?id=${event.id}`;
};

export default function PublicEventsPage() {
  const { data: allSimpleEvents = [], isLoading: isLoadingSimple } = useQuery({
    queryKey: ['public-events'],
    queryFn: async () => await publicClient.listEvents() || [],
    staleTime: 0
  });

  const { data: allComplexEvents = [], isLoading: isLoadingComplex } = useQuery({
    queryKey: ['public-complex-events'],
    queryFn: async () => await publicClient.listComplexEvents() || [],
    staleTime: 0
  });

  const { data: systemSettings = [] } = useQuery({
    queryKey: ['public-system-settings'],
    queryFn: () => publicClient.listSystemSettings()
  });

  const isLoading = isLoadingSimple || isLoadingComplex;

  const events = useMemo(() => {
    const filteredSimple = allSimpleEvents.filter(hasPublicTickets);
    const combined = [...filteredSimple, ...allComplexEvents];
    combined.sort((a, b) => {
      const dateA = a.start_date ? new Date(a.start_date).getTime() : 0;
      const dateB = b.start_date ? new Date(b.start_date).getTime() : 0;
      return dateA - dateB;
    });
    return combined;
  }, [allSimpleEvents, allComplexEvents]);

  const featuredEvents = useMemo(() => events.filter(e => e.is_featured === true), [events]);

  const featuredBgConfig = useMemo(() => {
    const setting = Array.isArray(systemSettings)
      ? systemSettings.find(item => item.setting_key === 'featured_events_background')
      : null;
    if (setting?.setting_value) {
      try { return JSON.parse(setting.setting_value); } catch { return null; }
    }
    return null;
  }, [systemSettings]);

  const featuredBgStyle = featuredBgConfig
    ? featuredBgConfig.mode === 'gradient'
      ? { background: `linear-gradient(to right, ${featuredBgConfig.from}, ${featuredBgConfig.to})` }
      : { background: featuredBgConfig.color }
    : { background: '#f0f9ff' };

  const featuredHeaderTextColor = featuredBgConfig?.headerTextColor || null;
  const featuredHeaderIconColor = featuredBgConfig?.headerIconColor || null;

  return (
    <div className="bg-white min-h-screen">
      <div className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-20">
        <div className="max-w-7xl mx-auto px-4">
          <h1 className="text-4xl md:text-5xl font-bold mb-6" data-testid="text-page-title">Upcoming Events</h1>
          <p className="text-xl text-blue-100 max-w-3xl">
            Discover professional development opportunities, training sessions, and networking events for careers professionals in higher education.
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-16">
        {isLoading ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array(6).fill(0).map((_, i) => (
              <Card key={i} className="animate-pulse border-slate-200">
                <div className="h-48 bg-slate-200" />
                <CardHeader>
                  <div className="h-6 bg-slate-200 rounded w-3/4 mb-2" />
                  <div className="h-4 bg-slate-200 rounded w-full" />
                </CardHeader>
              </Card>
            ))}
          </div>
        ) : events.length === 0 ? (
          <Card className="border-slate-200">
            <CardContent className="p-12 text-center">
              <Calendar className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2" data-testid="text-no-events">No Upcoming Events</h3>
              <p className="text-slate-600 mb-6">
                Check back soon for new professional development opportunities
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
          {featuredEvents.length > 0 && (
            <div className="mb-8 rounded-lg p-4 -mx-[10px]" style={featuredBgStyle} data-testid="card-featured-events">
              <div className="flex items-center gap-2 mb-4">
                <Star
                  className={featuredHeaderIconColor ? "h-5 w-5" : "h-5 w-5 text-warning"}
                  style={featuredHeaderIconColor ? { color: featuredHeaderIconColor } : undefined}
                />
                <h2
                  className="text-lg font-semibold"
                  style={featuredHeaderTextColor ? { color: featuredHeaderTextColor } : undefined}
                >Featured Events</h2>
              </div>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {featuredEvents.map((event) => {
                  const eventTimezone = event.timezone || DEFAULT_TIMEZONE;
                  const timezoneAbbr = getTimezoneAbbr(event.start_date, eventTimezone);
                  const hasUnlimitedCapacity = event.available_seats === 0 || event.available_seats === null;
                  const isComplex = !!event.is_complex;
                  const cheapest = getCheapestPrice(event.pricing_config);
                  const baseDetailUrl = getEventDetailUrl(event);
                  const detailUrl = (event.cta_override_url && event.cta_override_mode !== 'detail_page')
                    ? event.cta_override_url
                    : baseDetailUrl;
                  const isExternalDetailUrl = /^https?:\/\//i.test(detailUrl);
                  const showPricesSetting = Array.isArray(systemSettings)
                    ? systemSettings.find(s => s.setting_key === 'show_event_card_prices')?.setting_value === 'true'
                    : false;

                  return (
                    <Card
                      key={`featured-${isComplex ? 'complex' : 'simple'}-${event.id}`}
                      className="border-slate-200 hover:shadow-lg transition-shadow overflow-hidden"
                      data-testid={`card-featured-event-${event.id}`}
                    >
                      {event.image_url && (
                        <div className="h-48 overflow-hidden bg-slate-100">
                          <img 
                            src={event.image_url} 
                            alt={event.title}
                            className="w-full h-full object-cover"
                            style={event.image_focal_point ? getFocalPointStyle(event.image_focal_point) : undefined}
                          />
                        </div>
                      )}
                      
                      <CardHeader>
                        <div className="flex items-start justify-between gap-2 mb-2 flex-wrap">
                          <CardTitle className="text-lg">{event.title}</CardTitle>
                          {event.program_tag && (
                            <Badge className="bg-purple-100 text-purple-700 border-purple-200 shrink-0">
                              {event.program_tag}
                            </Badge>
                          )}
                          {isComplex && parseEventTypes(event.event_type).map((typeName, etIdx) => (
                            <Badge key={etIdx} variant="secondary" className="shrink-0 text-xs">
                              {typeName}
                            </Badge>
                          ))}
                        </div>
                        {(event.description || event.summary) && (
                          <p className="text-sm text-slate-600 line-clamp-2">{event.description || event.summary}</p>
                        )}
                      </CardHeader>

                      <CardContent className="space-y-3">
                        {event.start_date && (
                          <div className="flex items-center gap-2 text-sm text-slate-600">
                            <Calendar className="w-4 h-4 text-slate-400 shrink-0" />
                            <span>
                              {formatEventDate(event.start_date, eventTimezone)}
                              {isComplex && event.end_date && !event.days_nonconsecutive && ` - ${formatEventDate(event.end_date, eventTimezone)}`}
                            </span>
                          </div>
                        )}

                        {isComplex && event.days_nonconsecutive && event.day_count > 1 && (
                          <div className="flex items-center gap-2 text-sm text-slate-600" data-testid={`text-featured-day-count-${event.id}`}>
                            <CalendarDays className="w-4 h-4 text-slate-400 shrink-0" />
                            <span>{event.day_count} days</span>
                          </div>
                        )}
                        {isComplex && event.days_nonconsecutive && event.day_count > 1 && event.custom_duration_explainer && (
                          <div className="flex items-center gap-2 text-sm text-slate-600" data-testid={`text-featured-duration-explainer-${event.id}`}>
                            <Info className="w-4 h-4 text-slate-400 shrink-0" />
                            <span>{event.custom_duration_explainer}</span>
                          </div>
                        )}

                        {event.start_date && (
                          <div className="flex items-center gap-2 text-sm text-slate-600">
                            <Clock className="w-4 h-4 text-slate-400 shrink-0" />
                            <span>{formatEventTime(event.start_date, eventTimezone)}</span>
                            <span className="text-slate-400 text-xs">({timezoneAbbr})</span>
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
                                {event.available_seats} {isComplex ? 'places' : 'seats'} available
                              </span>
                            ) : (
                              <span className="text-red-600 font-medium">Sold out</span>
                            )}
                          </div>
                        )}

                        {showPricesSetting && cheapest !== null && (
                          <div className="flex items-center gap-2 text-sm">
                            <Ticket className="w-4 h-4 text-slate-400 shrink-0" />
                            <span className="font-medium text-slate-900">
                              {cheapest === 0 ? "Free" : `\u00a3${cheapest.toFixed(2)}`}
                            </span>
                          </div>
                        )}

                        <div className="pt-3 border-t border-slate-100">
                          <TenantCtaButton
                            as={isExternalDetailUrl ? "a" : "link"}
                            href={isExternalDetailUrl ? detailUrl : undefined}
                            to={isExternalDetailUrl ? undefined : detailUrl}
                            rel={isExternalDetailUrl ? "noopener noreferrer" : undefined}
                            className="w-full"
                            fallbackVariant="default"
                            data-testid={`button-featured-view-event-${event.id}`}
                          >
                            View Details
                          </TenantCtaButton>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {events.map((event) => {
              const eventTimezone = event.timezone || DEFAULT_TIMEZONE;
              const timezoneAbbr = getTimezoneAbbr(event.start_date, eventTimezone);
              const hasUnlimitedCapacity = event.available_seats === 0 || event.available_seats === null;
              const isComplex = !!event.is_complex;
              const cheapest = getCheapestPrice(event.pricing_config);
              const baseDetailUrl = getEventDetailUrl(event);
              const detailUrl = (event.cta_override_url && event.cta_override_mode !== 'detail_page')
                ? event.cta_override_url
                : baseDetailUrl;
              const isExternalDetailUrl = /^https?:\/\//i.test(detailUrl);

              return (
                <Card
                  key={`${isComplex ? 'complex' : 'simple'}-${event.id}`}
                  className="border-slate-200 hover:shadow-lg transition-shadow overflow-hidden"
                  data-testid={`card-event-${event.id}`}
                >
                  {event.image_url && (
                    <div className="h-48 overflow-hidden bg-slate-100">
                      <img 
                        src={event.image_url} 
                        alt={event.title}
                        className="w-full h-full object-cover"
                        style={event.image_focal_point ? getFocalPointStyle(event.image_focal_point) : undefined}
                      />
                    </div>
                  )}
                  
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2 mb-2 flex-wrap">
                      <CardTitle className="text-lg">{event.title}</CardTitle>
                      {event.program_tag && (
                        <Badge className="bg-purple-100 text-purple-700 border-purple-200 shrink-0">
                          {event.program_tag}
                        </Badge>
                      )}
                      {isComplex && parseEventTypes(event.event_type).map((typeName, etIdx) => (
                        <Badge key={etIdx} variant="secondary" className="shrink-0 text-xs">
                          {typeName}
                        </Badge>
                      ))}
                    </div>
                    {(event.description || event.summary) && (
                      <p className="text-sm text-slate-600 line-clamp-2">{event.description || event.summary}</p>
                    )}
                  </CardHeader>

                  <CardContent className="space-y-3">
                    {event.start_date && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <Calendar className="w-4 h-4 text-slate-400 shrink-0" />
                        <span>
                          {formatEventDate(event.start_date, eventTimezone)}
                          {isComplex && event.end_date && !event.days_nonconsecutive && ` - ${formatEventDate(event.end_date, eventTimezone)}`}
                        </span>
                      </div>
                    )}

                    {isComplex && event.days_nonconsecutive && event.day_count > 1 && (
                      <div className="flex items-center gap-2 text-sm text-slate-600" data-testid={`text-public-day-count-${event.id}`}>
                        <CalendarDays className="w-4 h-4 text-slate-400 shrink-0" />
                        <span>{event.day_count} days</span>
                      </div>
                    )}
                    {isComplex && event.days_nonconsecutive && event.day_count > 1 && event.custom_duration_explainer && (
                      <div className="flex items-center gap-2 text-sm text-slate-600" data-testid={`text-public-duration-explainer-${event.id}`}>
                        <Info className="w-4 h-4 text-slate-400 shrink-0" />
                        <span>{event.custom_duration_explainer}</span>
                      </div>
                    )}

                    {event.start_date && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <Clock className="w-4 h-4 text-slate-400 shrink-0" />
                        <span>{formatEventTime(event.start_date, eventTimezone)}</span>
                        <span className="text-slate-400 text-xs">({timezoneAbbr})</span>
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
                            {event.available_seats} {isComplex ? 'places' : 'seats'} available
                          </span>
                        ) : (
                          <span className="text-red-600 font-medium">Sold out</span>
                        )}
                      </div>
                    )}

                    {cheapest !== null && (
                      <div className="flex items-center gap-2 text-sm">
                        <Ticket className="w-4 h-4 text-slate-400 shrink-0" />
                        <span className="font-medium text-slate-900">
                          {cheapest === 0 ? "Free" : `\u00a3${cheapest.toFixed(2)}`}
                        </span>
                      </div>
                    )}

                    <div className="pt-3 border-t border-slate-100">
                      <TenantCtaButton
                        as={isExternalDetailUrl ? "a" : "link"}
                        href={isExternalDetailUrl ? detailUrl : undefined}
                        to={isExternalDetailUrl ? undefined : detailUrl}
                        rel={isExternalDetailUrl ? "noopener noreferrer" : undefined}
                        className="w-full"
                        fallbackVariant="default"
                        data-testid={`button-view-event-${event.id}`}
                      >
                        View Details
                      </TenantCtaButton>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          </>
        )}
      </div>
    </div>
  );
}