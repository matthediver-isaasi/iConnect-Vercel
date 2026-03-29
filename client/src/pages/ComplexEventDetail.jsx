import { useState, useMemo, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Calendar, MapPin, Clock, Users, ArrowLeft, Ticket, Loader2,
  Video, User, Mic, AlertCircle, Monitor, Building2,
  Plus, Trash2, Layers, Lock, UserPlus, X, ShoppingCart, Mail
} from "lucide-react";
import ColleagueSelector from "@/components/booking/ColleagueSelector";
import { format, parseISO, isSameDay } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import DOMPurify from "dompurify";
import { publicClient } from "@/api/publicClient";
import { getFocalPointStyle } from "@/components/FocalPointPicker";
import { getEffectiveTicketPrice } from "@/lib/ticketPricing";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import PaymentOptions from "@/components/booking/PaymentOptions";

const DEFAULT_TIMEZONE = "Europe/London";

const FALLBACK_TRACK_COLORS = [
  { accent: "#3b82f6" },
  { accent: "#10b981" },
  { accent: "#f59e0b" },
  { accent: "#8b5cf6" },
  { accent: "#f43f5e" },
  { accent: "#06b6d4" },
  { accent: "#f97316" },
  { accent: "#6366f1" },
];

function buildTrackColorStyles(hex) {
  if (!hex) return null;
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return {
    accent: hex,
    bgStyle: { backgroundColor: `rgba(${r},${g},${b},0.12)` },
    lightStyle: { backgroundColor: `rgba(${r},${g},${b},0.06)` },
    borderStyle: { borderColor: `rgba(${r},${g},${b},0.35)` },
    textStyle: { color: hex },
    dotStyle: { backgroundColor: hex },
  };
}

const formatTime = (dateStr, timezone = DEFAULT_TIMEZONE) => {
  if (!dateStr) return "";
  try {
    const date = typeof dateStr === 'string' ? parseISO(dateStr) : dateStr;
    return formatInTimeZone(date, timezone, "h:mm a");
  } catch {
    return format(new Date(dateStr), "h:mm a");
  }
};

const formatDate = (dateStr, timezone = DEFAULT_TIMEZONE, formatStr = "EEEE, MMMM d, yyyy") => {
  if (!dateStr) return "";
  try {
    const date = typeof dateStr === 'string' ? parseISO(dateStr) : dateStr;
    return formatInTimeZone(date, timezone, formatStr);
  } catch {
    return format(new Date(dateStr), formatStr);
  }
};

const formatDateShort = (dateStr, timezone = DEFAULT_TIMEZONE) => {
  return formatDate(dateStr, timezone, "MMM d");
};

function TrackTicketButtons({ trackColorMap, eventTracks, onSeeTickets }) {
  const trackEntries = Object.entries(trackColorMap);
  if (trackEntries.length === 0) return null;

  const trackNameToId = {};
  (eventTracks || []).forEach(t => { if (t.name) trackNameToId[t.name] = String(t.id); });

  return (
    <div className="flex flex-wrap gap-2" data-testid="track-ticket-buttons">
      {trackEntries.map(([trackName, colors]) => {
        const trackId = trackNameToId[trackName];
        return (
          <Button
            key={trackName}
            variant="outline"
            size="sm"
            className="gap-1.5"
            style={{
              borderColor: colors?.accent || undefined,
              color: colors?.accent || undefined,
            }}
            onClick={() => onSeeTickets(trackName, trackId)}
            disabled={!trackId}
            data-testid={`button-see-tickets-${trackName}`}
          >
            <Ticket className="w-3.5 h-3.5" />
            {trackName} — See Tickets
          </Button>
        );
      })}
    </div>
  );
}

function ScheduleGrid({ sessions, timezone, trackColorMap, onSeeTickets, eventTracks }) {
  const sessionsByDay = useMemo(() => {
    const days = {};
    sessions.forEach(session => {
      if (!session.start_time) return;
      const dateKey = formatDate(session.start_time, timezone, "yyyy-MM-dd");
      if (!days[dateKey]) {
        days[dateKey] = { date: session.start_time, sessions: [] };
      }
      days[dateKey].sessions.push(session);
    });
    return Object.values(days).sort((a, b) => new Date(a.date) - new Date(b.date));
  }, [sessions, timezone]);

  const allTracks = useMemo(() => {
    const trackSet = new Set();
    sessions.forEach(s => {
      const names = s.track_names || (s.track_name ? [s.track_name] : []);
      names.forEach(n => trackSet.add(n));
    });
    return Array.from(trackSet).sort();
  }, [sessions]);

  if (sessionsByDay.length === 0) return null;

  const hasMultipleTracks = allTracks.length > 0;

  return (
    <div className="space-y-8">
      {hasMultipleTracks && onSeeTickets && (
        <TrackTicketButtons trackColorMap={trackColorMap} eventTracks={eventTracks} onSeeTickets={onSeeTickets} />
      )}
      {sessionsByDay.map((day, dayIndex) => {
        const dayTracks = new Set();
        day.sessions.forEach(s => {
          const names = s.track_names || (s.track_name ? [s.track_name] : []);
          names.forEach(n => dayTracks.add(n));
        });
        const tracks = allTracks.filter(t => dayTracks.has(t));
        const hasUntracked = day.sessions.some(s => {
          const names = s.track_names || (s.track_name ? [s.track_name] : []);
          return names.length === 0;
        });

        const timeSlots = [];
        const slotMap = {};
        day.sessions
          .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
          .forEach(session => {
            const timeKey = formatTime(session.start_time, timezone);
            if (!slotMap[timeKey]) {
              slotMap[timeKey] = { time: timeKey, startTime: session.start_time, sessions: [] };
              timeSlots.push(slotMap[timeKey]);
            }
            slotMap[timeKey].sessions.push(session);
          });

        return (
          <div key={dayIndex} data-testid={`schedule-day-${dayIndex}`}>
            <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
              <Calendar className="w-5 h-5 text-indigo-600" />
              {formatDate(day.date, timezone)}
            </h3>

            <div className="overflow-x-auto">
              <div className="min-w-[600px]">
                {(tracks.length > 0) && (
                  <div className="grid gap-1 mb-2" style={{ gridTemplateColumns: `100px repeat(${tracks.length + (hasUntracked ? 1 : 0)}, 1fr)` }}>
                    <div className="text-xs font-medium text-slate-500 uppercase tracking-wider p-2">Time</div>
                    {tracks.map(track => {
                      const colors = trackColorMap[track];
                      const hasCustom = colors?.bgStyle;
                      return (
                        <div
                          key={track}
                          className={`text-xs font-semibold p-2 rounded-md text-center ${hasCustom ? '' : 'bg-slate-100 text-slate-700'}`}
                          style={hasCustom ? { ...colors.bgStyle, ...colors.textStyle } : undefined}
                          data-testid={`track-header-${track}`}
                        >
                          {track}
                        </div>
                      );
                    })}
                    {hasUntracked && (
                      <div className="text-xs font-semibold p-2 rounded-md text-center bg-slate-100 text-slate-700">
                        General
                      </div>
                    )}
                  </div>
                )}

                {timeSlots.map((slot, slotIndex) => {
                  if (tracks.length === 0) {
                    return (
                      <div key={slotIndex} className="mb-2">
                        {slot.sessions.map(session => (
                          <SessionCard key={session.id} session={session} timezone={timezone} colors={trackColorMap[session.track_name]} />
                        ))}
                      </div>
                    );
                  }

                  return (
                    <div
                      key={slotIndex}
                      className="grid gap-1 mb-1"
                      style={{ gridTemplateColumns: `100px repeat(${tracks.length + (hasUntracked ? 1 : 0)}, 1fr)` }}
                    >
                      <div className="text-sm font-medium text-slate-600 p-2 flex items-start pt-3">
                        {slot.time}
                      </div>
                      {tracks.map(track => {
                        const trackSession = slot.sessions.find(s => {
                          const names = s.track_names || (s.track_name ? [s.track_name] : []);
                          return names.includes(track);
                        });
                        const colors = trackColorMap[track];
                        if (!trackSession) {
                          return <div key={track} className="p-1" />;
                        }
                        const isMultiTrack = (trackSession.track_names || []).length > 1;
                        return (
                          <SessionCard key={`${trackSession.id}-${track}`} session={trackSession} timezone={timezone} colors={colors} isMultiTrack={isMultiTrack} />
                        );
                      })}
                      {hasUntracked && (() => {
                        const untrackedSession = slot.sessions.find(s => {
                          const names = s.track_names || (s.track_name ? [s.track_name] : []);
                          return names.length === 0;
                        });
                        if (!untrackedSession) return <div className="p-1" />;
                        return <SessionCard session={untrackedSession} timezone={timezone} colors={null} />;
                      })()}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
      {hasMultipleTracks && onSeeTickets && (
        <TrackTicketButtons trackColorMap={trackColorMap} eventTracks={eventTracks} onSeeTickets={onSeeTickets} />
      )}
    </div>
  );
}

function SessionCard({ session, timezone, colors, isMultiTrack = false }) {
  const hasCustomColors = colors?.lightStyle;
  const fallbackClass = "bg-slate-50 border-slate-300";

  return (
    <div
      className={`p-3 rounded-md border space-y-1 ${hasCustomColors ? '' : fallbackClass}`}
      style={hasCustomColors ? { ...colors.lightStyle, ...colors.borderStyle } : undefined}
      data-testid={`session-card-${session.id}`}
    >
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-sm text-slate-900">{session.title}</span>
        {isMultiTrack && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            <Layers className="h-2.5 w-2.5 mr-0.5" />Multi-Track
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-slate-600">
        <Clock className="w-3 h-3" />
        <span>
          {formatTime(session.start_time, timezone)}
          {session.end_time && ` - ${formatTime(session.end_time, timezone)}`}
        </span>
        {session.duration_minutes && (
          <span className="text-slate-400">({session.duration_minutes} min)</span>
        )}
      </div>
      {session.description && (
        <p className="text-xs text-slate-500 line-clamp-2">{session.description}</p>
      )}
      <div className="flex items-center gap-1 flex-wrap pt-1">
        {session.delivery_mode === 'virtual' && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            <Monitor className="h-2.5 w-2.5 mr-0.5" />Virtual
          </Badge>
        )}
        {session.delivery_mode === 'hybrid' && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            <Video className="h-2.5 w-2.5 mr-0.5" />Hybrid
          </Badge>
        )}
        {session.delivery_mode === 'in_person' && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            <Building2 className="h-2.5 w-2.5 mr-0.5" />In-Person
          </Badge>
        )}
      </div>
    </div>
  );
}

function TrackAccessIndicator({ ticket, tracks }) {
  if (!tracks?.length) return null;

  const trackMap = {};
  tracks.forEach(t => { trackMap[String(t.id)] = t; });

  if (ticket.all_tracks) {
    return (
      <div className="flex items-center gap-1 mt-1.5">
        <Layers className="w-3 h-3 text-slate-400 shrink-0" />
        <span className="text-[11px] text-slate-500">Access to all tracks</span>
      </div>
    );
  }

  const linkedIds = ticket.linked_track_ids || [];
  if (linkedIds.length === 0) return null;

  const linkedTracks = linkedIds.map(id => trackMap[String(id)]).filter(Boolean);
  if (linkedTracks.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
      <Layers className="w-3 h-3 text-slate-400 shrink-0" />
      {linkedTracks.map(t => {
        const colorStyles = t.colour ? buildTrackColorStyles(t.colour) : null;
        return (
          <span
            key={t.id}
            className="inline-flex items-center gap-1 text-[11px] text-slate-600"
          >
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={colorStyles?.dotStyle || { backgroundColor: '#94a3b8' }}
            />
            {t.name}
          </span>
        );
      })}
    </div>
  );
}

function AddAttendeeModal({ open, onOpenChange, ticketClass, memberInfo, organizationInfo, onAddAttendee, existingEmails }) {
  const [externalFirstName, setExternalFirstName] = useState('');
  const [externalLastName, setExternalLastName] = useState('');
  const [externalEmail, setExternalEmail] = useState('');
  const [externalOrganization, setExternalOrganization] = useState('');

  const resetExternal = () => {
    setExternalFirstName('');
    setExternalLastName('');
    setExternalEmail('');
    setExternalOrganization('');
  };

  const isSelfAlreadyAdded = existingEmails.includes((memberInfo?.email || '').toLowerCase());

  const handleRegisterSelf = () => {
    if (!memberInfo) return;
    if (isSelfAlreadyAdded) {
      toast.info('You are already registered');
      return;
    }
    onAddAttendee({
      first_name: memberInfo.first_name || '',
      last_name: memberInfo.last_name || '',
      email: memberInfo.email || '',
      organization: organizationInfo?.name || '',
      isSelf: true
    });
    onOpenChange(false);
    toast.success('You have been added as an attendee');
  };

  const handleColleagueSelect = (colleague) => {
    const email = (colleague.email || '').toLowerCase();
    if (existingEmails.includes(email)) {
      toast.error('This person is already registered');
      return;
    }
    onAddAttendee({
      first_name: colleague.first_name || '',
      last_name: colleague.last_name || '',
      email: colleague.email || '',
      organization: organizationInfo?.name || '',
      isSelf: false
    });
    onOpenChange(false);
    toast.success(`${colleague.first_name} ${colleague.last_name} added`);
  };

  const handleExternalSubmit = () => {
    if (!externalEmail || !externalEmail.includes('@')) {
      toast.error('Please enter a valid email address');
      return;
    }
    if (!externalFirstName.trim() || !externalLastName.trim()) {
      toast.error('Please enter first and last name');
      return;
    }
    const email = externalEmail.toLowerCase().trim();
    if (existingEmails.includes(email)) {
      toast.error('This person is already registered');
      return;
    }
    onAddAttendee({
      first_name: externalFirstName.trim(),
      last_name: externalLastName.trim(),
      email: email,
      organization: externalOrganization.trim(),
      isSelf: false
    });
    resetExternal();
    onOpenChange(false);
    toast.success(`${externalFirstName.trim()} ${externalLastName.trim()} added`);
  };

  const ticketRoleIds = ticketClass?.role_ids || [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-indigo-600" />
            Add Attendee
          </DialogTitle>
          <DialogDescription>
            {ticketClass?.name ? `Adding attendee for: ${ticketClass.name}` : 'Add an attendee to your booking'}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue={memberInfo ? "self" : "external"} className="mt-2">
          <TabsList className="w-full">
            {memberInfo && <TabsTrigger value="self" className="flex-1" data-testid="tab-self">Myself</TabsTrigger>}
            {memberInfo && organizationInfo && (
              <TabsTrigger value="colleague" className="flex-1" data-testid="tab-colleague">Colleague</TabsTrigger>
            )}
            <TabsTrigger value="external" className="flex-1" data-testid="tab-external">Other</TabsTrigger>
          </TabsList>

          {memberInfo && (
            <TabsContent value="self" className="space-y-4 mt-4">
              <div className="p-3 rounded-md border border-slate-200 space-y-1">
                <div className="font-medium text-sm text-slate-900">{memberInfo.first_name} {memberInfo.last_name}</div>
                <div className="text-xs text-slate-500">{memberInfo.email}</div>
                {organizationInfo?.name && <div className="text-xs text-slate-500">{organizationInfo.name}</div>}
              </div>
              <Button
                onClick={handleRegisterSelf}
                disabled={isSelfAlreadyAdded}
                className="w-full"
                data-testid="button-register-myself"
              >
                <User className="w-4 h-4 mr-1.5" />
                {isSelfAlreadyAdded ? 'Already Added' : 'Register Myself'}
              </Button>
            </TabsContent>
          )}

          {memberInfo && organizationInfo && (
            <TabsContent value="colleague" className="space-y-4 mt-4">
              <ColleagueSelector
                organizationId={organizationInfo.id}
                onSelect={handleColleagueSelect}
                memberInfo={memberInfo}
                ticketRoleIds={ticketRoleIds}
              />
            </TabsContent>
          )}

          <TabsContent value="external" className="space-y-3 mt-4">
            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder="First Name *"
                value={externalFirstName}
                onChange={(e) => setExternalFirstName(e.target.value)}
                data-testid="input-external-first-name"
              />
              <Input
                placeholder="Last Name *"
                value={externalLastName}
                onChange={(e) => setExternalLastName(e.target.value)}
                data-testid="input-external-last-name"
              />
            </div>
            <Input
              type="email"
              placeholder="Email *"
              value={externalEmail}
              onChange={(e) => setExternalEmail(e.target.value)}
              data-testid="input-external-email"
            />
            <Input
              placeholder="Organisation (optional)"
              value={externalOrganization}
              onChange={(e) => setExternalOrganization(e.target.value)}
              data-testid="input-external-org"
            />
            <Button
              onClick={handleExternalSubmit}
              className="w-full"
              data-testid="button-add-external"
            >
              <Mail className="w-4 h-4 mr-1.5" />
              Add Attendee
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function CartSummary({ cart, ticketClasses, onRemoveAttendee }) {
  const entries = Object.entries(cart).filter(([, item]) => item.attendees.length > 0);
  if (entries.length === 0) return null;

  const totalAttendees = entries.reduce((sum, [, item]) => sum + item.attendees.length, 0);

  return (
    <div className="space-y-3" data-testid="cart-summary">
      <div className="flex items-center gap-2">
        <ShoppingCart className="w-4 h-4 text-indigo-600" />
        <Label className="text-sm font-medium">
          Your Cart ({totalAttendees} attendee{totalAttendees !== 1 ? 's' : ''})
        </Label>
      </div>
      {entries.map(([ticketClassId, item]) => (
        <div key={ticketClassId} className="space-y-1.5">
          <div className="text-xs font-medium text-slate-600 flex items-center gap-1.5">
            <Ticket className="w-3 h-3" />
            {item.ticketClass?.name || 'Ticket'}
            <Badge variant="secondary" className="text-[10px] ml-auto">
              {item.attendees.length}
            </Badge>
          </div>
          {item.attendees.map((attendee, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-2 p-2 rounded-md bg-slate-50 border border-slate-100"
              data-testid={`cart-attendee-${ticketClassId}-${i}`}
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-800 truncate">
                  {attendee.first_name} {attendee.last_name}
                  {attendee.isSelf && <span className="text-indigo-600 text-xs ml-1">(you)</span>}
                </div>
                <div className="text-xs text-slate-500 truncate">{attendee.email}</div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={() => onRemoveAttendee(ticketClassId, i)}
                data-testid={`button-remove-cart-attendee-${ticketClassId}-${i}`}
              >
                <X className="w-3.5 h-3.5 text-slate-400" />
              </Button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function BookingSection({ event, sessions, memberInfo, organizationInfo, filterTrackId, layout = 'sidebar', onBookingComplete }) {
  const [cart, setCart] = useState({});
  const [attendeeModalOpen, setAttendeeModalOpen] = useState(false);
  const [modalTicketClassId, setModalTicketClassId] = useState(null);

  const pricingConfig = useMemo(() => {
    if (!event?.pricing_config) return null;
    let parsed = event.pricing_config;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { return null; }
    }
    return parsed;
  }, [event]);

  const ticketClasses = useMemo(() => {
    if (!pricingConfig?.ticket_classes?.length) return [];

    let filtered = pricingConfig.ticket_classes;

    if (filterTrackId) {
      filtered = filtered.filter(tc => {
        if (tc.all_tracks) return true;
        const linkedIds = (tc.linked_track_ids || []).map(String);
        return linkedIds.includes(String(filterTrackId));
      });
    }

    return filtered.map(tc => ({
      ...tc,
      id: String(tc.id),
      price: Number(tc.price) || 0
    }));
  }, [pricingConfig, filterTrackId]);

  const isGuest = !memberInfo;

  const getTicketVisibility = (tc) => {
    if (tc.visibility_mode) return tc.visibility_mode;
    if (tc.is_public === true) return 'members_and_public';
    if (tc.is_public === false) return 'members_only';
    return 'members_and_public';
  };

  const isTicketRestricted = (tc) => {
    const vis = getTicketVisibility(tc);
    if (isGuest) return vis === 'members_only';
    return vis === 'public_only';
  };

  const allExistingEmails = useMemo(() => {
    const emails = [];
    Object.values(cart).forEach(item => {
      item.attendees.forEach(a => {
        if (a.email) emails.push(a.email.toLowerCase());
      });
    });
    return emails;
  }, [cart]);

  const handleOpenAttendeeModal = useCallback((ticketClassId) => {
    setModalTicketClassId(ticketClassId);
    setAttendeeModalOpen(true);
  }, []);

  const handleAddAttendee = useCallback((attendee) => {
    if (!modalTicketClassId) return;
    setCart(prev => {
      const tc = ticketClasses.find(t => t.id === modalTicketClassId);
      const existing = prev[modalTicketClassId] || { ticketClass: tc, attendees: [] };
      return {
        ...prev,
        [modalTicketClassId]: {
          ...existing,
          ticketClass: tc,
          attendees: [...existing.attendees, attendee]
        }
      };
    });
  }, [modalTicketClassId, ticketClasses]);

  const handleRemoveAttendee = useCallback((ticketClassId, attendeeIndex) => {
    setCart(prev => {
      const existing = prev[ticketClassId];
      if (!existing) return prev;
      const updated = { ...existing, attendees: existing.attendees.filter((_, i) => i !== attendeeIndex) };
      if (updated.attendees.length === 0) {
        const next = { ...prev };
        delete next[ticketClassId];
        return next;
      }
      return { ...prev, [ticketClassId]: updated };
    });
  }, []);

  const flatAttendees = useMemo(() => {
    const result = [];
    Object.values(cart).forEach(item => {
      item.attendees.forEach(a => result.push(a));
    });
    return result;
  }, [cart]);

  const totalAttendeeCount = flatAttendees.length;

  const cartItems = useMemo(() => {
    return Object.entries(cart)
      .filter(([, item]) => item.attendees.length > 0)
      .map(([ticketClassId, item]) => {
        const tc = item.ticketClass;
        const ep = tc ? getEffectiveTicketPrice(tc) : { price: 0, isEarlyBird: false };
        return {
          ticketClassId,
          ticketClass: tc,
          attendees: item.attendees,
          unitPrice: ep.price,
          subtotal: ep.price * item.attendees.length
        };
      });
  }, [cart]);

  const grandTotal = useMemo(() => {
    return cartItems.reduce((sum, item) => sum + item.subtotal, 0);
  }, [cartItems]);

  const selectedTicketForModal = useMemo(() => {
    return ticketClasses.find(tc => tc.id === modalTicketClassId) || null;
  }, [ticketClasses, modalTicketClassId]);

  const firstCartTicketClass = useMemo(() => {
    if (cartItems.length === 0) return ticketClasses[0] || null;
    return cartItems[0].ticketClass || null;
  }, [cartItems, ticketClasses]);

  const complexEventApi = useMemo(() => ({
    createPaymentIntent: (data) => {
      const items = cartItems.map(ci => ({
        ticket_class_id: ci.ticketClassId,
        attendee_count: ci.attendees.length
      }));
      return publicClient.createComplexEventPaymentIntent({
        event_id: event.id,
        items
      });
    },
    submitBooking: (data) => {
      const items = cartItems.map(ci => ({
        ticket_class_id: ci.ticketClassId,
        attendees: ci.attendees.map(a => ({
          email: (a.email || '').toLowerCase().trim(),
          first_name: (a.first_name || '').trim(),
          last_name: (a.last_name || '').trim(),
          organization: (a.organization || '').trim(),
          phone: (a.phone || '').trim(),
          job_title: (a.job_title || '').trim()
        }))
      }));
      return publicClient.submitComplexEventBooking({
        event_id: event.id,
        items,
        payment_method: data.payment_method,
        stripe_payment_intent_id: data.stripe_payment_intent_id || null
      });
    },
  }), [cartItems, event]);

  const paymentOptionsEvent = useMemo(() => ({
    ...event,
    event_type: 'one_off',
    ticket_classes: ticketClasses,
  }), [event, ticketClasses]);

  const oneOffCostDetails = useMemo(() => ({
    ticketPrice: cartItems.length === 1 ? cartItems[0].unitPrice : grandTotal / Math.max(totalAttendeeCount, 1),
    attendeeCount: totalAttendeeCount,
    totalCost: grandTotal,
    freeTickets: 0,
    discount: 0,
  }), [cartItems, grandTotal, totalAttendeeCount]);

  const registrationClosed = event.registration_closes_at && new Date(event.registration_closes_at) < new Date();

  if (registrationClosed) {
    return (
      <Card className="border-slate-200">
        <CardContent className="p-6 text-center">
          <AlertCircle className="w-10 h-10 text-slate-400 mx-auto mb-3" />
          <h3 className="font-semibold text-slate-700">Registration Closed</h3>
          <p className="text-sm text-slate-500 mt-1">Registration for this event is no longer available.</p>
        </CardContent>
      </Card>
    );
  }

  const eventTracks = event?.tracks || [];

  const ticketCards = (
    <div className="space-y-3">
      {ticketClasses.length > 0 && (
        <Label className="text-sm font-medium">Tickets</Label>
      )}
      {ticketClasses.map(tc => {
        const tcPrice = getEffectiveTicketPrice(tc);
        const restricted = isTicketRestricted(tc);
        const cartEntry = cart[tc.id];
        const count = cartEntry?.attendees?.length || 0;

        return (
          <div
            key={tc.id}
            className={`p-3 rounded-md border transition-colors ${count > 0 ? 'border-indigo-300 bg-indigo-50/50' : 'border-slate-200'}`}
            data-testid={`ticket-class-${tc.id}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <span className="font-medium text-sm text-slate-900 flex items-center gap-2 flex-wrap">
                  {tc.name}
                  {restricted && (
                    <Badge variant="secondary" className="text-xs bg-slate-100 text-slate-600">
                      <Lock className="w-3 h-3 mr-1" />
                      {isGuest ? 'Members Only' : 'Public Only'}
                    </Badge>
                  )}
                  {tc.is_group_ticket && tc.group_size > 1 && (
                    <Badge variant="secondary" className="text-xs">
                      <Users className="w-3 h-3 mr-1" />
                      Group ({tc.group_size})
                    </Badge>
                  )}
                  {tcPrice.isEarlyBird && (
                    <Badge variant="secondary" className="text-xs bg-amber-50 text-amber-700 border-amber-200">
                      Early Bird
                    </Badge>
                  )}
                </span>
                {tc.description && (
                  <p className="text-xs text-slate-500 mt-0.5">{tc.description}</p>
                )}
                <TrackAccessIndicator ticket={tc} tracks={eventTracks} />
              </div>
              <div className="flex flex-col items-end gap-1.5 shrink-0">
                <div className="text-base font-semibold text-slate-900">
                  {tcPrice.price === 0 ? 'Free' : `\u00a3${tcPrice.price.toFixed(2)}`}
                </div>
                {tcPrice.isEarlyBird && (
                  <div className="text-xs text-slate-400 line-through">
                    {'\u00a3'}{tcPrice.standardPrice.toFixed(2)}
                  </div>
                )}
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleOpenAttendeeModal(tc.id)}
                disabled={restricted}
                data-testid={`button-add-attendee-${tc.id}`}
              >
                <UserPlus className="w-3.5 h-3.5 mr-1" />
                Add Attendee
              </Button>
              {count > 0 && (
                <Badge className="bg-indigo-600 text-white">
                  {count} added
                </Badge>
              )}
            </div>
          </div>
        );
      })}

      {ticketClasses.length === 0 && (
        <p className="text-sm text-center text-slate-500">
          {filterTrackId ? 'No tickets are available for this track.' : 'No tickets are currently available for public registration.'}
        </p>
      )}
    </div>
  );

  const paymentOptionsSection = totalAttendeeCount > 0 ? (
    <PaymentOptions
      event={paymentOptionsEvent}
      memberInfo={memberInfo}
      organizationInfo={organizationInfo}
      attendees={flatAttendees}
      registrationMode="colleagues"
      selectedTicketClass={firstCartTicketClass}
      ticketPrice={oneOffCostDetails.ticketPrice}
      totalCost={grandTotal}
      oneOffCostDetails={oneOffCostDetails}
      isComplexEvent={true}
      complexEventApi={complexEventApi}
      onComplexBookingComplete={onBookingComplete}
      renderAsCard={false}
    />
  ) : null;

  if (layout === 'drawer') {
    return (
      <div className="space-y-6" data-testid="booking-section-drawer">
        <div className="space-y-6">
          <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <Ticket className="w-5 h-5 text-indigo-600" />
            Tickets
          </h3>
          {ticketCards}
        </div>
        <CartSummary cart={cart} ticketClasses={ticketClasses} onRemoveAttendee={handleRemoveAttendee} />
        {paymentOptionsSection}

        <AddAttendeeModal
          open={attendeeModalOpen}
          onOpenChange={setAttendeeModalOpen}
          ticketClass={selectedTicketForModal}
          memberInfo={memberInfo}
          organizationInfo={organizationInfo}
          onAddAttendee={handleAddAttendee}
          existingEmails={allExistingEmails}
        />
      </div>
    );
  }

  return (
    <Card className="border-slate-200" data-testid="booking-section">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Ticket className="w-5 h-5 text-indigo-600" />
          Register
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {ticketCards}
        <CartSummary cart={cart} ticketClasses={ticketClasses} onRemoveAttendee={handleRemoveAttendee} />
        {paymentOptionsSection}
      </CardContent>

      <AddAttendeeModal
        open={attendeeModalOpen}
        onOpenChange={setAttendeeModalOpen}
        ticketClass={selectedTicketForModal}
        memberInfo={memberInfo}
        organizationInfo={organizationInfo}
        onAddAttendee={handleAddAttendee}
        existingEmails={allExistingEmails}
      />
    </Card>
  );
}

export default function ComplexEventDetail() {
  const { memberInfo, organizationInfo } = useMemberAccess();
  const [showSpeakerModal, setShowSpeakerModal] = useState(false);
  const [selectedSpeaker, setSelectedSpeaker] = useState(null);
  const [ticketDrawerOpen, setTicketDrawerOpen] = useState(false);
  const [drawerTrackName, setDrawerTrackName] = useState(null);
  const [drawerTrackId, setDrawerTrackId] = useState(null);

  const routeParams = useParams();
  const urlParams = new URLSearchParams(window.location.search);
  const eventIdFromQuery = urlParams.get('id');
  const eventSlugFromRoute = routeParams.eventSlug;

  const isSlugLookup = !!eventSlugFromRoute && !eventIdFromQuery;

  const { data: slugResolvedEvent, isLoading: isSlugLoading } = useQuery({
    queryKey: ['complex-event-by-slug', eventSlugFromRoute],
    queryFn: async () => await publicClient.getComplexEventBySlug(eventSlugFromRoute),
    enabled: isSlugLookup
  });

  const eventId = eventIdFromQuery || (slugResolvedEvent?.id) || null;

  const { data: event, isLoading: eventLoading } = useQuery({
    queryKey: ['complex-event', eventId],
    queryFn: async () => await publicClient.getComplexEvent(eventId),
    enabled: !!eventId,
    staleTime: 30 * 1000
  });

  const { data: sessions = [], isLoading: sessionsLoading } = useQuery({
    queryKey: ['complex-event-sessions-public', eventId],
    queryFn: async () => await publicClient.getComplexEventSessions(eventId) || [],
    enabled: !!eventId
  });

  const { data: speakers = [] } = useQuery({
    queryKey: ['complex-event-speakers', event?.speaker_ids],
    queryFn: async () => await publicClient.listSpeakers(event.speaker_ids) || [],
    enabled: !!event?.speaker_ids && event.speaker_ids.length > 0
  });

  const trackColorMap = useMemo(() => {
    const map = {};
    const eventTracks = event?.tracks || [];
    const tracksByName = {};
    eventTracks.forEach(t => { if (t.name) tracksByName[t.name] = t; });

    const trackNames = new Set();
    sessions.forEach(s => {
      const names = s.track_names || (s.track_name ? [s.track_name] : []);
      names.forEach(n => trackNames.add(n));
    });

    let fallbackIdx = 0;
    Array.from(trackNames).sort().forEach(trackName => {
      const dbTrack = tracksByName[trackName];
      const sessionWithColour = sessions.find(s => s.track_name === trackName && s.track_colour);
      const hex = dbTrack?.colour || sessionWithColour?.track_colour;

      if (hex) {
        map[trackName] = buildTrackColorStyles(hex);
      } else {
        const fb = FALLBACK_TRACK_COLORS[fallbackIdx % FALLBACK_TRACK_COLORS.length];
        map[trackName] = buildTrackColorStyles(fb.accent);
        fallbackIdx++;
      }
    });
    return map;
  }, [sessions, event]);

  useEffect(() => {
    if (event) {
      document.title = event.seo_title || event.title || 'Event';
      let metaDescription = document.querySelector('meta[name="description"]');
      if (!metaDescription) {
        metaDescription = document.createElement('meta');
        metaDescription.name = 'description';
        document.head.appendChild(metaDescription);
      }
      metaDescription.content = event.seo_description || event.summary || '';
    }
    return () => { document.title = 'Portal'; };
  }, [event]);

  const isLoading = eventLoading || isSlugLoading;
  const tz = event?.timezone || DEFAULT_TIMEZONE;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (!event) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <Card className="border-slate-200 max-w-md w-full mx-4">
          <CardContent className="p-8 text-center">
            <Calendar className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-slate-900 mb-2" data-testid="text-event-not-found">Event Not Found</h2>
            <p className="text-slate-600 mb-4">This event may have been removed or is not available.</p>
            <Link to="/PublicComplexEvents">
              <Button variant="outline" data-testid="button-back-to-events">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Events
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      <div className="relative">
        {event.image_url ? (
          <div className="h-64 md:h-80 overflow-hidden bg-slate-100">
            <img
              src={event.image_url}
              alt={event.title}
              className="w-full h-full object-cover"
              style={getFocalPointStyle(event.image_focal_point)}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />
          </div>
        ) : (
          <div className="h-64 md:h-80 bg-gradient-to-r from-indigo-600 to-purple-600" />
        )}

        <div className="absolute bottom-0 left-0 right-0 p-6 md:p-10">
          <div className="max-w-7xl mx-auto">
            <div className="flex items-start gap-2 mb-3 flex-wrap">
              <Link to="/PublicComplexEvents">
                <Button variant="outline" size="sm" className="bg-white/10 backdrop-blur-sm border-white/30 text-white" data-testid="button-back">
                  <ArrowLeft className="w-4 h-4 mr-1" />
                  All Events
                </Button>
              </Link>
              {event.event_type && (
                <Badge className="bg-white/20 text-white border-white/30">{event.event_type}</Badge>
              )}
              {event.status === 'tbc' && (
                <Badge variant="outline" className="border-amber-300 text-amber-200">Dates TBC</Badge>
              )}
            </div>
            <h1 className="text-3xl md:text-4xl font-bold text-white mb-2" data-testid="text-event-title">
              {event.title}
            </h1>
            <div className="flex flex-wrap items-center gap-4 text-white/90 text-sm">
              {event.start_date && (
                <span className="flex items-center gap-1.5">
                  <Calendar className="w-4 h-4" />
                  {formatDate(event.start_date, tz, "MMM d")}
                  {event.end_date && ` - ${formatDate(event.end_date, tz, "MMM d, yyyy")}`}
                  {!event.end_date && `, ${formatDate(event.start_date, tz, "yyyy")}`}
                </span>
              )}
              {event.location && (
                <span className="flex items-center gap-1.5">
                  <MapPin className="w-4 h-4" />
                  {event.location}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="grid lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-8">
            {(event.description || event.summary) && (
              <Card className="border-slate-200">
                <CardContent className="p-6">
                  <h2 className="text-lg font-semibold text-slate-900 mb-3" data-testid="text-about-heading">About this Event</h2>
                  {event.description ? (
                    <div
                      className="prose prose-slate max-w-none text-sm"
                      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(event.description) }}
                    />
                  ) : (
                    <p className="text-slate-600">{event.summary}</p>
                  )}
                </CardContent>
              </Card>
            )}

            {sessions.length > 0 && (
              <Card className="border-slate-200">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Calendar className="w-5 h-5 text-indigo-600" />
                    Schedule
                  </CardTitle>
                  {Object.keys(trackColorMap).length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {Object.entries(trackColorMap).map(([track, colors]) => (
                        <Badge
                          key={track}
                          variant="outline"
                          className="text-xs border-0"
                          style={{ ...(colors.bgStyle || {}), ...(colors.textStyle || {}) }}
                        >
                          {track}
                        </Badge>
                      ))}
                    </div>
                  )}
                </CardHeader>
                <CardContent>
                  <ScheduleGrid
                    sessions={sessions}
                    timezone={tz}
                    trackColorMap={trackColorMap}
                    eventTracks={event?.tracks || []}
                    onSeeTickets={(trackName, trackId) => {
                      setDrawerTrackName(trackName);
                      setDrawerTrackId(trackId);
                      setTicketDrawerOpen(true);
                    }}
                  />
                </CardContent>
              </Card>
            )}

            {speakers.length > 0 && (
              <Card className="border-slate-200">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Mic className="w-5 h-5 text-purple-600" />
                    Speakers
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid sm:grid-cols-2 gap-4">
                    {speakers.map(speaker => (
                      <button
                        key={speaker.id}
                        onClick={() => { setSelectedSpeaker(speaker); setShowSpeakerModal(true); }}
                        className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 hover:border-purple-300 hover:bg-purple-50 transition-colors text-left"
                        data-testid={`button-speaker-${speaker.id}`}
                      >
                        <Avatar className="h-12 w-12">
                          {speaker.profile_photo_url ? (
                            <AvatarImage src={speaker.profile_photo_url} alt={speaker.name} />
                          ) : null}
                          <AvatarFallback className="bg-purple-100 text-purple-700">
                            {(speaker.name || '?').charAt(0)}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="font-medium text-slate-900">{speaker.name}</div>
                          {speaker.title && <div className="text-xs text-slate-500">{speaker.title}</div>}
                          {speaker.organization && <div className="text-xs text-slate-500">{speaker.organization}</div>}
                        </div>
                      </button>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          <div className="space-y-6">
            <Card className="border-slate-200">
              <CardContent className="p-5 space-y-4">
                <h3 className="font-semibold text-slate-900">Event Details</h3>
                {event.start_date && (
                  <div className="flex items-start gap-3 text-sm">
                    <Calendar className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                    <div>
                      <div className="font-medium text-slate-900">
                        {formatDate(event.start_date, tz)}
                      </div>
                      {event.end_date && (
                        <div className="text-slate-500">
                          to {formatDate(event.end_date, tz)}
                        </div>
                      )}
                      <div className="text-slate-500">{formatTime(event.start_date, tz)}</div>
                    </div>
                  </div>
                )}

                {event.location && (
                  <div className="flex items-start gap-3 text-sm">
                    <MapPin className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                    <span className="text-slate-700">{event.location}</span>
                  </div>
                )}

                {event.show_seat_count !== false && (
                  <div className="flex items-start gap-3 text-sm">
                    <Users className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                    {(event.available_seats === 0 || event.available_seats === null) ? (
                      <span className="text-green-600 font-medium">Open Registration</span>
                    ) : event.available_seats > 0 ? (
                      <span className="text-green-600 font-medium">{event.available_seats} places available</span>
                    ) : (
                      <span className="text-red-600 font-medium">Sold out</span>
                    )}
                  </div>
                )}

                {sessions.length > 0 && (
                  <div className="flex items-start gap-3 text-sm">
                    <Clock className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                    <span className="text-slate-700">{sessions.length} session{sessions.length !== 1 ? 's' : ''}</span>
                  </div>
                )}
              </CardContent>
            </Card>

            <BookingSection
              event={event}
              sessions={sessions}
              memberInfo={memberInfo}
              organizationInfo={organizationInfo}
            />
          </div>
        </div>
      </div>

      <Dialog open={showSpeakerModal} onOpenChange={setShowSpeakerModal}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{selectedSpeaker?.name}</DialogTitle>
          </DialogHeader>
          {selectedSpeaker && (
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <Avatar className="h-16 w-16">
                  {selectedSpeaker.profile_photo_url ? (
                    <AvatarImage src={selectedSpeaker.profile_photo_url} alt={selectedSpeaker.name} />
                  ) : null}
                  <AvatarFallback className="bg-purple-100 text-purple-700 text-lg">
                    {(selectedSpeaker.name || '?').charAt(0)}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <div className="font-medium text-slate-900">{selectedSpeaker.name}</div>
                  {selectedSpeaker.title && <div className="text-sm text-slate-500">{selectedSpeaker.title}</div>}
                  {selectedSpeaker.organization && <div className="text-sm text-slate-500">{selectedSpeaker.organization}</div>}
                </div>
              </div>
              {selectedSpeaker.bio && (
                <div
                  className="prose prose-slate max-w-none text-sm"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(selectedSpeaker.bio) }}
                />
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Sheet open={ticketDrawerOpen} onOpenChange={setTicketDrawerOpen}>
        <SheetContent side="right" className="w-full sm:max-w-[1100px] overflow-y-auto" data-testid="drawer-track-tickets">
          <SheetHeader className="pb-4 border-b border-slate-200 mb-6">
            <SheetTitle className="flex items-center gap-2">
              <Ticket className="w-5 h-5 text-indigo-600" />
              {drawerTrackName ? `${drawerTrackName} — Tickets & Registration` : 'Tickets & Registration'}
            </SheetTitle>
            <SheetDescription>
              {drawerTrackName ? `Select a ticket and register for the ${drawerTrackName} track.` : 'Select a ticket and complete your registration.'}
            </SheetDescription>
          </SheetHeader>
          {ticketDrawerOpen && event && (
            <BookingSection
              event={event}
              sessions={sessions}
              memberInfo={memberInfo}
              organizationInfo={organizationInfo}
              filterTrackId={drawerTrackId}
              layout="drawer"
              onBookingComplete={() => {}}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
