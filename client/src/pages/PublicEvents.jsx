import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar, MapPin, Clock, Users } from "lucide-react";
import { format, parseISO } from "date-fns";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import { createPageUrl } from "@/utils";
import { publicClient } from "@/api/publicClient";

const DEFAULT_TIMEZONE = "Europe/London";

// Helper function to format date in event's timezone
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

// Helper function to format time in event's timezone
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

// Helper to get timezone abbreviation for a specific date (handles DST correctly)
const getTimezoneAbbr = (dateStr, timezone = DEFAULT_TIMEZONE) => {
  try {
    // Use the event date to get the correct DST-aware abbreviation
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

// Helper function to check if an event has at least one public ticket class
const hasPublicTickets = (event) => {
  // One-off events have pricing_config with ticket_classes
  if (event.pricing_config?.ticket_classes && Array.isArray(event.pricing_config.ticket_classes)) {
    return event.pricing_config.ticket_classes.some(tc => {
      // New visibility_mode field
      if (tc.visibility_mode) {
        return tc.visibility_mode === 'members_and_public' || tc.visibility_mode === 'public_only';
      }
      // Backwards compatibility: check legacy is_public field
      return tc.is_public === true;
    });
  }
  // Program events (with program_tag) are not shown on public page by default
  return false;
};

export default function PublicEventsPage() {
  const { data: allEvents = [], isLoading } = useQuery({
    queryKey: ['public-events'],
    queryFn: () => publicClient.listEvents(),
    staleTime: 0
  });

  const events = allEvents.filter(hasPublicTickets);

  return (
    <div className="bg-white min-h-screen">
      {/* Hero Section */}
      <div className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-20">
        <div className="max-w-7xl mx-auto px-4">
          <h1 className="text-4xl md:text-5xl font-bold mb-6">Upcoming Events</h1>
          <p className="text-xl text-blue-100 max-w-3xl">
            Discover professional development opportunities, training sessions, and networking events for careers professionals in higher education.
          </p>
        </div>
      </div>

      {/* Events Listing */}
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
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Upcoming Events</h3>
              <p className="text-slate-600 mb-6">
                Check back soon for new professional development opportunities
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {events.map((event) => {
              const eventTimezone = event.timezone || DEFAULT_TIMEZONE;
              // Pass event date to get correct DST-aware abbreviation (GMT vs BST)
              const timezoneAbbr = getTimezoneAbbr(event.start_date, eventTimezone);
              const hasUnlimitedCapacity = event.available_seats === 0 || event.available_seats === null;

              return (
                <Card key={event.id} className="border-slate-200 hover:shadow-lg transition-shadow overflow-hidden">
                  {event.image_url && (
                    <div className="h-48 overflow-hidden bg-slate-100">
                      <img 
                        src={event.image_url} 
                        alt={event.title}
                        className="w-full h-full object-cover"
                      />
                    </div>
                  )}
                  
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <CardTitle className="text-lg">{event.title}</CardTitle>
                      {event.program_tag && (
                        <Badge className="bg-purple-100 text-purple-700 border-purple-200 shrink-0">
                          {event.program_tag}
                        </Badge>
                      )}
                    </div>
                    {event.description && (
                      <p className="text-sm text-slate-600 line-clamp-2">{event.description}</p>
                    )}
                  </CardHeader>

                  <CardContent className="space-y-3">
                    {event.start_date && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <Calendar className="w-4 h-4 text-slate-400" />
                        <span>{formatEventDate(event.start_date, eventTimezone)}</span>
                      </div>
                    )}

                    {event.start_date && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <Clock className="w-4 h-4 text-slate-400" />
                        <span>{formatEventTime(event.start_date, eventTimezone)}</span>
                        <span className="text-slate-400 text-xs">({timezoneAbbr})</span>
                      </div>
                    )}

                    {event.location && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <MapPin className="w-4 h-4 text-slate-400" />
                        <span className="line-clamp-1">{event.location}</span>
                      </div>
                    )}

                    <div className="flex items-center gap-2 text-sm">
                      <Users className="w-4 h-4 text-slate-400" />
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

                    <div className="pt-3 border-t border-slate-100">
                      <Button 
                        className="w-full bg-blue-600 hover:bg-blue-700"
                        onClick={() => window.location.href = createPageUrl('Home')}
                      >
                        Member Login to Book
                      </Button>
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