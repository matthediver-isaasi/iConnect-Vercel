import { useState, useMemo, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import {
  Calendar, MapPin, Clock, Users, ArrowLeft, Ticket, Loader2,
  Video, User, Mic, AlertCircle, Monitor, Building2,
  Plus, Trash2, Layers, Lock
} from "lucide-react";
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

const EMPTY_ATTENDEE = { first_name: '', last_name: '', email: '', organization: '', phone: '', job_title: '' };

function AttendeeForm({ attendee, index, onChange, onRemove, canRemove }) {
  const update = (field, value) => onChange(index, { ...attendee, [field]: value });
  const prefix = index === 0 ? '' : `${index + 1} - `;

  return (
    <div className="space-y-2 p-3 rounded-md border border-slate-200 relative" data-testid={`attendee-form-${index}`}>
      {canRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute top-1 right-1"
          onClick={() => onRemove(index)}
          data-testid={`button-remove-attendee-${index}`}
        >
          <Trash2 className="w-3.5 h-3.5 text-slate-400" />
        </Button>
      )}
      {index > 0 && (
        <div className="text-xs font-medium text-slate-500 mb-1">Attendee {index + 1}</div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Input
          placeholder={`${prefix}First Name *`}
          value={attendee.first_name}
          onChange={(e) => update('first_name', e.target.value)}
          data-testid={`input-first-name-${index}`}
        />
        <Input
          placeholder={`${prefix}Last Name *`}
          value={attendee.last_name}
          onChange={(e) => update('last_name', e.target.value)}
          data-testid={`input-last-name-${index}`}
        />
      </div>
      <Input
        type="email"
        placeholder={`${prefix}Email *`}
        value={attendee.email}
        onChange={(e) => update('email', e.target.value)}
        data-testid={`input-email-${index}`}
      />
      <Input
        placeholder="Organisation (optional)"
        value={attendee.organization}
        onChange={(e) => update('organization', e.target.value)}
        data-testid={`input-organization-${index}`}
      />
      <div className="grid grid-cols-2 gap-2">
        <Input
          placeholder="Phone (optional)"
          value={attendee.phone}
          onChange={(e) => update('phone', e.target.value)}
          data-testid={`input-phone-${index}`}
        />
        <Input
          placeholder="Job Title (optional)"
          value={attendee.job_title}
          onChange={(e) => update('job_title', e.target.value)}
          data-testid={`input-job-title-${index}`}
        />
      </div>
    </div>
  );
}

function BookingSection({ event, sessions, memberInfo, organizationInfo, filterTrackId, layout = 'sidebar', onBookingComplete }) {
  const [selectedTicketClassId, setSelectedTicketClassId] = useState(null);
  const defaultAttendee = useMemo(() => ({
    first_name: memberInfo?.first_name || '',
    last_name: memberInfo?.last_name || '',
    email: memberInfo?.email || '',
    organization: organizationInfo?.name || '',
    phone: '',
    job_title: ''
  }), [memberInfo, organizationInfo]);

  const [attendees, setAttendees] = useState([{ ...defaultAttendee }]);

  useEffect(() => {
    if (memberInfo) {
      setAttendees(prev => {
        const updated = [...prev];
        if (updated.length > 0) {
          updated[0] = {
            ...updated[0],
            first_name: updated[0].first_name || memberInfo.first_name || '',
            last_name: updated[0].last_name || memberInfo.last_name || '',
            email: updated[0].email || memberInfo.email || '',
            organization: updated[0].organization || organizationInfo?.name || ''
          };
        }
        return updated;
      });
    }
  }, [memberInfo, organizationInfo]);

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

  useEffect(() => {
    if (ticketClasses.length > 0) {
      const currentValid = ticketClasses.find(tc => tc.id === selectedTicketClassId);
      if (!currentValid) {
        setSelectedTicketClassId(ticketClasses[0].id);
      }
    }
  }, [ticketClasses, selectedTicketClassId]);

  const selectedTicket = useMemo(() => {
    return ticketClasses.find(tc => tc.id === selectedTicketClassId) || ticketClasses[0] || null;
  }, [ticketClasses, selectedTicketClassId]);

  const isGroupTicket = selectedTicket?.is_group_ticket;
  const groupSize = selectedTicket?.group_size || 1;

  useEffect(() => {
    if (isGroupTicket && groupSize > 1) {
      setAttendees(prev => {
        if (prev.length === groupSize) return prev;
        const result = [];
        for (let i = 0; i < groupSize; i++) {
          result.push(prev[i] || { ...EMPTY_ATTENDEE });
        }
        return result;
      });
    }
  }, [isGroupTicket, groupSize]);

  const effectivePrice = useMemo(() => {
    if (!selectedTicket) return { price: 0, isEarlyBird: false };
    return getEffectiveTicketPrice(selectedTicket);
  }, [selectedTicket]);

  const attendeeCount = attendees.length;
  const unitPrice = effectivePrice.price;
  const totalPrice = unitPrice * attendeeCount;

  const isFormValid = useMemo(() => {
    return attendees.every(a =>
      a.first_name.trim() !== '' &&
      a.last_name.trim() !== '' &&
      a.email.trim() !== '' &&
      a.email.includes('@')
    );
  }, [attendees]);

  const handleAttendeeChange = useCallback((index, updated) => {
    setAttendees(prev => {
      const next = [...prev];
      next[index] = updated;
      return next;
    });
  }, []);

  const handleRemoveAttendee = useCallback((index) => {
    setAttendees(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handleAddAttendee = useCallback(() => {
    setAttendees(prev => [...prev, { ...EMPTY_ATTENDEE }]);
  }, []);

  const complexEventApi = useMemo(() => ({
    createPaymentIntent: (data) => publicClient.createComplexEventPaymentIntent(data),
    submitBooking: (data) => publicClient.submitComplexEventBooking(data),
  }), []);

  const paymentOptionsEvent = useMemo(() => ({
    ...event,
    event_type: 'one_off',
    ticket_classes: ticketClasses,
  }), [event, ticketClasses]);

  const oneOffCostDetails = useMemo(() => ({
    ticketPrice: unitPrice,
    attendeeCount: attendeeCount,
    totalCost: totalPrice,
    freeTickets: 0,
    discount: 0,
  }), [unitPrice, attendeeCount, totalPrice]);

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

  const ticketSelectorContent = (
    <div className="space-y-4">
      {ticketClasses.length > 1 && (
        <div className="space-y-3">
          <Label className="text-sm font-medium">Select Ticket</Label>
          <RadioGroup
            value={selectedTicketClassId || ''}
            onValueChange={setSelectedTicketClassId}
          >
            {ticketClasses.map(tc => {
              const tcPrice = getEffectiveTicketPrice(tc);
              return (
                <div
                  key={tc.id}
                  className={`flex items-center gap-3 p-3 rounded-md border-2 transition-colors ${selectedTicketClassId === tc.id ? 'border-indigo-500 bg-indigo-50 cursor-pointer' : 'border-slate-200 cursor-pointer'}`}
                  onClick={() => setSelectedTicketClassId(tc.id)}
                  data-testid={`ticket-class-${tc.id}`}
                >
                  <RadioGroupItem value={tc.id} id={`tc-${layout}-${tc.id}`} data-testid={`radio-ticket-${tc.id}`} />
                  <Label htmlFor={`tc-${layout}-${tc.id}`} className="flex-1 cursor-pointer">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div>
                        <span className="font-medium text-slate-900 flex items-center gap-2 flex-wrap">
                          {tc.name}
                          {isTicketRestricted(tc) && (
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
                      <div className="flex flex-col items-end flex-shrink-0">
                        <div className="flex items-center gap-1 text-lg font-semibold text-slate-900">
                          {tcPrice.price === 0 ? 'Free' : `\u00a3${tcPrice.price.toFixed(2)}`}
                        </div>
                        {tcPrice.isEarlyBird && (
                          <div className="text-sm text-slate-400 line-through">
                            {'\u00a3'}{tcPrice.standardPrice.toFixed(2)}
                          </div>
                        )}
                      </div>
                    </div>
                  </Label>
                </div>
              );
            })}
          </RadioGroup>
        </div>
      )}

      {ticketClasses.length === 1 && selectedTicket && (
        <div className="p-4 rounded-md border-2 border-indigo-200 bg-indigo-50">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <span className="font-medium text-slate-900 flex items-center gap-2 flex-wrap">
                {selectedTicket.name}
                {isTicketRestricted(selectedTicket) && (
                  <Badge variant="secondary" className="text-xs bg-slate-100 text-slate-600">
                    <Lock className="w-3 h-3 mr-1" />
                    {isGuest ? 'Members Only' : 'Public Only'}
                  </Badge>
                )}
                {selectedTicket.is_group_ticket && selectedTicket.group_size > 1 && (
                  <Badge variant="secondary" className="text-xs">
                    <Users className="w-3 h-3 mr-1" />
                    Group ({selectedTicket.group_size})
                  </Badge>
                )}
              </span>
              {selectedTicket.description && (
                <p className="text-xs text-slate-500 mt-0.5">{selectedTicket.description}</p>
              )}
              <TrackAccessIndicator ticket={selectedTicket} tracks={eventTracks} />
            </div>
            <div className="flex flex-col items-end flex-shrink-0">
              <span className="text-lg font-semibold text-slate-900">
                {effectivePrice.price === 0 ? 'Free' : `\u00a3${effectivePrice.price.toFixed(2)}`}
              </span>
            </div>
          </div>
        </div>
      )}

      {ticketClasses.length === 0 && (
        <p className="text-sm text-center text-slate-500">
          {filterTrackId ? 'No tickets are available for this track.' : 'No tickets are currently available for public registration.'}
        </p>
      )}
    </div>
  );

  const attendeeContent = (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Label className="text-sm font-medium">
          {attendeeCount > 1 ? `Attendees (${attendeeCount})` : 'Your Details'}
        </Label>
        {!isGroupTicket && attendeeCount < 20 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleAddAttendee}
            data-testid="button-add-attendee"
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            Add Attendee
          </Button>
        )}
      </div>
      {attendees.map((attendee, i) => (
        <AttendeeForm
          key={i}
          attendee={attendee}
          index={i}
          onChange={handleAttendeeChange}
          onRemove={handleRemoveAttendee}
          canRemove={!isGroupTicket && attendees.length > 1}
        />
      ))}
    </div>
  );

  const paymentOptionsSection = (
    <PaymentOptions
      event={paymentOptionsEvent}
      memberInfo={memberInfo}
      organizationInfo={organizationInfo}
      attendees={attendees}
      registrationMode="colleagues"
      selectedTicketClass={selectedTicket}
      ticketPrice={unitPrice}
      totalCost={totalPrice}
      oneOffCostDetails={oneOffCostDetails}
      isComplexEvent={true}
      complexEventApi={complexEventApi}
      onComplexBookingComplete={onBookingComplete}
      renderAsCard={false}
    />
  );

  if (layout === 'drawer') {
    return (
      <div className="grid lg:grid-cols-2 gap-8" data-testid="booking-section-drawer">
        <div className="space-y-6">
          <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <User className="w-5 h-5 text-indigo-600" />
            Registration
          </h3>
          {attendeeContent}
        </div>
        <div className="space-y-6">
          <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <Ticket className="w-5 h-5 text-indigo-600" />
            Tickets & Payment
          </h3>
          {ticketSelectorContent}
          {paymentOptionsSection}
        </div>
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
        {ticketSelectorContent}
        {attendeeContent}
        {paymentOptionsSection}
      </CardContent>
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
