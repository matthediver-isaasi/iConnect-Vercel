import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Calendar, MapPin, Clock, Users, ArrowLeft, Ticket, Loader2,
  Video, User, Mic, AlertCircle, Monitor, Building2,
  Plus, Trash2, Layers, Lock, UserPlus, X, ShoppingCart, Mail, FileText, ChevronDown
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
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


function ScheduleGrid({ sessions, timezone, trackColorMap, eventTracks, speakerMap = {}, onSessionClick }) {
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
    const visibleTrackNames = Object.keys(trackColorMap);
    if (visibleTrackNames.length > 0) {
      const allowed = new Set(visibleTrackNames);
      return Array.from(trackSet).filter(t => allowed.has(t)).sort();
    }
    return Array.from(trackSet).sort();
  }, [sessions, trackColorMap]);

  if (sessionsByDay.length === 0) return null;

  return (
    <div className="space-y-8">
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
                          <SessionCard key={session.id} session={session} timezone={timezone} colors={trackColorMap[session.track_name]} speakerMap={speakerMap} onClick={onSessionClick} />
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
                          <SessionCard key={`${trackSession.id}-${track}`} session={trackSession} timezone={timezone} colors={colors} isMultiTrack={isMultiTrack} speakerMap={speakerMap} onClick={onSessionClick} />
                        );
                      })}
                      {hasUntracked && (() => {
                        const untrackedSession = slot.sessions.find(s => {
                          const names = s.track_names || (s.track_name ? [s.track_name] : []);
                          return names.length === 0;
                        });
                        if (!untrackedSession) return <div className="p-1" />;
                        return <SessionCard session={untrackedSession} timezone={timezone} colors={null} speakerMap={speakerMap} onClick={onSessionClick} />;
                      })()}
                    </div>
                  );
                })}

              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SessionCard({ session, timezone, colors, isMultiTrack = false, speakerMap = {}, onClick }) {
  const hasCustomColors = colors?.lightStyle;
  const fallbackClass = "bg-slate-50 border-slate-300";

  const sessionSpeakers = useMemo(() => {
    if (session.speaker_ids?.length) {
      return session.speaker_ids.map(id => speakerMap[id]).filter(Boolean);
    }
    return [];
  }, [session.speaker_ids, speakerMap]);

  const fallbackSpeakerNames = sessionSpeakers.length === 0 && session.speaker_names?.length > 0
    ? session.speaker_names
    : [];

  return (
    <div
      className={`p-3 rounded-md border space-y-1 cursor-pointer transition-shadow hover:shadow-md ${hasCustomColors ? '' : fallbackClass}`}
      style={hasCustomColors ? { ...colors.lightStyle, ...colors.borderStyle } : undefined}
      data-testid={`session-card-${session.id}`}
      onClick={() => onClick?.(session)}
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
        <p className="text-xs text-slate-500 line-clamp-2" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(session.description) }} />
      )}
      {sessionSpeakers.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap pt-0.5">
          {sessionSpeakers.map(speaker => {
            const displayName = speaker.full_name || speaker.name || '?';
            return (
              <div key={speaker.id} className="flex items-center gap-1.5" data-testid={`session-speaker-${speaker.id}`}>
                <Avatar className="h-5 w-5">
                  {speaker.profile_photo_url ? (
                    <AvatarImage src={speaker.profile_photo_url} alt={displayName} />
                  ) : null}
                  <AvatarFallback className="text-[8px]">
                    {displayName.charAt(0)}
                  </AvatarFallback>
                </Avatar>
                <span className="text-xs text-slate-700">{displayName}</span>
              </div>
            );
          })}
        </div>
      )}
      {fallbackSpeakerNames.length > 0 && (
        <div className="flex items-center gap-1 text-xs text-slate-600 pt-0.5">
          <Mic className="w-3 h-3" />
          <span>{fallbackSpeakerNames.join(", ")}</span>
        </div>
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

function ExpandedSessionOverlay({ session, timezone, speakerMap, eventImageUrl, eventImageFocalPoint, onClose }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
  }, []);

  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 250);
  }, [onClose]);

  const sessionSpeakers = useMemo(() => {
    if (session.speaker_ids?.length) {
      return session.speaker_ids.map(id => speakerMap[id]).filter(Boolean);
    }
    return [];
  }, [session.speaker_ids, speakerMap]);

  const fallbackSpeakerNames = sessionSpeakers.length === 0 && session.speaker_names?.length > 0
    ? session.speaker_names
    : [];

  const hasOwnImage = !!session.image_url;
  const imageUrl = session.image_url || eventImageUrl || null;
  const imageFocalPoint = hasOwnImage ? null : eventImageFocalPoint;

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center overflow-visible transition-all duration-250"
      style={{ backgroundColor: visible ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0)', backdropFilter: visible ? 'blur(6px)' : 'blur(0px)' }}
      onClick={handleClose}
      data-testid="session-overlay-backdrop"
    >
      <div
        className="absolute left-[30px] right-[30px] bg-white rounded-xl shadow-xl border border-slate-200 overflow-hidden transition-all duration-250 ease-out flex flex-col"
        style={{
          top: '50%',
          transform: visible ? 'translateY(-50%) scale(1)' : 'translateY(-50%) scale(0.85)',
          minHeight: '60vh',
          maxHeight: '80vh',
          opacity: visible ? 1 : 0,
        }}
        onClick={(e) => e.stopPropagation()}
        data-testid={`session-expanded-${session.id}`}
      >
        {imageUrl && (
          <div className="h-48 shrink-0 overflow-hidden bg-slate-100">
            <img src={imageUrl} alt={session.title} className="w-full h-full object-cover" style={getFocalPointStyle(imageFocalPoint)} />
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-lg font-semibold text-slate-900">{session.title}</h3>
            <button
              onClick={handleClose}
              className="shrink-0 p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
              data-testid="button-close-session-overlay"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600">
            {session.start_time && (
              <span className="flex items-center gap-1.5">
                <Clock className="w-4 h-4 text-slate-400" />
                {formatTime(session.start_time, timezone)}
                {session.end_time && ` - ${formatTime(session.end_time, timezone)}`}
              </span>
            )}
            {session.start_time && (
              <span className="flex items-center gap-1.5">
                <Calendar className="w-4 h-4 text-slate-400" />
                {formatDate(session.start_time, timezone)}
              </span>
            )}
            {session.location && (
              <span className="flex items-center gap-1.5">
                <MapPin className="w-4 h-4 text-slate-400" />
                {session.location}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            {session.track_names?.length > 0 && session.track_names.map((name, i) => (
              <Badge key={i} variant="secondary" className="text-xs">{name}</Badge>
            ))}
            {session.delivery_mode === 'virtual' && (
              <Badge variant="secondary" className="text-xs"><Monitor className="h-3 w-3 mr-1" />Virtual</Badge>
            )}
            {session.delivery_mode === 'hybrid' && (
              <Badge variant="secondary" className="text-xs"><Video className="h-3 w-3 mr-1" />Hybrid</Badge>
            )}
            {session.delivery_mode === 'in_person' && (
              <Badge variant="secondary" className="text-xs"><Building2 className="h-3 w-3 mr-1" />In-Person</Badge>
            )}
            {session.is_online && !session.delivery_mode && (
              <Badge variant="secondary" className="text-xs"><Monitor className="h-3 w-3 mr-1" />Online</Badge>
            )}
          </div>

          {session.description && (
            <div
              className="text-sm text-slate-600 leading-relaxed whitespace-pre-wrap prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(session.description) }}
            />
          )}

          {sessionSpeakers.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-slate-700 flex items-center gap-1.5">
                <Mic className="w-4 h-4 text-slate-400" />
                Speakers
              </h4>
              <div className="flex flex-col gap-2">
                {sessionSpeakers.map(speaker => {
                  const displayName = speaker.full_name || speaker.name || '?';
                  return (
                    <div key={speaker.id} className="flex items-center gap-3" data-testid={`expanded-speaker-${speaker.id}`}>
                      <Avatar className="h-8 w-8">
                        {speaker.profile_photo_url ? (
                          <AvatarImage src={speaker.profile_photo_url} alt={displayName} />
                        ) : null}
                        <AvatarFallback className="text-xs bg-purple-100 text-purple-700">
                          {displayName.charAt(0)}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <div className="text-sm font-medium text-slate-900">{displayName}</div>
                        {(speaker.title || speaker.organization) && (
                          <div className="text-xs text-slate-500">
                            {[speaker.title, speaker.organization].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {fallbackSpeakerNames.length > 0 && (
            <div className="flex items-center gap-1.5 text-sm text-slate-600">
              <Mic className="w-4 h-4 text-slate-400" />
              <span>{fallbackSpeakerNames.join(", ")}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ScrollableSchedule({ sessions, timezone, trackColorMap, eventTracks, speakerMap, eventImageUrl, eventImageFocalPoint }) {
  const scrollRef = useRef(null);
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);
  const [expandedSession, setExpandedSession] = useState(null);

  const checkScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollUp(el.scrollTop > 8);
    setCanScrollDown(el.scrollTop + el.clientHeight < el.scrollHeight - 8);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    checkScroll();
    const ro = new ResizeObserver(checkScroll);
    ro.observe(el);
    el.addEventListener('scroll', checkScroll, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener('scroll', checkScroll); };
  }, [checkScroll, sessions]);

  const scrollToNextSession = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const cards = el.querySelectorAll('[data-testid^="session-card-"]');
    const containerRect = el.getBoundingClientRect();
    const bottomEdge = containerRect.bottom;
    for (const card of cards) {
      const cardRect = card.getBoundingClientRect();
      if (cardRect.top >= bottomEdge - 4) {
        el.scrollTo({ top: el.scrollTop + (cardRect.top - containerRect.top), behavior: 'smooth' });
        return;
      }
    }
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  return (
    <div className="relative">
      {canScrollUp && !expandedSession && (
        <div className="absolute top-0 left-0 right-0 h-8 bg-gradient-to-b from-white to-transparent z-10 pointer-events-none" />
      )}
      <div ref={scrollRef} className={`max-h-[500px] overflow-y-auto pr-4 transition-[filter] duration-250 ${expandedSession ? 'filter blur-[3px] pointer-events-none' : ''}`}>
        <ScheduleGrid
          sessions={sessions}
          timezone={timezone}
          trackColorMap={trackColorMap}
          eventTracks={eventTracks}
          speakerMap={speakerMap}
          onSessionClick={setExpandedSession}
        />
      </div>
      {canScrollDown && !expandedSession && (
        <>
          <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-white to-transparent z-10 pointer-events-none" />
          <button
            onClick={scrollToNextSession}
            className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 w-8 h-8 rounded-full bg-white border border-slate-200 shadow-md flex items-center justify-center text-slate-500 hover:text-slate-700 hover:shadow-lg transition-all"
            data-testid="button-scroll-next-session"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        </>
      )}
      {expandedSession && (
        <ExpandedSessionOverlay
          session={expandedSession}
          timezone={timezone}
          speakerMap={speakerMap}
          eventImageUrl={eventImageUrl}
          eventImageFocalPoint={eventImageFocalPoint}
          onClose={() => setExpandedSession(null)}
        />
      )}
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
              <div className="flex gap-2">
                <Button
                  onClick={handleRegisterSelf}
                  disabled={isSelfAlreadyAdded}
                  className="flex-1"
                  data-testid="button-register-myself"
                >
                  <User className="w-4 h-4 mr-1.5" />
                  {isSelfAlreadyAdded ? 'Already Added' : 'Register Myself'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  data-testid="button-cancel-self"
                >
                  Cancel
                </Button>
              </div>
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
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="w-full"
                data-testid="button-cancel-colleague"
              >
                Cancel
              </Button>
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
            <div className="flex gap-2">
              <Button
                onClick={handleExternalSubmit}
                className="flex-1"
                data-testid="button-add-external"
              >
                <Mail className="w-4 h-4 mr-1.5" />
                Add Attendee
              </Button>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                data-testid="button-cancel-external"
              >
                Cancel
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function TicketDiscountInput({ ticketClassId, discountInfo, onApply, onRemove, eventId }) {
  const [inputValue, setInputValue] = useState('');
  const [validating, setValidating] = useState(false);
  const hasApplied = !!discountInfo?.code;

  const handleApply = async () => {
    const code = inputValue.trim();
    if (!code) return;
    setValidating(true);
    try {
      const result = await publicClient.validateComplexEventDiscount({
        event_id: eventId,
        ticket_class_id: ticketClassId,
        discount_code: code
      });
      if (result.valid) {
        onApply(ticketClassId, {
          code: code.toUpperCase(),
          discountedPrice: result.discounted_price,
          originalPrice: result.original_price,
          discountType: result.discount_type,
          discountValue: result.discount_value
        });
        toast.success(`Discount applied! Price reduced to \u00a3${result.discounted_price.toFixed(2)}`);
      } else {
        toast.error(result.reason || 'Invalid discount code');
      }
    } catch (err) {
      toast.error('Failed to validate discount code');
    } finally {
      setValidating(false);
    }
  };

  return (
    <div className="mt-2 pt-2 border-t border-slate-100" data-testid={`discount-section-${ticketClassId}`}>
      <div className="flex items-center gap-1.5">
        <Input
          type="text"
          placeholder="Discount code"
          value={hasApplied ? discountInfo.code : inputValue}
          onChange={(e) => setInputValue(e.target.value.toUpperCase())}
          disabled={hasApplied || validating}
          className="h-7 text-xs flex-1"
          data-testid={`input-discount-${ticketClassId}`}
        />
        {hasApplied ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => { onRemove(ticketClassId); setInputValue(''); }}
            className="h-7 px-2 text-xs text-red-600"
            data-testid={`button-remove-discount-${ticketClassId}`}
          >
            <X className="w-3 h-3" />
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleApply}
            disabled={!inputValue.trim() || validating}
            className="h-7 px-2 text-xs"
            data-testid={`button-apply-discount-${ticketClassId}`}
          >
            {validating ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Apply'}
          </Button>
        )}
      </div>
      {hasApplied && (
        <p className="text-[10px] text-green-600 mt-0.5">
          {discountInfo.discountType === 'percentage'
            ? `${discountInfo.discountValue}% off`
            : `\u00a3${discountInfo.discountValue.toFixed(2)} off`}
          {' \u2014 '}{'\u00a3'}{discountInfo.discountedPrice.toFixed(2)} per ticket
        </p>
      )}
    </div>
  );
}

function CartSummary({ cart, ticketClasses, onRemoveAttendee, getEffectiveTicketPrice }) {
  const entries = Object.entries(cart).filter(([, item]) => item.attendees.length > 0);
  if (entries.length === 0) return null;

  const totalAttendees = entries.reduce((sum, [, item]) => sum + item.attendees.length, 0);

  let grandTotal = 0;
  const itemSubtotals = entries.map(([ticketClassId, item]) => {
    const tc = item.ticketClass;
    const ep = tc && getEffectiveTicketPrice ? getEffectiveTicketPrice(tc) : { price: 0 };
    const di = item.discountInfo;
    const effectiveUnitPrice = di ? di.discountedPrice : ep.price;
    const subtotal = effectiveUnitPrice * item.attendees.length;
    grandTotal += subtotal;
    return { ticketClassId, unitPrice: effectiveUnitPrice, originalPrice: ep.price, subtotal, discountInfo: di };
  });

  return (
    <div className="space-y-3" data-testid="cart-summary">
      <div className="flex items-center gap-2">
        <ShoppingCart className="w-4 h-4 text-indigo-600" />
        <Label className="text-sm font-medium">
          Your Cart ({totalAttendees} attendee{totalAttendees !== 1 ? 's' : ''})
        </Label>
      </div>
      {entries.map(([ticketClassId, item], entryIdx) => {
        const sub = itemSubtotals[entryIdx];
        return (
          <div key={ticketClassId} className="space-y-1.5">
            <div className="text-xs font-medium text-slate-600 flex items-center gap-1.5 flex-wrap">
              <Ticket className="w-3 h-3" />
              {item.ticketClass?.name || 'Ticket'}
              {sub.discountInfo && (
                <Badge variant="secondary" className="text-[10px] bg-green-50 text-green-700 border-green-200">
                  {sub.discountInfo.code}
                </Badge>
              )}
              <span className="ml-auto text-[11px] text-slate-500">
                {item.attendees.length} x{' '}
                {sub.discountInfo ? (
                  <>
                    <span className="line-through text-slate-400">{'\u00a3'}{sub.originalPrice.toFixed(2)}</span>
                    {' '}{'\u00a3'}{sub.unitPrice.toFixed(2)}
                  </>
                ) : (
                  <>{'\u00a3'}{sub.unitPrice.toFixed(2)}</>
                )}
                {' = '}{'\u00a3'}{sub.subtotal.toFixed(2)}
              </span>
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
        );
      })}
      <div className="flex items-center justify-between pt-2 border-t border-slate-200" data-testid="cart-grand-total">
        <span className="text-sm font-semibold text-slate-800">Total</span>
        <span className="text-sm font-semibold text-slate-800">{'\u00a3'}{grandTotal.toFixed(2)}</span>
      </div>
    </div>
  );
}

function BookingSection({ event, sessions, memberInfo, organizationInfo, onBookingComplete, cart, setCart }) {
  const [attendeeModalOpen, setAttendeeModalOpen] = useState(false);
  const [modalTicketClassId, setModalTicketClassId] = useState(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(false);

  const { data: systemSettings = [] } = useQuery({
    queryKey: ['/api/public/system-settings'],
    queryFn: () => publicClient.listSystemSettings()
  });

  const bookingTerms = useMemo(() => {
    const setting = Array.isArray(systemSettings)
      ? systemSettings.find(s => s.setting_key === 'event_booking_terms')
      : null;
    return setting?.setting_value || '';
  }, [systemSettings]);

  const hasBookingTerms = bookingTerms && bookingTerms.trim() !== '' && bookingTerms !== '<p><br></p>';

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

    return pricingConfig.ticket_classes.map(tc => ({
      ...tc,
      id: String(tc.id),
      price: Number(tc.price) || 0
    }));
  }, [pricingConfig]);

  const isGuest = !memberInfo;
  const userRoleId = memberInfo?.role_id;

  const getTicketVisibility = (tc) => {
    if (tc.visibility_mode) return tc.visibility_mode;
    if (tc.is_public === true) return 'members_and_public';
    if (tc.is_public === false) return 'members_only';
    return 'members_and_public';
  };

  const availableTicketClasses = useMemo(() => {
    return ticketClasses.filter(tc => {
      const vis = getTicketVisibility(tc);
      if (isGuest) {
        if (vis === 'members_only') return false;
        if (tc.role_match_only) return false;
        return true;
      }
      if (vis === 'public_only') return false;
      if (!tc.role_match_only) return true;
      if ((tc.role_ids || []).length === 0) return true;
      return userRoleId && (tc.role_ids || []).includes(userRoleId);
    });
  }, [ticketClasses, isGuest, userRoleId]);

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

  const handleApplyDiscount = useCallback((ticketClassId, discountInfo) => {
    setCart(prev => {
      const existing = prev[ticketClassId];
      if (!existing) return prev;
      return {
        ...prev,
        [ticketClassId]: { ...existing, discountInfo: discountInfo || null }
      };
    });
  }, []);

  const handleRemoveDiscount = useCallback((ticketClassId) => {
    setCart(prev => {
      const existing = prev[ticketClassId];
      if (!existing) return prev;
      return {
        ...prev,
        [ticketClassId]: { ...existing, discountInfo: null }
      };
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
        const di = item.discountInfo;
        const effectiveUnitPrice = di ? di.discountedPrice : ep.price;
        return {
          ticketClassId,
          ticketClass: tc,
          attendees: item.attendees,
          unitPrice: effectiveUnitPrice,
          originalUnitPrice: ep.price,
          subtotal: effectiveUnitPrice * item.attendees.length,
          discountCode: di?.code || null,
          discountInfo: di || null
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
    if (cartItems.length === 0) return availableTicketClasses[0] || null;
    return cartItems[0].ticketClass || null;
  }, [cartItems, availableTicketClasses]);

  const complexEventApi = useMemo(() => ({
    createPaymentIntent: (data) => {
      const items = cartItems.map(ci => ({
        ticket_class_id: ci.ticketClassId,
        attendee_count: ci.attendees.length,
        discount_code: ci.discountCode || undefined
      }));
      return publicClient.createComplexEventPaymentIntent({
        event_id: event.id,
        items
      });
    },
    submitBooking: (data) => {
      const savedItems = data._savedCartItems;
      let items;
      if (savedItems && savedItems.length > 0) {
        items = savedItems;
      } else {
        items = cartItems.map(ci => ({
          ticket_class_id: ci.ticketClassId,
          discount_code: ci.discountCode || undefined,
          attendees: ci.attendees.map(a => ({
            email: (a.email || '').toLowerCase().trim(),
            first_name: (a.first_name || '').trim(),
            last_name: (a.last_name || '').trim(),
            organization: (a.organization || '').trim(),
            phone: (a.phone || '').trim(),
            job_title: (a.job_title || '').trim()
          }))
        }));
      }
      return publicClient.submitComplexEventBooking({
        event_id: event.id,
        items,
        payment_method: data.payment_method,
        stripe_payment_intent_id: data.stripe_payment_intent_id || null
      });
    },
    _getCartItems: () => {
      return cartItems.map(ci => ({
        ticket_class_id: ci.ticketClassId,
        discount_code: ci.discountCode || undefined,
        attendees: ci.attendees.map(a => ({
          email: (a.email || '').toLowerCase().trim(),
          first_name: (a.first_name || '').trim(),
          last_name: (a.last_name || '').trim(),
          organization: (a.organization || '').trim(),
          phone: (a.phone || '').trim(),
          job_title: (a.job_title || '').trim()
        }))
      }));
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
      {availableTicketClasses.length > 0 && (
        <Label className="text-sm font-medium">Tickets</Label>
      )}
      {availableTicketClasses.map(tc => {
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
            {count > 0 && tcPrice.price > 0 && (
              <TicketDiscountInput
                ticketClassId={tc.id}
                discountInfo={cartEntry?.discountInfo || null}
                onApply={handleApplyDiscount}
                onRemove={handleRemoveDiscount}
                eventId={event.id}
              />
            )}
          </div>
        );
      })}

      {availableTicketClasses.length === 0 && (
        <p className="text-sm text-center text-slate-500">
          No tickets are currently available for public registration.
        </p>
      )}
    </div>
  );

  const isStripeReturn = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('payment_intent');

  const shouldShowPaymentOptions = totalAttendeeCount > 0 || isStripeReturn;

  const paymentOptionsSection = shouldShowPaymentOptions ? (
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
      hasBookingTerms={hasBookingTerms}
      bookingTerms={bookingTerms}
      termsAccepted={termsAccepted}
      setTermsAccepted={setTermsAccepted}
      onShowTermsModal={() => setShowTermsModal(true)}
    />
  ) : null;

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
        <CartSummary cart={cart} ticketClasses={ticketClasses} onRemoveAttendee={handleRemoveAttendee} getEffectiveTicketPrice={getEffectiveTicketPrice} />
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

      <Dialog open={showTermsModal} onOpenChange={setShowTermsModal}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold flex items-center gap-2">
              <FileText className="w-5 h-5" />
              Terms and Conditions
            </DialogTitle>
          </DialogHeader>
          <div className="mt-4">
            <div
              className="prose prose-slate max-w-none"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(bookingTerms) }}
              data-testid="terms-content"
            />
          </div>
          <div className="mt-6 pt-4 border-t flex justify-end">
            <Button onClick={() => setShowTermsModal(false)} data-testid="button-close-terms">
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function ComplexEventDetail() {
  const { memberInfo, organizationInfo } = useMemberAccess();
  const [showSpeakerModal, setShowSpeakerModal] = useState(false);
  const [selectedSpeaker, setSelectedSpeaker] = useState(null);
  const [cart, setCart] = useState({});

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

  const allSpeakerIds = useMemo(() => {
    const ids = new Set(event?.speaker_ids || []);
    sessions.forEach(s => (s.speaker_ids || []).forEach(id => ids.add(id)));
    return [...ids];
  }, [event?.speaker_ids, sessions]);

  const { data: speakers = [] } = useQuery({
    queryKey: ['complex-event-speakers', allSpeakerIds],
    queryFn: async () => await publicClient.listSpeakers(allSpeakerIds) || [],
    enabled: allSpeakerIds.length > 0
  });

  const speakerMap = useMemo(() => {
    const map = {};
    speakers.forEach(s => { map[s.id] = s; });
    return map;
  }, [speakers]);

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

  const accessibleTrackNames = useMemo(() => {
    const eventTracks = event?.tracks || [];
    if (eventTracks.length === 0) return null;

    let pConfig = event?.pricing_config;
    if (typeof pConfig === 'string') {
      try { pConfig = JSON.parse(pConfig); } catch { pConfig = null; }
    }
    const allTickets = (pConfig?.ticket_classes || []).map(tc => ({
      ...tc,
      id: String(tc.id),
      price: Number(tc.price) || 0
    }));
    if (allTickets.length === 0) return null;

    const isGuest = !memberInfo;
    const userRoleId = memberInfo?.role_id;

    const getVis = (tc) => {
      if (tc.visibility_mode) return tc.visibility_mode;
      if (tc.is_public === true) return 'members_and_public';
      if (tc.is_public === false) return 'members_only';
      return 'members_and_public';
    };

    const visibleTickets = allTickets.filter(tc => {
      const vis = getVis(tc);
      if (isGuest) {
        if (vis === 'members_only') return false;
        if (tc.role_match_only) return false;
        return true;
      }
      if (vis === 'public_only') return false;
      if (!tc.role_match_only) return true;
      if ((tc.role_ids || []).length === 0) return true;
      return userRoleId && (tc.role_ids || []).includes(userRoleId);
    });

    if (visibleTickets.length === 0) return null;

    const hasAllTracksTicket = visibleTickets.some(tc => tc.all_tracks);
    if (hasAllTracksTicket) return null;

    const accessibleIds = new Set();
    visibleTickets.forEach(tc => {
      (tc.linked_track_ids || []).forEach(id => accessibleIds.add(String(id)));
    });

    if (accessibleIds.size === 0) return null;

    const trackIdToName = {};
    eventTracks.forEach(t => { trackIdToName[String(t.id)] = t.name; });

    const names = new Set();
    accessibleIds.forEach(id => {
      const name = trackIdToName[id];
      if (name) names.add(name);
    });

    return names;
  }, [event, memberInfo]);

  const filteredSessions = useMemo(() => {
    if (!accessibleTrackNames) return sessions;
    return sessions.filter(s => {
      const names = s.track_names || (s.track_name ? [s.track_name] : []);
      if (names.length === 0) return true;
      return names.some(n => accessibleTrackNames.has(n));
    });
  }, [sessions, accessibleTrackNames]);

  const filteredTrackColorMap = useMemo(() => {
    if (!accessibleTrackNames) return trackColorMap;
    const filtered = {};
    Object.entries(trackColorMap).forEach(([name, colors]) => {
      if (accessibleTrackNames.has(name)) {
        filtered[name] = colors;
      }
    });
    return filtered;
  }, [trackColorMap, accessibleTrackNames]);

  const speakerSessionsMap = useMemo(() => {
    const map = {};
    filteredSessions.forEach(s => {
      (s.speaker_ids || []).forEach(speakerId => {
        if (!map[speakerId]) map[speakerId] = [];
        map[speakerId].push(s);
      });
    });
    return map;
  }, [filteredSessions]);

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
            <Link to="/events">
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
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <Link to="/events" className="inline-flex items-center gap-2 text-slate-600 hover:text-slate-900">
            <ArrowLeft className="w-4 h-4" />
            Back to Events
          </Link>
        </div>

        <div className="grid lg:grid-cols-3 gap-8 mb-8">
          <div className="lg:col-span-2 space-y-6">
            {event.image_url && (
              <div className="rounded-xl overflow-hidden shadow-lg">
                <img
                  src={event.image_url}
                  alt={event.title}
                  className="w-full h-64 object-cover"
                  style={getFocalPointStyle(event.image_focal_point)}
                />
              </div>
            )}

            <Card className="border-slate-200 shadow-sm">
              <CardHeader>
                {(event.program_tag || (event.filter_tags && event.filter_tags.length > 0) || event.event_type) && (
                  <div className="flex flex-wrap gap-2 mb-3">
                    {event.event_type && (
                      <Badge className="bg-purple-100 text-purple-700 border-purple-200">
                        {event.event_type}
                      </Badge>
                    )}
                    {event.program_tag && (
                      <Badge className="bg-purple-100 text-purple-700 border-purple-200">
                        {event.program_tag}
                      </Badge>
                    )}
                    {event.filter_tags && event.filter_tags.length > 0 && event.filter_tags.map((tag, index) => (
                      <Badge key={index} className="bg-purple-100 text-purple-700 border-purple-200">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
                <h1 className="text-3xl font-bold text-slate-900 mb-2" data-testid="text-event-title">
                  {event.title}
                </h1>
                {event.status === 'tbc' && (
                  <Badge variant="outline" className="border-amber-300 text-amber-600 mb-2">Dates TBC</Badge>
                )}

                <div className="space-y-3 pt-4">
                  {event.start_date && (
                    <div className="flex items-center gap-3 text-slate-700">
                      <Calendar className="w-5 h-5 text-slate-400" />
                      <span className="font-medium">{formatDate(event.start_date, tz, "EEEE, MMMM d, yyyy")}</span>
                      {event.end_date && !isSameDay(parseISO(event.start_date), parseISO(event.end_date)) && (
                        <span className="text-slate-500">- {formatDate(event.end_date, tz, "MMMM d, yyyy")}</span>
                      )}
                    </div>
                  )}

                  {event.start_date && (
                    <div className="flex items-center gap-3 text-slate-700">
                      <Clock className="w-5 h-5 text-slate-400" />
                      <span>{formatTime(event.start_date, tz)}</span>
                      {event.end_date && (
                        <span className="text-slate-500">- {formatTime(event.end_date, tz)}</span>
                      )}
                    </div>
                  )}

                  {event.location && (
                    <div className="flex items-center gap-3 text-slate-700">
                      <MapPin className="w-5 h-5 text-slate-400" />
                      <span>{event.location}</span>
                    </div>
                  )}

                  {event.show_seat_count !== false && (
                    <div className="flex items-center gap-3 text-slate-700">
                      <Users className="w-5 h-5 text-slate-400" />
                      {(event.available_seats === 0 || event.available_seats === null) ? (
                        <span className="text-green-600 font-medium">Open Registration</span>
                      ) : event.available_seats > 0 ? (
                        <span className="text-green-600 font-medium">{event.available_seats} places available</span>
                      ) : (
                        <span className="text-red-600 font-medium">Sold out</span>
                      )}
                    </div>
                  )}

                  {filteredSessions.length > 0 && (
                    <div className="flex items-center gap-3 text-slate-700">
                      <Layers className="w-5 h-5 text-slate-400" />
                      <span>{filteredSessions.length} session{filteredSessions.length !== 1 ? 's' : ''}</span>
                    </div>
                  )}
                </div>
              </CardHeader>
            </Card>
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

            {filteredSessions.length > 0 && (
              <Card className="border-slate-200">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Calendar className="w-5 h-5 text-indigo-600" />
                    Schedule
                  </CardTitle>
                  {Object.keys(filteredTrackColorMap).length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {Object.entries(filteredTrackColorMap).map(([track, colors]) => (
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
                  <ScrollableSchedule
                    sessions={filteredSessions}
                    timezone={tz}
                    trackColorMap={filteredTrackColorMap}
                    eventTracks={event?.tracks || []}
                    speakerMap={speakerMap}
                    eventImageUrl={event?.image_url}
                    eventImageFocalPoint={event?.image_focal_point}
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
                    {speakers.map(speaker => {
                      const displayName = speaker.full_name || speaker.name || '?';
                      const speakerSessions = speakerSessionsMap[speaker.id] || [];
                      return (
                        <button
                          key={speaker.id}
                          onClick={() => { setSelectedSpeaker(speaker); setShowSpeakerModal(true); }}
                          className="flex items-start gap-3 p-3 rounded-lg border border-slate-200 hover:border-purple-300 hover:bg-purple-50 transition-colors text-left"
                          data-testid={`button-speaker-${speaker.id}`}
                        >
                          <Avatar className="h-12 w-12 shrink-0">
                            {speaker.profile_photo_url ? (
                              <AvatarImage src={speaker.profile_photo_url} alt={displayName} />
                            ) : null}
                            <AvatarFallback className="bg-purple-100 text-purple-700">
                              {displayName.charAt(0)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <div className="font-medium text-slate-900">{displayName}</div>
                            {speaker.job_title && <div className="text-xs text-slate-500">{speaker.job_title}</div>}
                            {speaker.organization && <div className="text-xs text-slate-500">{speaker.organization}</div>}
                            {speakerSessions.length > 0 && (
                              <div className="mt-1.5 space-y-0.5">
                                <p className="text-xs text-slate-400" data-testid={`speaker-speaking-at-${speaker.id}`}>Speaking at</p>
                                {speakerSessions.map(s => (
                                  <div key={s.id} className="text-xs text-purple-600 truncate" data-testid={`speaker-session-${speaker.id}-${s.id}`}>
                                    {s.title}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          <div className="space-y-6">
            <BookingSection
              event={event}
              sessions={sessions}
              memberInfo={memberInfo}
              organizationInfo={organizationInfo}
              cart={cart}
              setCart={setCart}
              onBookingComplete={() => { setCart({}); }}
            />
          </div>
        </div>
      </div>

      <Dialog open={showSpeakerModal} onOpenChange={setShowSpeakerModal}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{selectedSpeaker?.full_name || selectedSpeaker?.name}</DialogTitle>
          </DialogHeader>
          {selectedSpeaker && (() => {
            const modalDisplayName = selectedSpeaker.full_name || selectedSpeaker.name || '?';
            const modalSpeakerSessions = speakerSessionsMap[selectedSpeaker.id] || [];
            return (
              <div className="space-y-4">
                <div className="flex items-center gap-4">
                  <Avatar className="h-16 w-16">
                    {selectedSpeaker.profile_photo_url ? (
                      <AvatarImage src={selectedSpeaker.profile_photo_url} alt={modalDisplayName} />
                    ) : null}
                    <AvatarFallback className="bg-purple-100 text-purple-700 text-lg">
                      {modalDisplayName.charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <div className="font-medium text-slate-900">{modalDisplayName}</div>
                    {selectedSpeaker.job_title && <div className="text-sm text-slate-500">{selectedSpeaker.job_title}</div>}
                    {selectedSpeaker.organization && <div className="text-sm text-slate-500">{selectedSpeaker.organization}</div>}
                  </div>
                </div>
                {modalSpeakerSessions.length > 0 && (
                  <div>
                    <div className="text-sm font-medium text-slate-700 mb-1">Sessions</div>
                    <div className="space-y-1">
                      {modalSpeakerSessions.map(s => (
                        <div key={s.id} className="text-sm text-purple-600" data-testid={`modal-speaker-session-${s.id}`}>{s.title}</div>
                      ))}
                    </div>
                  </div>
                )}
                {(selectedSpeaker.biography || selectedSpeaker.bio) && (
                  <div
                    className="prose prose-slate max-w-none text-sm"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(selectedSpeaker.biography || selectedSpeaker.bio) }}
                  />
                )}
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

    </div>
  );
}
