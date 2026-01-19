import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Lock, Calendar, MapPin, Clock, Users, Video, ExternalLink, Share2, Mail, Copy, Check } from "lucide-react";
import { toast, Toaster } from "sonner";
import { format, parseISO } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const DEFAULT_TIMEZONE = "Europe/London";

const formatEventDate = (dateStr, timezone = DEFAULT_TIMEZONE, formatStr = "EEEE, MMMM d, yyyy") => {
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

export default function EmbedEventPage() {
  const { identifier } = useParams();
  const [searchParams] = useSearchParams();
  const [copied, setCopied] = useState(false);
  
  const tenantParam = searchParams.get('tenant');

  const { data: event, isLoading, error } = useQuery({
    queryKey: ['embed-event', identifier, tenantParam],
    queryFn: async () => {
      const url = tenantParam 
        ? `/api/public/event?id=${identifier}&tenant=${encodeURIComponent(tenantParam)}`
        : `/api/public/event?id=${identifier}`;
      const response = await fetch(url);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to load event');
      }
      const data = await response.json();
      return data.event || data;
    },
    enabled: !!identifier
  });

  const notifyParentResize = () => {
    setTimeout(() => {
      const height = document.documentElement.scrollHeight;
      window.parent.postMessage({ type: 'iconn-event-resize', height }, '*');
    }, 100);
  };

  useEffect(() => {
    notifyParentResize();
  }, [event]);

  useEffect(() => {
    const resizeObserver = new ResizeObserver(() => {
      notifyParentResize();
    });
    resizeObserver.observe(document.body);
    return () => resizeObserver.disconnect();
  }, []);

  const handleEventClick = () => {
    if (event?.event_url) {
      window.open(event.event_url, '_blank', 'noopener,noreferrer');
    } else if (tenantParam) {
      window.open(`https://${tenantParam}.iconn.app/EventDetails?id=${event.id}`, '_blank', 'noopener,noreferrer');
    }
  };

  const handleLockedClick = () => {
    if (event?.login_redirect_url) {
      window.top.location.href = event.login_redirect_url;
    } else if (tenantParam) {
      window.top.location.href = `https://${tenantParam}.iconn.app/Login`;
    }
  };

  const handleShare = async (platform) => {
    const url = encodeURIComponent(event.event_url || window.location.href);
    const title = encodeURIComponent(event.title);
    const description = encodeURIComponent(event.summary || '');

    switch (platform) {
      case 'x':
        window.open(`https://twitter.com/intent/tweet?text=${title}&url=${url}`, '_blank', 'noopener,noreferrer');
        break;
      case 'linkedin':
        window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${url}`, '_blank', 'noopener,noreferrer');
        break;
      case 'email':
        window.location.href = `mailto:?subject=${title}&body=${description}%0A%0A${url}`;
        break;
      case 'copy':
        try {
          await navigator.clipboard.writeText(event.event_url || window.location.href);
          setCopied(true);
          toast.success('Link copied to clipboard');
          setTimeout(() => setCopied(false), 2000);
        } catch (err) {
          toast.error('Failed to copy link');
        }
        break;
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[200px] p-4" data-testid="embed-event-loading">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="flex items-center justify-center min-h-[200px] p-4" data-testid="embed-event-error">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <p className="text-center text-muted-foreground">
              {error?.message || 'Event not found or no longer available'}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const eventTimezone = event.timezone || DEFAULT_TIMEZONE;
  const timezoneAbbr = getTimezoneAbbr(event.start_date, eventTimezone);
  const isOnline = event.is_online || event.zoom_webinar_id || event.zoom_meeting_id;
  const isTBC = event.status === 'tbc';

  return (
    <div className="p-4" data-testid="embed-event-container">
      <Toaster />
      <Card className="w-full overflow-hidden" data-testid={`embed-event-${event.id}`}>
        {event.image_url && (
          <>
            <div className="h-48 overflow-hidden bg-slate-100 relative">
              <img 
                src={event.image_url} 
                alt={event.title}
                className="w-full h-full object-cover"
                data-testid="event-image"
              />
              {isTBC && (
                <Badge className="absolute top-3 right-3 bg-amber-500">
                  Date TBC
                </Badge>
              )}
            </div>
            <div className="w-full h-[3px] bg-purple-800"></div>
          </>
        )}
        
        <CardHeader className="pb-3">
          <CardTitle className="text-lg line-clamp-2" data-testid="event-title">
            {event.title}
          </CardTitle>
          
          {!isTBC && event.start_date && (
            <div className="space-y-1 mt-2">
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <Calendar className="w-4 h-4 text-slate-500" />
                <span data-testid="event-date">
                  {formatEventDate(event.start_date, eventTimezone)}
                </span>
              </div>
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <Clock className="w-4 h-4 text-slate-500" />
                <span data-testid="event-time">
                  {formatEventTime(event.start_date, eventTimezone)}
                  {event.end_date && ` - ${formatEventTime(event.end_date, eventTimezone)}`}
                  {` ${timezoneAbbr}`}
                </span>
              </div>
            </div>
          )}

          {isTBC && (
            <div className="flex items-center gap-2 text-sm text-amber-600 mt-2">
              <Calendar className="w-4 h-4" />
              <span data-testid="event-tbc">Date to be confirmed</span>
            </div>
          )}
          
          <div className="flex items-center gap-2 text-sm text-slate-600 mt-1">
            {isOnline ? (
              <>
                <Video className="w-4 h-4 text-slate-500" />
                <span data-testid="event-location">Online Event</span>
              </>
            ) : event.location ? (
              <>
                <MapPin className="w-4 h-4 text-slate-500" />
                <span data-testid="event-location">{event.location}</span>
              </>
            ) : null}
          </div>
          
          {event.summary && (
            <p className="text-sm text-slate-600 mt-2 line-clamp-3" data-testid="event-summary">
              {event.summary}
            </p>
          )}

          {event.available_seats > 0 && (
            <div className="flex items-center gap-2 text-xs text-slate-500 mt-2">
              <Users className="w-3 h-3" />
              <span data-testid="event-capacity">{event.available_seats} seats available</span>
            </div>
          )}
        </CardHeader>

        <CardContent className="pt-0 pb-4">
          {event.is_locked ? (
            <Button 
              onClick={handleLockedClick}
              className="w-full bg-slate-600 hover:bg-slate-700"
              data-testid="button-login-required"
            >
              <Lock className="w-4 h-4 mr-2" />
              Member login required
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button 
                onClick={handleEventClick}
                className="flex-1 bg-blue-600 hover:bg-blue-700"
                data-testid="button-event-cta"
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                View Event Details
              </Button>
              
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" data-testid="button-share">
                    <Share2 className="w-4 h-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => handleShare('x')} className="cursor-pointer">
                    <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                    </svg>
                    Share on X
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleShare('linkedin')} className="cursor-pointer">
                    <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
                    </svg>
                    Share on LinkedIn
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleShare('email')} className="cursor-pointer">
                    <Mail className="w-4 h-4 mr-2" />
                    Share via Email
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleShare('copy')} className="cursor-pointer">
                    {copied ? <Check className="w-4 h-4 mr-2 text-green-600" /> : <Copy className="w-4 h-4 mr-2" />}
                    {copied ? 'Copied!' : 'Copy Link'}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
