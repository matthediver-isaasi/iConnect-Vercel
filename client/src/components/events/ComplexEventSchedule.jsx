// Reusable complex-event schedule / programme view.
//
// These components were originally defined inline in
// `client/src/pages/ComplexEventDetail.jsx` and power the session + track
// timeline shown on the complex event registration page. They are extracted
// here so the same view can be reused elsewhere (e.g. the Canvas Builder
// "Event sessions" block) without duplicating the rendering logic.
//
// `ComplexEventProgramme` is a self-contained wrapper that fetches a complex
// event, its sessions and speakers via the tenant-scoped public API and
// renders the schedule — useful when you only have an event id/slug.
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Calendar, MapPin, Clock, Layers, Mic, Video, Monitor, Building2,
  ChevronLeft, ChevronRight, ChevronDown, Loader2,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import DOMPurify from "dompurify";
import { computeTimelineLayout } from "@/lib/timelineUtils";
import { getFocalPointStyle } from "@/components/FocalPointPicker";
import { toast } from "sonner";
import { publicClient } from "@/api/publicClient";

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


function HScrollContainer({ children, trackCount }) {
  const scrollRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 8);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 8);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    checkScroll();
    const ro = new ResizeObserver(checkScroll);
    ro.observe(el);
    el.addEventListener('scroll', checkScroll, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener('scroll', checkScroll); };
  }, [checkScroll, trackCount]);

  const scrollBy = useCallback((direction) => {
    const el = scrollRef.current;
    if (!el) return;
    const colWidth = (el.scrollWidth - 100) / (trackCount || 1);
    el.scrollTo({ left: el.scrollLeft + (direction * colWidth), behavior: 'smooth' });
  }, [trackCount]);

  return (
    <div className="relative">
      {canScrollLeft && (
        <>
          <div className="absolute top-0 bottom-0 left-0 w-12 bg-gradient-to-r from-white to-transparent z-10 pointer-events-none" />
          <button
            onClick={() => scrollBy(-1)}
            className="absolute top-1/2 left-1 -translate-y-1/2 z-20 w-8 h-8 rounded-full bg-white border border-slate-200 shadow-md flex items-center justify-center text-slate-500 hover:text-slate-700 hover:shadow-lg transition-all"
            data-testid="button-scroll-tracks-left"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </>
      )}
      <div ref={scrollRef} className="overflow-x-auto">
        <div className="min-w-[600px]">
          {children}
        </div>
      </div>
      {canScrollRight && (
        <>
          <div className="absolute top-0 bottom-0 right-0 w-12 bg-gradient-to-l from-white to-transparent z-10 pointer-events-none" />
          <button
            onClick={() => scrollBy(1)}
            className="absolute top-1/2 right-1 -translate-y-1/2 z-20 w-8 h-8 rounded-full bg-white border border-slate-200 shadow-md flex items-center justify-center text-slate-500 hover:text-slate-700 hover:shadow-lg transition-all"
            data-testid="button-scroll-tracks-right"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </>
      )}
    </div>
  );
}

function ScheduleGrid({ sessions, timezone, trackColorMap, eventTracks, speakerMap = {}, onSessionClick }) {
  // Task #3266: multi-day events default to all days collapsed; user toggles
  // are stored as overrides so the default applies until a day is clicked.
  const [dayOverrides, setDayOverrides] = useState({});

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

  const defaultCollapsed = sessionsByDay.length > 1;
  const isDayCollapsed = (dateKey) => dayOverrides[dateKey] !== undefined ? dayOverrides[dateKey] : defaultCollapsed;
  const toggleDay = (dateKey) => setDayOverrides(prev => ({ ...prev, [dateKey]: !isDayCollapsed(dateKey) }));

  const allTracks = useMemo(() => {
    const trackSet = new Set();
    sessions.forEach(s => {
      const names = s.track_names || (s.track_name ? [s.track_name] : []);
      names.forEach(n => trackSet.add(n));
    });
    const allowed = Object.keys(trackColorMap).length > 0
      ? new Set(Object.keys(trackColorMap))
      : null;
    const seen = new Set();
    const ordered = (eventTracks || [])
      .map(t => t.name)
      .filter(n => n && trackSet.has(n) && (!allowed || allowed.has(n)) && !seen.has(n) && seen.add(n));
    const orderedSet = seen;
    const extras = Array.from(trackSet).filter(n => !orderedSet.has(n) && (!allowed || allowed.has(n)));
    return [...ordered, ...extras];
  }, [sessions, trackColorMap, eventTracks]);

  const hasAnyUntracked = useMemo(() => {
    return sessions.some(s => {
      const names = s.track_names || (s.track_name ? [s.track_name] : []);
      return names.length === 0;
    });
  }, [sessions]);

  const totalColumns = allTracks.length + (hasAnyUntracked ? 1 : 0);

  if (sessionsByDay.length === 0) return null;

  return (
    <div className="space-y-8">
      {sessionsByDay.map((day, dayIndex) => {
        const layout = computeTimelineLayout(day.sessions, { timezone, pixelsPerMinute: 2, minCardHeight: 40 });
        const collapsed = isDayCollapsed(day.date);
        // Day time range: earliest session start to latest session end
        // (fall back to start_time + duration, then start_time alone).
        let dayStart = null;
        let dayEnd = null;
        day.sessions.forEach(s => {
          if (!s.start_time) return;
          const start = new Date(s.start_time);
          if (Number.isNaN(start.getTime())) return;
          let end = s.end_time ? new Date(s.end_time) : null;
          if ((!end || Number.isNaN(end.getTime())) && s.duration_minutes) {
            end = new Date(start.getTime() + Number(s.duration_minutes) * 60000);
          }
          if (!end || Number.isNaN(end.getTime())) end = start;
          if (!dayStart || start < dayStart) dayStart = start;
          if (!dayEnd || end > dayEnd) dayEnd = end;
        });

        return (
          <div key={dayIndex} data-testid={`schedule-day-${dayIndex}`}>
            <button
              type="button"
              onClick={() => toggleDay(day.date)}
              className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2 flex-wrap hover-elevate active-elevate-2 rounded-md px-2 py-1 -ml-2 w-auto text-left"
              data-testid={`schedule-day-toggle-${dayIndex}`}
            >
              {collapsed ? <ChevronRight className="w-5 h-5 text-indigo-600" /> : <ChevronDown className="w-5 h-5 text-indigo-600" />}
              <Calendar className="w-5 h-5 text-indigo-600" />
              {formatDate(day.date, timezone)}
              {collapsed && dayStart && (
                <span className="text-sm font-normal text-slate-600" data-testid={`schedule-day-times-${dayIndex}`}>
                  {formatTime(dayStart, timezone)}{dayEnd && dayEnd > dayStart ? ` - ${formatTime(dayEnd, timezone)}` : ''}
                </span>
              )}
              <span className="text-sm font-normal text-slate-500">({day.sessions.length} sessions)</span>
            </button>

            {collapsed ? null : <HScrollContainer trackCount={totalColumns}>
                {(allTracks.length > 0) && (
                  <div className="flex gap-1 mb-2">
                    <div className="text-xs font-medium text-slate-500 uppercase tracking-wider p-2 sticky left-0 bg-white z-[1]" style={{ width: 100, minWidth: 100 }}>Time</div>
                    <div className="flex gap-1 flex-1">
                      {allTracks.map(track => {
                        const colors = trackColorMap[track];
                        const hasCustom = colors?.bgStyle;
                        return (
                          <div
                            key={track}
                            className={`text-xs font-semibold p-2 rounded-md text-center flex-1 ${hasCustom ? '' : 'bg-slate-100 text-slate-700'}`}
                            style={{ ...(hasCustom ? { ...colors.bgStyle, ...colors.textStyle } : {}), minWidth: 180 }}
                            data-testid={`track-header-${track}`}
                          >
                            {track}
                          </div>
                        );
                      })}
                      {hasAnyUntracked && (
                        <div className="text-xs font-semibold p-2 rounded-md text-center flex-1 bg-slate-100 text-slate-700" style={{ minWidth: 180 }}>
                          General
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {layout.totalHeight > 0 ? (
                  <div className="flex gap-1">
                    <div className="relative sticky left-0 bg-white z-[1]" style={{ width: 100, minWidth: 100, height: layout.totalHeight }}>
                      {layout.timeMarkers.map((marker, i) => (
                        <div key={i} className="absolute text-sm font-medium text-slate-600 pr-2 w-full text-right" style={{ top: marker.top }}>
                          {marker.label}
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-1 flex-1" style={{ height: layout.totalHeight }}>
                      {(allTracks.length > 0 ? allTracks : [null]).map(trackName => {
                        const isUntracked = trackName === null;
                        const trackSessions = day.sessions.filter(s => {
                          const names = s.track_names || (s.track_name ? [s.track_name] : []);
                          if (isUntracked) return names.length === 0;
                          return names.includes(trackName);
                        });
                        const colors = isUntracked ? null : trackColorMap[trackName];
                        return (
                          <div key={trackName || "untracked"} className="relative flex-1" style={{ minWidth: 180 }}>
                            {layout.timeMarkers.map((marker, i) => (
                              <div key={i} className="absolute left-0 right-0 border-t border-slate-100" style={{ top: marker.top }} />
                            ))}
                            {trackSessions.map(session => {
                              const sid = session.id;
                              const sl = layout.sessionLayouts[sid];
                              if (!sl) return null;
                              const isMultiTrack = (session.track_names || []).length > 1;
                              return (
                                <div key={`${sid}-${trackName}`} className="absolute left-0 right-0 px-0.5" style={{ top: sl.top, height: sl.height }}>
                                  <SessionCard session={session} timezone={timezone} colors={colors} isMultiTrack={isMultiTrack} speakerMap={speakerMap} onClick={onSessionClick} fixedHeight={sl.height - 2} />
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                      {hasAnyUntracked && allTracks.length > 0 && (
                        <div className="relative flex-1" style={{ minWidth: 180 }}>
                          {layout.timeMarkers.map((marker, i) => (
                            <div key={i} className="absolute left-0 right-0 border-t border-slate-100" style={{ top: marker.top }} />
                          ))}
                          {day.sessions.filter(s => {
                            const names = s.track_names || (s.track_name ? [s.track_name] : []);
                            return names.length === 0;
                          }).map(session => {
                            const sid = session.id;
                            const sl = layout.sessionLayouts[sid];
                            if (!sl) return null;
                            return (
                              <div key={sid} className="absolute left-0 right-0 px-0.5" style={{ top: sl.top, height: sl.height }}>
                                <SessionCard session={session} timezone={timezone} colors={null} speakerMap={speakerMap} onClick={onSessionClick} fixedHeight={sl.height - 2} />
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  day.sessions.map(session => (
                    <div key={session.id} className="mb-2">
                      <SessionCard session={session} timezone={timezone} colors={trackColorMap[session.track_name]} speakerMap={speakerMap} onClick={onSessionClick} />
                    </div>
                  ))
                )}
            </HScrollContainer>}
          </div>
        );
      })}
    </div>
  );
}

function SessionCard({ session, timezone, colors, isMultiTrack = false, speakerMap = {}, onClick, fixedHeight }) {
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

  const cardStyle = {
    ...(hasCustomColors ? { ...colors.lightStyle, ...colors.borderStyle } : {}),
    ...(fixedHeight != null ? { height: `${fixedHeight}px` } : {}),
  };

  return (
    <div
      className={`p-2 rounded-md border cursor-pointer transition-shadow hover:shadow-md overflow-hidden ${hasCustomColors ? '' : fallbackClass}`}
      style={cardStyle}
      data-testid={`session-card-${session.id}`}
      onClick={() => onClick?.(session)}
    >
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-sm text-slate-900 truncate">{session.title}</span>
        {isMultiTrack && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            <Layers className="h-2.5 w-2.5 mr-0.5" />Multi-Track
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-slate-600 mt-0.5">
        <Clock className="w-3 h-3 shrink-0" />
        <span className="truncate">
          {formatTime(session.start_time, timezone)}
          {session.end_time && ` - ${formatTime(session.end_time, timezone)}`}
        </span>
        {session.duration_minutes && (
          <span className="text-slate-400 shrink-0">({session.duration_minutes} min)</span>
        )}
      </div>
      {session.description && (
        <p className="text-xs text-slate-500 line-clamp-2 mt-0.5" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(session.description) }} />
      )}
      {sessionSpeakers.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap mt-0.5">
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
        <div className="flex items-center gap-1 text-xs text-slate-600 mt-0.5">
          <Mic className="w-3 h-3 shrink-0" />
          <span className="truncate">{fallbackSpeakerNames.join(", ")}</span>
        </div>
      )}
      <div className="flex items-center gap-1 flex-wrap mt-1">
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

function ChangeSessionZoomDialog({ session, open, onOpenChange }) {
  const [type, setType] = useState(session?.zoom_meeting_id ? 'meeting' : 'webinar');
  const [targetId, setTargetId] = useState('');
  const [cancelOld, setCancelOld] = useState(true);
  const [registerNew, setRegisterNew] = useState(true);
  const [resend, setResend] = useState(true);
  const [convertToInPerson, setConvertToInPerson] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [items, setItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [impactCount, setImpactCount] = useState(null);

  useEffect(() => {
    if (!open) return;
    setType(session?.zoom_meeting_id ? 'meeting' : 'webinar');
    setTargetId('');
    setConvertToInPerson(false);
    setImpactCount(null);
    if (session?.id) {
      fetch(`/api/complex-event-sessions/${session.id}/change-zoom`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then(d => setImpactCount(d?.confirmedBookings ?? null))
        .catch(() => setImpactCount(null));
    }
  }, [open, session?.id]);

  useEffect(() => {
    if (!open) return;
    setLoadingItems(true);
    fetch(`/api/zoom/${type === 'meeting' ? 'meetings' : 'webinars'}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => setItems(Array.isArray(d) ? d : (d?.data || [])))
      .catch(() => setItems([]))
      .finally(() => setLoadingItems(false));
  }, [open, type]);

  const submit = async (clearOnly = false) => {
    if (!session) return;
    if (!clearOnly && !targetId) {
      toast.error(`Please select a ${type}`);
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        zoom_webinar_id: clearOnly ? null : (type === 'webinar' ? targetId : null),
        zoom_meeting_id: clearOnly ? null : (type === 'meeting' ? targetId : null),
        cancelOld,
        registerNew: clearOnly ? false : registerNew,
        resendConfirmations: clearOnly ? false : resend,
        convert_to_in_person: clearOnly ? convertToInPerson : false,
      };
      const resp = await fetch(`/api/complex-event-sessions/${session.id}/change-zoom`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || 'Change Zoom failed');
      }
      const result = await resp.json();
      toast.success(`Zoom updated. Cancelled ${result.cancelled || 0}, registered ${result.registered || 0}, emailed ${result.emailed || 0}.`);
      onOpenChange(false);
      window.location.reload();
    } catch (err) {
      toast.error('Failed: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!session) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid={`dialog-change-session-zoom-${session.id}`}>
        <DialogHeader>
          <DialogTitle>Change Session Zoom Link</DialogTitle>
          <DialogDescription>
            Re-link this session to a different Zoom {type}. Confirmed bookings whose ticket grants access to this session can be cancelled, re-registered, and re-emailed.
            {impactCount !== null && (
              <span className="block mt-2 font-medium text-slate-900" data-testid="text-session-zoom-impact">
                Impact: {impactCount} confirmed booking{impactCount === 1 ? '' : 's'} would be affected.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label className="mb-2 block">Type</Label>
            <div className="flex gap-2">
              <Button type="button" variant={type === 'webinar' ? 'default' : 'outline'} size="sm" onClick={() => { setType('webinar'); setTargetId(''); }} data-testid="button-session-zoom-type-webinar">Webinar</Button>
              <Button type="button" variant={type === 'meeting' ? 'default' : 'outline'} size="sm" onClick={() => { setType('meeting'); setTargetId(''); }} data-testid="button-session-zoom-type-meeting">Meeting</Button>
            </div>
          </div>
          <div>
            <Label className="mb-2 block">Target {type}</Label>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="w-full p-2 border rounded-md text-sm"
              data-testid="select-session-zoom-target"
            >
              <option value="">{loadingItems ? 'Loading…' : `Select a ${type}`}</option>
              {items.map(it => (
                <option key={it.id} value={it.id}>{it.topic || it.title || it.id}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2 pt-2 border-t">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox checked={cancelOld} onCheckedChange={(v) => setCancelOld(!!v)} data-testid="checkbox-session-zoom-cancel-old" />
              Cancel previous Zoom registrants
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox checked={registerNew} onCheckedChange={(v) => setRegisterNew(!!v)} data-testid="checkbox-session-zoom-register-new" />
              Register confirmed attendees with new Zoom
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox checked={resend} onCheckedChange={(v) => setResend(!!v)} data-testid="checkbox-session-zoom-resend" />
              Resend confirmation emails with new join link
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer pt-1 border-t">
              <Checkbox checked={convertToInPerson} onCheckedChange={(v) => setConvertToInPerson(!!v)} data-testid="checkbox-session-zoom-convert-in-person" />
              When clearing Zoom: also convert this session to In-Person (delivery_mode)
            </label>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting} data-testid="button-session-zoom-cancel">Cancel</Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              const msg = convertToInPerson
                ? 'Clear Zoom link AND convert session to In-Person?'
                : 'Clear Zoom link from this session? It will remain Online with no join link until you set one.';
              if (confirm(msg)) submit(true);
            }}
            disabled={submitting}
            data-testid="button-session-zoom-clear"
          >
            Clear Zoom Link
          </Button>
          <Button type="button" onClick={() => submit(false)} disabled={submitting || !targetId} data-testid="button-session-zoom-confirm">
            {submitting ? (<><Loader2 className="h-4 w-4 mr-2 animate-spin" />Updating…</>) : 'Update Zoom Link'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ExpandedSessionModal({ session, open, onOpenChange, timezone, speakerMap, eventImageUrl, eventImageFocalPoint, isAdmin }) {
  const [showChangeZoom, setShowChangeZoom] = useState(false);
  const sessionSpeakers = useMemo(() => {
    if (session?.speaker_ids?.length) {
      return session.speaker_ids.map(id => speakerMap[id]).filter(Boolean);
    }
    return [];
  }, [session?.speaker_ids, speakerMap]);

  const fallbackSpeakerNames = sessionSpeakers.length === 0 && session?.speaker_names?.length > 0
    ? session.speaker_names
    : [];

  const hasOwnImage = !!session?.image_url;
  const imageUrl = session?.image_url || eventImageUrl || null;
  const imageFocalPoint = hasOwnImage ? session?.image_focal_point : eventImageFocalPoint;

  if (!session) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0 overflow-hidden" data-testid={`session-expanded-${session.id}`}>
        <DialogHeader className="sr-only">
          <DialogTitle>{session.title}</DialogTitle>
        </DialogHeader>
        {imageUrl && (
          <div className="h-48 shrink-0 overflow-hidden bg-slate-100">
            <img src={imageUrl} alt={session.title} className="w-full h-full object-cover" style={getFocalPointStyle(imageFocalPoint)} />
          </div>
        )}
        <div className="overflow-y-auto p-5 space-y-4">
          <h3 className="text-lg font-semibold text-slate-900">{session.title}</h3>

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

          {isAdmin && (
            <div className="pt-3 border-t flex items-center justify-between gap-3">
              <div className="text-xs text-slate-500">
                {session.zoom_webinar_id || session.zoom_meeting_id
                  ? `Linked to Zoom ${session.zoom_type || (session.zoom_webinar_id ? 'webinar' : 'meeting')}`
                  : 'No Zoom link assigned'}
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setShowChangeZoom(true)}
                data-testid={`button-session-change-zoom-${session.id}`}
              >
                <Video className="w-4 h-4 mr-1.5" />
                Change Zoom Link
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
      {isAdmin && (
        <ChangeSessionZoomDialog session={session} open={showChangeZoom} onOpenChange={setShowChangeZoom} />
      )}
    </Dialog>
  );
}

function ScrollableSchedule({ sessions, timezone, trackColorMap, eventTracks, speakerMap, eventImageUrl, eventImageFocalPoint, isAdmin, maxHeight }) {
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
      {canScrollUp && (
        <div className="absolute top-0 left-0 right-0 h-8 bg-gradient-to-b from-white to-transparent z-10 pointer-events-none" />
      )}
      <div ref={scrollRef} className="overflow-y-auto pr-4" style={{ maxHeight: maxHeight || 500 }}>
        <ScheduleGrid
          sessions={sessions}
          timezone={timezone}
          trackColorMap={trackColorMap}
          eventTracks={eventTracks}
          speakerMap={speakerMap}
          onSessionClick={setExpandedSession}
        />
      </div>
      {canScrollDown && (
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
      <ExpandedSessionModal
        session={expandedSession}
        open={!!expandedSession}
        onOpenChange={(open) => { if (!open) setExpandedSession(null); }}
        timezone={timezone}
        speakerMap={speakerMap}
        eventImageUrl={eventImageUrl}
        eventImageFocalPoint={eventImageFocalPoint}
        isAdmin={isAdmin}
      />
    </div>
  );
}

// Build the track -> colour-style map used by the schedule grid. Tracks with a
// configured colour (on the track record or a session) keep that colour;
// anything else cycles through the fallback palette. Shared so callers don't
// have to re-derive the mapping.
function buildTrackColorMap(sessions, eventTracks = []) {
  const map = {};
  const tracksByName = {};
  (eventTracks || []).forEach((t) => { if (t.name) tracksByName[t.name] = t; });

  const trackNames = new Set();
  (sessions || []).forEach((s) => {
    const names = s.track_names || (s.track_name ? [s.track_name] : []);
    names.forEach((n) => trackNames.add(n));
  });

  const seenColors = new Set();
  const orderedTrackNames = (eventTracks || [])
    .map((t) => t.name)
    .filter((n) => n && trackNames.has(n) && !seenColors.has(n) && seenColors.add(n));
  const orderedSet = seenColors;
  const extraNames = Array.from(trackNames).filter((n) => !orderedSet.has(n));
  const sortedTrackNames = [...orderedTrackNames, ...extraNames];

  let fallbackIdx = 0;
  sortedTrackNames.forEach((trackName) => {
    const dbTrack = tracksByName[trackName];
    const sessionWithColour = (sessions || []).find((s) => s.track_name === trackName && s.track_colour);
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
}

// Self-contained programme view: give it a complex-event id (or slug) and it
// fetches everything it needs and renders the session + track schedule. Always
// renders in public (non-admin) mode.
function ComplexEventProgramme({ eventId, eventSlug, maxHeight, emptyText, asEditor }) {
  const { data: resolved } = useQuery({
    queryKey: ["canvas", "complex-event-by-slug", eventSlug],
    queryFn: () => publicClient.getComplexEventBySlug(eventSlug),
    enabled: !!eventSlug && !eventId,
    staleTime: 60_000,
  });
  const id = eventId || resolved?.id || null;

  const { data: event, isLoading: eventLoading, isError } = useQuery({
    queryKey: ["canvas", "complex-event", id],
    queryFn: () => publicClient.getComplexEvent(id),
    enabled: !!id,
    staleTime: 60_000,
  });

  const { data: sessions = [], isLoading: sessionsLoading } = useQuery({
    queryKey: ["canvas", "complex-event-sessions", id],
    queryFn: async () => (await publicClient.getComplexEventSessions(id)) || [],
    enabled: !!id,
    staleTime: 60_000,
  });

  const allSpeakerIds = useMemo(() => {
    const ids = new Set(event?.speaker_ids || []);
    sessions.forEach((s) => (s.speaker_ids || []).forEach((sid) => ids.add(sid)));
    return [...ids];
  }, [event?.speaker_ids, sessions]);

  const { data: speakers = [] } = useQuery({
    queryKey: ["canvas", "complex-event-speakers", allSpeakerIds],
    queryFn: async () => (await publicClient.listSpeakers(allSpeakerIds)) || [],
    enabled: allSpeakerIds.length > 0,
    staleTime: 60_000,
  });

  const speakerMap = useMemo(() => {
    const m = {};
    speakers.forEach((s) => { m[s.id] = s; });
    return m;
  }, [speakers]);

  const tz = event?.timezone || DEFAULT_TIMEZONE;
  const eventTracks = event?.tracks || [];
  const trackColorMap = useMemo(() => buildTrackColorMap(sessions, eventTracks), [sessions, eventTracks]);

  if (!id) {
    return (
      <div className="flex items-center justify-center h-full min-h-[120px] text-sm text-slate-500 text-center px-4" data-testid="event-sessions-empty-picker">
        Pick a multi-session event in the inspector to show its programme.
      </div>
    );
  }
  if (eventLoading || sessionsLoading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[120px] text-slate-400" data-testid="event-sessions-loading">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex items-center justify-center h-full min-h-[120px] text-sm text-slate-500 text-center px-4" data-testid="event-sessions-error">
        This event could not be loaded.
      </div>
    );
  }
  if (!sessions.length) {
    return (
      <div className="flex items-center justify-center h-full min-h-[120px] text-sm text-slate-500 text-center px-4" data-testid="event-sessions-empty">
        {emptyText || "No sessions have been published for this event yet."}
      </div>
    );
  }

  const trackNames = Object.keys(trackColorMap);

  return (
    <div className="w-full">
      {trackNames.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {trackNames.map((track) => {
            const colors = trackColorMap[track];
            return (
              <Badge
                key={track}
                variant="outline"
                className="text-xs border-0"
                style={{ ...(colors.bgStyle || {}), ...(colors.textStyle || {}) }}
              >
                {track}
              </Badge>
            );
          })}
        </div>
      )}
      <ScrollableSchedule
        sessions={sessions}
        timezone={tz}
        trackColorMap={trackColorMap}
        eventTracks={eventTracks}
        speakerMap={speakerMap}
        eventImageUrl={event?.image_url}
        eventImageFocalPoint={event?.image_focal_point}
        isAdmin={false}
        maxHeight={maxHeight}
      />
    </div>
  );
}

export {
  DEFAULT_TIMEZONE,
  FALLBACK_TRACK_COLORS,
  buildTrackColorStyles,
  buildTrackColorMap,
  formatTime,
  formatDate,
  formatDateShort,
  ScheduleGrid,
  SessionCard,
  ExpandedSessionModal,
  ScrollableSchedule,
  ComplexEventProgramme,
};
