import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Link } from "react-router-dom";
import { Calendar, Clock, Video, ExternalLink } from "lucide-react";
import { format, parseISO, differenceInDays, differenceInHours, differenceInMinutes, differenceInSeconds, addMinutes } from "date-fns";
import { Button } from "@/components/ui/button";

// Helper to safely parse date strings
const parseEventDate = (dateStr) => {
  if (!dateStr) return null;
  try {
    return typeof dateStr === 'string' ? parseISO(dateStr) : new Date(dateStr);
  } catch {
    return new Date(dateStr);
  }
};

async function apiRequest(url) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

export default function NextEventCountdown({ memberEmail }) {
  const [timeLeft, setTimeLeft] = useState(null);
  const [eventStatus, setEventStatus] = useState('upcoming');
  const [personalizedJoinUrl, setPersonalizedJoinUrl] = useState(null);

  const { data: myBookings = [] } = useQuery({
    queryKey: ['next-event-bookings', memberEmail],
    queryFn: async () => {
      if (!memberEmail) return [];
      return base44.entities.Booking.list({
        filter: { attendee_email: memberEmail }
      });
    },
    enabled: !!memberEmail,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });

  const eventIds = useMemo(() => 
    [...new Set(myBookings.map(b => b.event_id).filter(Boolean))],
    [myBookings]
  );

  const { data: events = [] } = useQuery({
    queryKey: ['next-event-details', eventIds],
    queryFn: async () => {
      if (eventIds.length === 0) return [];
      return base44.entities.Event.list({
        filter: { id: { in: eventIds } }
      });
    },
    enabled: eventIds.length > 0,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });

  const { data: webinars = [] } = useQuery({
    queryKey: ['zoom-webinars-for-countdown'],
    queryFn: () => apiRequest('/api/zoom/webinars'),
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });

  const nextEvent = useMemo(() => {
    if (!events.length) return null;
    
    const now = new Date();
    
    const relevantEvents = events
      .map(event => {
        const startDate = parseEventDate(event.start_date);
        const endDate = event.end_date ? parseEventDate(event.end_date) : addMinutes(startDate, 60);
        
        const webinar = webinars.find(w => 
          w.zoom_webinar_id === event.zoom_webinar_id || 
          w.id === event.zoom_webinar_id
        );
        
        return {
          ...event,
          startDate,
          endDate,
          webinar,
          // Use generic join_url as fallback, but personalized link will be fetched separately
          genericJoinUrl: webinar?.join_url || event.online_url || null
        };
      })
      .filter(event => event.startDate && event.endDate > now)
      .sort((a, b) => a.startDate - b.startDate);

    return relevantEvents[0] || null;
  }, [events, webinars]);

  // Fetch personalized join link when we have a webinar and member email
  useEffect(() => {
    const fetchPersonalizedLink = async () => {
      if (!nextEvent?.webinar?.id || !memberEmail) {
        setPersonalizedJoinUrl(null);
        return;
      }
      
      try {
        const response = await apiRequest(
          `/api/zoom/webinars/${nextEvent.webinar.id}/my-join-link?email=${encodeURIComponent(memberEmail)}`
        );
        if (response.join_url) {
          setPersonalizedJoinUrl(response.join_url);
        } else {
          setPersonalizedJoinUrl(null);
        }
      } catch (error) {
        console.error('[NextEventCountdown] Failed to fetch personalized join link:', error);
        setPersonalizedJoinUrl(null);
      }
    };
    
    fetchPersonalizedLink();
  }, [nextEvent?.webinar?.id, memberEmail]);

  // Use personalized link if available, otherwise fall back to generic
  const effectiveJoinUrl = personalizedJoinUrl || nextEvent?.genericJoinUrl;

  const nextEventId = nextEvent?.id;
  const startTime = nextEvent?.startDate?.getTime();
  const endTime = nextEvent?.endDate?.getTime();

  useEffect(() => {
    if (!nextEventId || !startTime || !endTime) {
      setTimeLeft(null);
      setEventStatus('ended');
      return;
    }

    const calculateTimeLeft = () => {
      const now = Date.now();

      if (now > endTime) {
        setEventStatus('ended');
        setTimeLeft(null);
        return;
      }

      if (now >= startTime && now <= endTime) {
        setEventStatus('live');
        setTimeLeft(null);
        return;
      }

      setEventStatus('upcoming');
      const startDate = new Date(startTime);
      const nowDate = new Date(now);
      
      const days = differenceInDays(startDate, nowDate);
      const hours = differenceInHours(startDate, nowDate) % 24;
      const minutes = differenceInMinutes(startDate, nowDate) % 60;
      const seconds = differenceInSeconds(startDate, nowDate) % 60;

      setTimeLeft({ days, hours, minutes, seconds });
    };

    calculateTimeLeft();
    const timer = setInterval(calculateTimeLeft, 1000);

    return () => clearInterval(timer);
  }, [nextEventId, startTime, endTime]);

  if (!nextEvent || eventStatus === 'ended') {
    return null;
  }

  const formattedDate = format(nextEvent.startDate, "EEE, d MMM");
  const formattedTime = format(nextEvent.startDate, "HH:mm");
  const isOnlineEvent = nextEvent.location?.toLowerCase().includes('online') || effectiveJoinUrl;

  return (
    <div className="px-3 py-2 group-data-[collapsible=icon]:hidden">
      <div className={`rounded-lg p-3 border ${
        eventStatus === 'live' 
          ? 'bg-gradient-to-br from-green-50 to-emerald-50 border-green-200' 
          : 'bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-100'
      }`}>
        <div className="flex items-center gap-2 mb-2">
          {eventStatus === 'live' ? (
            <>
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              <span className="text-xs font-medium text-green-700 uppercase tracking-wide">Live Now</span>
            </>
          ) : (
            <>
              <Clock className="w-4 h-4 text-blue-600" />
              <span className="text-xs font-medium text-blue-700 uppercase tracking-wide">Next Event</span>
            </>
          )}
        </div>
        
        <Link 
          to={`/EventDetails/${nextEvent.id}`}
          className="block hover:opacity-80 transition-opacity"
          data-testid="link-next-event"
        >
          <p className="text-sm font-medium text-slate-900 mb-2 line-clamp-2" data-testid="text-next-event-title">
            {nextEvent.title}
          </p>
        </Link>

        <div className="flex items-center gap-1 text-xs text-slate-600 mb-3">
          <Calendar className="w-3 h-3" />
          <span>{formattedDate} at {formattedTime}</span>
        </div>

        {eventStatus === 'live' && isOnlineEvent && effectiveJoinUrl ? (
          <a
            href={effectiveJoinUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block"
            data-testid="button-join-event"
          >
            <Button 
              className="w-full bg-green-600 hover:bg-green-700 text-white gap-2"
              size="sm"
            >
              <Video className="w-4 h-4" />
              Join Event
              <ExternalLink className="w-3 h-3" />
            </Button>
          </a>
        ) : eventStatus === 'live' ? (
          <div className="bg-green-100 rounded-md p-2 text-center">
            <span className="text-sm font-medium text-green-700">Event is Live!</span>
          </div>
        ) : timeLeft && (
          <div className="grid grid-cols-4 gap-1" data-testid="countdown-timer">
            <div className="bg-white rounded-md p-1.5 text-center shadow-sm">
              <div className="text-lg font-bold text-blue-600" data-testid="countdown-days">{timeLeft.days}</div>
              <div className="text-[10px] text-slate-500 uppercase">Days</div>
            </div>
            <div className="bg-white rounded-md p-1.5 text-center shadow-sm">
              <div className="text-lg font-bold text-blue-600" data-testid="countdown-hours">{String(timeLeft.hours).padStart(2, '0')}</div>
              <div className="text-[10px] text-slate-500 uppercase">Hrs</div>
            </div>
            <div className="bg-white rounded-md p-1.5 text-center shadow-sm">
              <div className="text-lg font-bold text-blue-600" data-testid="countdown-minutes">{String(timeLeft.minutes).padStart(2, '0')}</div>
              <div className="text-[10px] text-slate-500 uppercase">Min</div>
            </div>
            <div className="bg-white rounded-md p-1.5 text-center shadow-sm">
              <div className="text-lg font-bold text-blue-600" data-testid="countdown-seconds">{String(timeLeft.seconds).padStart(2, '0')}</div>
              <div className="text-[10px] text-slate-500 uppercase">Sec</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
