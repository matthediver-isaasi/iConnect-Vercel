import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Calendar, MapPin, Clock, Users, Search, Loader2, Ticket } from "lucide-react";
import { format, parseISO, isPast } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { publicClient } from "@/api/publicClient";
import { getFocalPointStyle } from "@/components/FocalPointPicker";
import { parseEventTypes } from "@/lib/utils";
import { Link } from "react-router-dom";
import { getSeatStatusLabels } from "@/lib/seatStatusLabels";
import { getTenantCtaLabel, isEventRegistrationClosed, resolveEventCtaLabel } from "@/lib/eventCtaLabel";

const DEFAULT_TIMEZONE = "Europe/London";

const formatEventDate = (dateStr, timezone = DEFAULT_TIMEZONE, formatStr = "MMM d, yyyy") => {
  if (!dateStr) return null;
  try {
    const date = typeof dateStr === 'string' ? parseISO(dateStr) : dateStr;
    return formatInTimeZone(date, timezone, formatStr);
  } catch (e) {
    return format(new Date(dateStr), formatStr);
  }
};

const getCheapestPrice = (pricingConfig) => {
  if (!pricingConfig?.ticket_classes?.length) return null;
  const prices = pricingConfig.ticket_classes
    .map(tc => Number(tc.price))
    .filter(p => Number.isFinite(p));
  if (prices.length === 0) return null;
  return Math.min(...prices);
};

export default function PublicComplexEvents() {
  const [searchQuery, setSearchQuery] = useState("");
  const [showPast, setShowPast] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState("all");

  const { data: allEvents = [], isLoading } = useQuery({
    queryKey: ['public-complex-events'],
    queryFn: async () => await publicClient.listComplexEvents() || [],
    staleTime: 0
  });

  const { data: systemSettings = [] } = useQuery({
    queryKey: ['public-system-settings'],
    queryFn: () => publicClient.listSystemSettings()
  });

  // Tenant-customizable seat-status labels (Event Settings)
  const seatStatusLabels = useMemo(
    () => getSeatStatusLabels(systemSettings, { availableDefault: '{count} places available' }),
    [systemSettings]
  );

  const tenantCtaLabel = useMemo(() => getTenantCtaLabel(systemSettings), [systemSettings]);

  const categories = useMemo(() => {
    const types = new Set();
    allEvents.forEach(e => {
      parseEventTypes(e.event_type).forEach(t => types.add(t));
    });
    return Array.from(types).sort();
  }, [allEvents]);

  const filteredEvents = useMemo(() => {
    let events = allEvents;

    const now = new Date();
    if (showPast) {
      events = events.filter(e => e.end_date ? isPast(parseISO(e.end_date)) : (e.start_date ? isPast(parseISO(e.start_date)) : false));
    } else {
      events = events.filter(e => {
        const endDate = e.end_date ? parseISO(e.end_date) : (e.start_date ? parseISO(e.start_date) : null);
        return !endDate || endDate >= now;
      });
    }

    if (categoryFilter !== "all") {
      events = events.filter(e => parseEventTypes(e.event_type).includes(categoryFilter));
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      events = events.filter(e =>
        e.title?.toLowerCase().includes(q) ||
        e.description?.toLowerCase().includes(q) ||
        e.summary?.toLowerCase().includes(q) ||
        e.location?.toLowerCase().includes(q)
      );
    }

    return events;
  }, [allEvents, showPast, categoryFilter, searchQuery]);

  return (
    <div className="bg-white min-h-screen">
      <div className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white py-20">
        <div className="max-w-7xl mx-auto px-4">
          <h1 className="text-4xl md:text-5xl font-bold mb-6" data-testid="text-page-title">
            Conferences & Multi-Session Events
          </h1>
          <p className="text-xl text-indigo-100 max-w-3xl">
            Explore our multi-track conferences, summits, and multi-day events featuring expert speakers and interactive sessions.
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex flex-wrap items-center gap-3 mb-8">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input
              placeholder="Search events..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              data-testid="input-search-complex-events"
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant={!showPast ? "default" : "outline"}
              size="sm"
              onClick={() => setShowPast(false)}
              data-testid="button-upcoming-events"
            >
              Upcoming
            </Button>
            <Button
              variant={showPast ? "default" : "outline"}
              size="sm"
              onClick={() => setShowPast(true)}
              data-testid="button-past-events"
            >
              Past
            </Button>
          </div>

          {categories.length > 0 && (
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="border border-slate-200 rounded-md px-3 py-2 text-sm bg-white"
              data-testid="select-category-filter"
            >
              <option value="all">All Categories</option>
              {categories.map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
          </div>
        ) : filteredEvents.length === 0 ? (
          <Card className="border-slate-200">
            <CardContent className="p-12 text-center">
              <Calendar className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2" data-testid="text-no-events">
                {showPast ? "No Past Events" : "No Upcoming Events"}
              </h3>
              <p className="text-slate-600">
                {showPast ? "There are no past events to display." : "Check back soon for upcoming conferences and multi-session events."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredEvents.map((event) => {
              const tz = event.timezone || DEFAULT_TIMEZONE;
              const cheapest = getCheapestPrice(event.pricing_config);
              const hasUnlimitedCapacity = event.available_seats === 0 || event.available_seats === null;
              const eventUrl = `/ComplexEventDetail?id=${event.id}`;
              // Resolution order: status label > per-event label > Event Settings default > fallback
              const ctaLabel = resolveEventCtaLabel({
                isRegistrationClosed: isEventRegistrationClosed(event),
                isSoldOut: !hasUnlimitedCapacity && event.available_seats === 0,
                perEventLabel: event.cta_button_label,
                defaultLabel: tenantCtaLabel,
              });

              return (
                <Card
                  key={event.id}
                  className="border-slate-200 hover:shadow-lg transition-shadow overflow-hidden"
                  data-testid={`card-complex-event-${event.id}`}
                >
                  {event.image_url && (
                    <div className="h-48 overflow-hidden bg-slate-100">
                      <img
                        src={event.image_url}
                        alt={event.title}
                        className="w-full h-full object-cover"
                        style={getFocalPointStyle(event.image_focal_point)}
                      />
                    </div>
                  )}

                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <CardTitle className="text-lg">{event.title}</CardTitle>
                      {parseEventTypes(event.event_type).map((typeName, etIdx) => (
                        <Badge key={etIdx} variant="secondary" className="shrink-0 text-xs">
                          {typeName}
                        </Badge>
                      ))}
                    </div>
                    {event.summary && (
                      <p className="text-sm text-slate-600 line-clamp-2">{event.summary}</p>
                    )}
                  </CardHeader>

                  <CardContent className="space-y-3">
                    {event.start_date && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <Calendar className="w-4 h-4 text-slate-400 shrink-0" />
                        <span>
                          {formatEventDate(event.start_date, tz)}
                          {event.end_date && ` - ${formatEventDate(event.end_date, tz)}`}
                        </span>
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
                          <span className="text-green-600 font-medium">{seatStatusLabels.unlimited}</span>
                        ) : event.available_seats > 0 ? (
                          <span className="text-green-600 font-medium">
                            {seatStatusLabels.available(event.available_seats)}
                          </span>
                        ) : (
                          <span className="text-red-600 font-medium">{seatStatusLabels.soldOut}</span>
                        )}
                      </div>
                    )}

                    {cheapest !== null && (
                      <div className="flex items-center gap-2 text-sm">
                        <Ticket className="w-4 h-4 text-slate-400 shrink-0" />
                        <span className="font-medium text-slate-900">
                          {cheapest === 0 ? "Free" : `From \u00a3${cheapest.toFixed(2)}`}
                        </span>
                      </div>
                    )}

                    <div className="pt-3 border-t border-slate-100">
                      {(event.cta_override_url && event.cta_override_mode !== 'detail_page') ? (
                        <a href={event.cta_override_url} rel="noopener noreferrer">
                          <Button className="w-full" data-testid={`button-view-event-${event.id}`}>
                            {ctaLabel}
                          </Button>
                        </a>
                      ) : (
                        <Link to={eventUrl}>
                          <Button className="w-full" data-testid={`button-view-event-${event.id}`}>
                            {ctaLabel}
                          </Button>
                        </Link>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
