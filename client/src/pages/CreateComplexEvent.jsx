import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "sonner";
import {
  ArrowLeft, Save, Loader2, Plus, Trash2, ChevronDown, ChevronUp, ChevronRight,
  Calendar, MapPin, Monitor, Ticket, Users, Globe, PoundSterling,
  Bird, Check, X, Mic, Eye, Tag, Clock, Pencil, Video, LinkIcon,
  Layers, Building2, Handshake, AlertTriangle, AlertCircle, Mail, Bell, Download, FileText, Code, QrCode
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { TimezoneAwareDateTimeInput } from "@/components/events/TimezoneAwareDateTimeInput";
import EventClashWarningDialog from "@/components/events/EventClashWarningDialog";
import { checkEventClashes } from "@/lib/eventClash";
import DOMPurify from "dompurify";
import { computeTimelineLayout } from "@/lib/timelineUtils";
import { useEventTypes } from "@/hooks/useEventTypes";
import { useMemberGroupSettings } from "@/hooks/useMemberGroupSettings";
import { createFilterTagKey, parseFilterTagKey, normalizeFilterTags, parseEventTypes, serializeEventTypes } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";
import EventImageUpload from "@/components/events/EventImageUpload";
import EventDocumentsManager from "@/components/events/EventDocumentsManager";
import EventSurveysSection from "@/components/surveys/EventSurveysSection";
import EventOptionListsEditor from "@/components/events/EventOptionListsEditor";
import { isAttendeeOptionsCollectionEnabled } from "@/lib/attendeeOptionsSetting";
import ZoomSessionConfig from "@/components/events/ZoomSessionConfig";
import ChangeZoomDialog from "@/components/events/ChangeZoomDialog";
import { FocalPointPicker } from "@/components/FocalPointPicker";
import SEOSettings from "@/components/blog/SEOSettings";
import UnfurlPreview from "@/components/UnfurlPreview";
import { SpeakerSelectionModal } from "@/components/SpeakerSelectionModal";
import SpeakerAwardsSection, { configToFormState, formStateToConfig } from "@/components/events/SpeakerAwardsSection";
import EventSponsorSelector from "@/components/events/EventSponsorSelector";
import ReactQuill from "react-quill";
import "react-quill/dist/quill.snow.css";
import EventEmailSettingsEditor, {
  createEmptyEmail,
  formatSchedulingFailures,
  formatSkippedSummary,
  findInvalidCcAddresses,
  mapEmailSaveFailureDetails,
  putEventEmails,
} from "@/components/events/EventEmailSettingsEditor";

const TIMEZONE_OPTIONS = [
  { value: "Europe/London", label: "London (GMT/BST)" },
  { value: "Europe/Dublin", label: "Dublin (GMT/IST)" },
  { value: "Europe/Paris", label: "Paris (CET/CEST)" },
  { value: "Europe/Berlin", label: "Berlin (CET/CEST)" },
  { value: "America/New_York", label: "New York (EST/EDT)" },
  { value: "America/Chicago", label: "Chicago (CST/CDT)" },
  { value: "America/Los_Angeles", label: "Los Angeles (PST/PDT)" },
  { value: "Asia/Dubai", label: "Dubai (GST)" },
  { value: "Asia/Singapore", label: "Singapore (SGT)" },
  { value: "Asia/Tokyo", label: "Tokyo (JST)" },
  { value: "Australia/Sydney", label: "Sydney (AEST/AEDT)" },
  { value: "Pacific/Auckland", label: "Auckland (NZST/NZDT)" },
  { value: "UTC", label: "UTC" },
];

const QUILL_MODULES = {
  toolbar: [
    [{ header: [1, 2, 3, false] }],
    ["bold", "italic", "underline", "strike"],
    [{ color: [] }, { background: [] }],
    [{ list: "ordered" }, { list: "bullet" }],
    [{ align: [] }],
    ["link"],
    ["clean"],
  ],
};

const QUILL_FORMATS = [
  "header", "bold", "italic", "underline", "strike",
  "color", "background", "list", "bullet", "align", "link",
];

const TRACK_COLOURS = [
  "#3B82F6", "#EF4444", "#10B981", "#F59E0B", "#8B5CF6",
  "#EC4899", "#06B6D4", "#F97316", "#6366F1", "#14B8A6",
];

const DEFAULT_TIMEZONE = "Europe/London";

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

function toDateTz(dateStr, tz) {
  if (!dateStr) return null;
  if (typeof dateStr !== "string") return new Date(dateStr);
  const hasOffset = /[+-]\d{2}(:\d{2})?$/.test(dateStr) || dateStr.endsWith("Z");
  if (hasOffset) return parseISO(dateStr);
  return fromZonedTime(dateStr, tz);
}

const scheduleFormatTime = (dateStr, timezone = DEFAULT_TIMEZONE) => {
  if (!dateStr) return "";
  try {
    const date = toDateTz(dateStr, timezone);
    if (!date) return "";
    return formatInTimeZone(date, timezone, "h:mm a");
  } catch {
    return format(new Date(dateStr), "h:mm a");
  }
};

const scheduleFormatDate = (dateStr, timezone = DEFAULT_TIMEZONE, formatStr = "EEEE, MMMM d, yyyy") => {
  if (!dateStr) return "";
  try {
    const date = toDateTz(dateStr, timezone);
    if (!date) return "";
    return formatInTimeZone(date, timezone, formatStr);
  } catch {
    return format(new Date(dateStr), formatStr);
  }
};

function computeGapSlots(sessions, layout, timezone, formatDateForInput) {
  const markers = layout.timeMarkers;
  if (!markers || markers.length < 2) {
    return { gaps: [{ top: 0, startTime: layout.snappedEarliestMs ? formatDateForInput(layout.snappedEarliestMs) : "" }], extraHeight: 0 };
  }

  const sorted = sessions
    .filter(s => layout.sessionLayouts[s._localId])
    .sort((a, b) => layout.sessionLayouts[a._localId].top - layout.sessionLayouts[b._localId].top);

  const occupied = sorted.map(s => {
    const sl = layout.sessionLayouts[s._localId];
    return { top: sl.top, bottom: sl.top + sl.height };
  });
  const merged = [];
  for (const iv of occupied) {
    if (merged.length > 0 && iv.top <= merged[merged.length - 1].bottom) {
      merged[merged.length - 1].bottom = Math.max(merged[merged.length - 1].bottom, iv.bottom);
    } else {
      merged.push({ top: iv.top, bottom: iv.bottom });
    }
  }

  function isSlotOccupied(slotTop, slotBottom) {
    for (const m of merged) {
      if (m.top < slotBottom && m.bottom > slotTop) return true;
      if (m.top >= slotBottom) break;
    }
    return false;
  }

  const gaps = [];
  const BUTTON_HEIGHT = 28;

  for (let i = 0; i < markers.length - 1; i++) {
    const slotTop = markers[i].top;
    const slotBottom = markers[i + 1].top;
    const slotHeight = slotBottom - slotTop;
    if (slotHeight < BUTTON_HEIGHT) continue;
    if (isSlotOccupied(slotTop, slotBottom)) continue;
    const slotMs = layout.snappedEarliestMs + markers[i].minutes * 60000;
    gaps.push({
      top: slotTop + (slotHeight / 2) - (BUTTON_HEIGHT / 2),
      startTime: formatDateForInput(slotMs),
    });
  }

  const lastMarker = markers[markers.length - 1];
  const maxOccupiedBottom = merged.length > 0 ? merged[merged.length - 1].bottom : 0;
  const trailingTop = Math.max(lastMarker.top, maxOccupiedBottom);
  const slotInterval = markers.length >= 2 ? markers[1].top - markers[0].top : 60;
  const trailingMs = layout.snappedEarliestMs + lastMarker.minutes * 60000;
  gaps.push({
    top: trailingTop + (slotInterval / 2) - (BUTTON_HEIGHT / 2),
    startTime: formatDateForInput(trailingMs),
  });
  const extraHeight = trailingTop + slotInterval - layout.totalHeight;

  return { gaps, extraHeight: Math.max(extraHeight, 0) };
}

function AdminSessionCard({ session, timezone, colors, isMultiTrack = false, speakerMap = {}, onEdit, onDelete, fixedHeight }) {
  const hasCustomColors = colors?.lightStyle;
  const fallbackClass = "bg-slate-50 border-slate-300";

  const sessionSpeakers = useMemo(() => {
    if (session.speaker_ids?.length) {
      return session.speaker_ids.map(id => speakerMap[id]).filter(Boolean);
    }
    return [];
  }, [session.speaker_ids, speakerMap]);

  const cardStyle = {
    ...(hasCustomColors ? { ...colors.lightStyle, ...colors.borderStyle } : {}),
    ...(fixedHeight != null ? { height: `${fixedHeight}px` } : {}),
  };

  return (
    <div
      className={`p-2 rounded-md border relative group overflow-hidden ${hasCustomColors ? '' : fallbackClass}`}
      style={cardStyle}
      data-testid={`session-card-${session._localId}`}
    >
      <div className="absolute top-1 right-1 flex gap-0.5 invisible group-hover:visible z-10">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => { e.stopPropagation(); onEdit?.(session); }} data-testid={`button-edit-session-${session._localId}`}>
          <Pencil className="w-3.5 h-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => { e.stopPropagation(); onDelete?.(session._localId); }} data-testid={`button-delete-session-${session._localId}`}>
          <Trash2 className="w-3.5 h-3.5 text-red-500" />
        </Button>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="font-medium text-sm text-slate-900 truncate">{session.title || "Untitled Session"}</span>
        {isMultiTrack && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            <Layers className="h-2.5 w-2.5 mr-0.5" />Multi-Track
          </Badge>
        )}
      </div>
      {session.start_time && (
        <div className="flex items-center gap-2 text-xs text-slate-600 mt-0.5">
          <Clock className="w-3 h-3 shrink-0" />
          <span className="truncate">
            {scheduleFormatTime(session.start_time, timezone)}
            {session.end_time && ` - ${scheduleFormatTime(session.end_time, timezone)}`}
          </span>
          {session.duration_minutes && (
            <span className="text-slate-400 shrink-0">({session.duration_minutes} min)</span>
          )}
        </div>
      )}
      {session.description && (
        <p className="text-xs text-slate-500 line-clamp-2 mt-0.5" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(session.description) }} />
      )}
      {sessionSpeakers.length > 0 ? (
        <div className="flex items-center gap-1 text-xs text-slate-600 mt-0.5">
          <Mic className="w-3 h-3 shrink-0" />
          <span className="truncate">{sessionSpeakers.map(s => s.full_name || s.name).filter(Boolean).join(", ")}</span>
        </div>
      ) : (session.speaker_names?.length > 0 && (
        <div className="flex items-center gap-1 text-xs text-slate-600 mt-0.5">
          <Mic className="w-3 h-3 shrink-0" />
          <span className="truncate">{session.speaker_names.join(", ")}</span>
        </div>
      ))}
      {session.location && (
        <div className="flex items-center gap-1 text-xs text-slate-500 mt-0.5">
          <MapPin className="w-3 h-3 shrink-0" />
          <span className="truncate">{session.location}</span>
        </div>
      )}
      <div className="flex items-center gap-1 flex-wrap mt-1">
        {session.is_online && (
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


function AdminScheduleGrid({ sessions, tracks, timezone, speakerMap = {}, onEdit, onDelete, onAddAtSlot }) {
  const [collapsedDays, setCollapsedDays] = useState({});
  const toggleDay = (dateKey) => setCollapsedDays(prev => ({ ...prev, [dateKey]: !prev[dateKey] }));

  const trackColorMap = useMemo(() => {
    const map = {};
    tracks.forEach(track => {
      const name = track.name || "Untitled Track";
      map[name] = buildTrackColorStyles(track.colour) || buildTrackColorStyles(TRACK_COLOURS[0]);
    });
    return map;
  }, [tracks]);

  const enrichedSessions = useMemo(() => {
    return sessions.map(session => {
      const trackNames = (session.track_ids || []).map(tid => {
        const t = tracks.find(tr => (tr.id || tr._localId) === tid);
        return t ? (t.name || "Untitled Track") : null;
      }).filter(Boolean);
      return { ...session, track_names: trackNames };
    });
  }, [sessions, tracks]);

  const sessionsWithTime = enrichedSessions.filter(s => s.start_time);
  const sessionsWithoutTime = enrichedSessions.filter(s => !s.start_time);

  const sessionsByDay = useMemo(() => {
    const days = {};
    sessionsWithTime.forEach(session => {
      const dateKey = scheduleFormatDate(session.start_time, timezone, "yyyy-MM-dd");
      if (!days[dateKey]) {
        days[dateKey] = { date: session.start_time, sessions: [] };
      }
      days[dateKey].sessions.push(session);
    });
    return Object.values(days).sort((a, b) => new Date(a.date) - new Date(b.date));
  }, [sessionsWithTime, timezone]);

  const allTrackNames = useMemo(() => {
    const usedNames = new Set();
    enrichedSessions.forEach(s => {
      (s.track_names || []).forEach(n => usedNames.add(n));
    });
    const seen = new Set();
    const ordered = tracks
      .map(t => t.name || "Untitled Track")
      .filter(n => usedNames.has(n) && !seen.has(n) && seen.add(n));
    const orderedSet = seen;
    const extras = Array.from(usedNames).filter(n => !orderedSet.has(n));
    return [...ordered, ...extras];
  }, [enrichedSessions, tracks]);

  const hasAnyUntracked = useMemo(() => {
    return enrichedSessions.some(s => (s.track_names || []).length === 0);
  }, [enrichedSessions]);

  const trackNameToId = useMemo(() => {
    const map = {};
    tracks.forEach(track => {
      const name = track.name || "Untitled Track";
      map[name] = track.id || track._localId;
    });
    return map;
  }, [tracks]);


  const formatDateForInput = (ms) => {
    if (!ms || isNaN(ms)) return "";
    const d = new Date(ms);
    try {
      return formatInTimeZone(d, timezone, "yyyy-MM-dd'T'HH:mm");
    } catch {
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  };

  return (
    <div className="space-y-6">
      {sessionsByDay.map((day, dayIndex) => {
        const layout = computeTimelineLayout(day.sessions, { timezone, pixelsPerMinute: 2, minCardHeight: 40 });
        const slotInterval = layout.timeMarkers.length >= 2 ? layout.timeMarkers[1].top - layout.timeMarkers[0].top : 60;
        const gridHeight = layout.totalHeight + slotInterval;

        return (
          <div key={dayIndex} className="mb-4" data-testid={`admin-schedule-day-${dayIndex}`}>
            <button
              type="button"
              onClick={() => toggleDay(day.date)}
              className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2 hover-elevate active-elevate-2 rounded-md px-2 py-1 -ml-2 w-auto"
              data-testid={`admin-schedule-day-toggle-${dayIndex}`}
            >
              {collapsedDays[day.date] ? <ChevronRight className="w-4 h-4 text-indigo-600" /> : <ChevronDown className="w-4 h-4 text-indigo-600" />}
              <Calendar className="w-4 h-4 text-indigo-600" />
              {scheduleFormatDate(day.date, timezone)}
              <span className="text-xs font-normal text-slate-500">({day.sessions.length} sessions)</span>
            </button>

            {collapsedDays[day.date] ? null : <div>
                {allTrackNames.length > 0 && (
                  <div className="flex gap-1 mb-2">
                    <div className="text-xs font-medium text-slate-500 uppercase tracking-wider p-2 sticky left-0 bg-white z-[1]" style={{ width: 80, minWidth: 80 }}>Time</div>
                    <div className="flex gap-1 flex-1">
                      {allTrackNames.map(trackName => {
                        const colors = trackColorMap[trackName];
                        const hasCustom = colors?.bgStyle;
                        return (
                          <div
                            key={trackName}
                            className={`text-xs font-semibold p-2 rounded-md text-center flex-1 ${hasCustom ? '' : 'bg-slate-100 text-slate-700'}`}
                            style={{ ...(hasCustom ? { ...colors.bgStyle, ...colors.textStyle } : {}), minWidth: 180 }}
                            data-testid={`admin-track-header-${trackName}`}
                          >
                            {trackName}
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
                    <div className="relative sticky left-0 bg-white z-[1]" style={{ width: 80, minWidth: 80, height: gridHeight }}>
                      {layout.timeMarkers.map((marker, i) => (
                        <div key={i} className="absolute text-xs font-medium text-slate-600 pr-2 w-full text-right" style={{ top: marker.top }}>
                          {marker.label}
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-1 flex-1" style={{ height: gridHeight }}>
                      {(allTrackNames.length > 0 ? allTrackNames : [null]).map(trackName => {
                        const isUntracked = trackName === null;
                        const trackSessions = day.sessions.filter(s => {
                          const names = s.track_names || [];
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
                              const sid = session._localId;
                              const sl = layout.sessionLayouts[sid];
                              if (!sl) return null;
                              const isMultiTrack = (session.track_names || []).length > 1;
                              return (
                                <div key={`${sid}-${trackName}`} className="absolute left-0 right-0 px-0.5" style={{ top: sl.top, height: sl.height }}>
                                  <AdminSessionCard session={session} timezone={timezone} colors={colors} isMultiTrack={isMultiTrack} speakerMap={speakerMap} onEdit={onEdit} onDelete={onDelete} fixedHeight={sl.height - 2} />
                                </div>
                              );
                            })}
                            {onAddAtSlot && (() => {
                              const trackId = isUntracked ? null : trackNameToId[trackName];
                              const { gaps } = computeGapSlots(trackSessions, layout, timezone, formatDateForInput);
                              return gaps.map((gap, gi) => (
                                <div
                                  key={`gap-${gi}`}
                                  className="absolute left-0 right-0 px-0.5 flex justify-center"
                                  style={{ top: gap.top }}
                                >
                                  <button
                                    type="button"
                                    onClick={() => onAddAtSlot({ startTime: gap.startTime, trackId })}
                                    className="w-full mx-1 py-1.5 border border-dashed border-slate-300 rounded-md flex items-center justify-center gap-1 text-slate-400 hover:text-slate-600 hover:border-slate-400 transition-colors"
                                    data-testid={`button-quick-add-${trackName || 'untracked'}-${gi}`}
                                  >
                                    <Plus className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ));
                            })()}
                          </div>
                        );
                      })}
                      {hasAnyUntracked && allTrackNames.length > 0 && (
                        <div className="relative flex-1" style={{ minWidth: 180 }}>
                          {layout.timeMarkers.map((marker, i) => (
                            <div key={i} className="absolute left-0 right-0 border-t border-slate-100" style={{ top: marker.top }} />
                          ))}
                          {day.sessions.filter(s => (s.track_names || []).length === 0).map(session => {
                            const sid = session._localId;
                            const sl = layout.sessionLayouts[sid];
                            if (!sl) return null;
                            return (
                              <div key={sid} className="absolute left-0 right-0 px-0.5" style={{ top: sl.top, height: sl.height }}>
                                <AdminSessionCard session={session} timezone={timezone} colors={null} speakerMap={speakerMap} onEdit={onEdit} onDelete={onDelete} fixedHeight={sl.height - 2} />
                              </div>
                            );
                          })}
                          {onAddAtSlot && (() => {
                            const untrackedSessions = day.sessions.filter(s => (s.track_names || []).length === 0);
                            const { gaps } = computeGapSlots(untrackedSessions, layout, timezone, formatDateForInput);
                            return gaps.map((gap, gi) => (
                              <div
                                key={`gap-${gi}`}
                                className="absolute left-0 right-0 px-0.5 flex justify-center"
                                style={{ top: gap.top }}
                              >
                                <button
                                  type="button"
                                  onClick={() => onAddAtSlot({ startTime: gap.startTime, trackId: null })}
                                  className="w-full mx-1 py-1.5 border border-dashed border-slate-300 rounded-md flex items-center justify-center gap-1 text-slate-400 hover:text-slate-600 hover:border-slate-400 transition-colors"
                                  data-testid={`button-quick-add-untracked-${gi}`}
                                >
                                  <Plus className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ));
                          })()}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  day.sessions.map(session => (
                    <div key={session._localId} className="mb-2">
                      <AdminSessionCard session={session} timezone={timezone} colors={null} speakerMap={speakerMap} onEdit={onEdit} onDelete={onDelete} />
                    </div>
                  ))
                )}
            </div>}
          </div>
        );
      })}

      {sessionsWithoutTime.length > 0 && (
        <div data-testid="admin-schedule-unscheduled">
          <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
            <Clock className="w-4 h-4 text-warning" />
            Unscheduled Sessions
          </h3>
          <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
            {sessionsWithoutTime.map(session => (
              <AdminSessionCard key={session._localId} session={session} timezone={timezone} colors={null} speakerMap={speakerMap} onEdit={onEdit} onDelete={onDelete} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function generateId() {
  return `tmp-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
}

const createEmptyTicketClass = (isDefault = false, defaultVatRate = null) => ({
  _localId: generateId(),
  name: isDefault ? "Standard Ticket" : "",
  price: "",
  is_free: false,
  role_ids: [],
  member_group_ids: [],
  is_default: isDefault,
  visibility_mode: 'members_only',
  role_match_only: false,
  offer_type: "none",
  bogo_logic_type: "buy_x_get_y_free",
  bogo_buy_quantity: "",
  bogo_get_free_quantity: "",
  bulk_discount_threshold: "",
  bulk_discount_percentage: "",
  available_count: "",
  is_unlimited_tickets: true,
  vat_rate_key: defaultVatRate?.taxType || null,
  vat_rate_label: defaultVatRate?.name || null,
  vat_rate_percentage: defaultVatRate?.effectiveRate || null,
  is_group_ticket: false,
  group_size: "",
  group_cutoff_date: "",
  early_bird_enabled: false,
  early_bird_price: "",
  early_bird_deadline: "",
  all_tracks: true,
  linked_track_ids: [],
});

export default function CreateComplexEvent() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const { ticketTypeName: groupTicketTypeName, featureName: memberGroupFeatureName } = useMemberGroupSettings();
  const params = new URLSearchParams(location.search);
  const editId = params.get("id");
  const isEditMode = !!editId;
  const groupEventParam = params.get("group_event") === "1";
  const groupIdParam = params.get("group_id") || null;
  const fromParam = params.get("from") || null;

  const [activeSection, setActiveSection] = useState("details");
  const [saving, setSaving] = useState(false);
  const [clashDialog, setClashDialog] = useState({ open: false, clashes: [], redacted: false, clashCount: 0 });
  const [checkingClashes, setCheckingClashes] = useState(false);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [slugError, setSlugError] = useState(null);
  const [checkingSlug, setCheckingSlug] = useState(false);

  const [formData, setFormData] = useState({
    title: "",
    slug: "",
    description: "",
    summary: "",
    custom_duration_explainer: "",
    image_url: "",
    image_focal_point: null,
    start_date: "",
    end_date: "",
    location: "",
    status: "published",
    event_state: "active",
    is_featured: false,
    timezone: "Europe/London",
    available_seats: "",
    internal_reference: "",
    xero_account_code: "",
    event_type: [],
    registration_closes_at: "",
    cta_override_url: "",
    cta_override_mode: "card",
    program_tag: "",
    group_event_public: false,
  });

  const [tracks, setTracks] = useState([]);
  const [expandedTracks, setExpandedTracks] = useState({});
  const [sessions, setSessions] = useState([]);

  // Task #3285: speaker awards (vouchers/badges granted at event start)
  const [speakerAwards, setSpeakerAwards] = useState(configToFormState(null));
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  // task-692: change-zoom dialog for a saved session (attach/change/detach).
  const [sessionZoomDialog, setSessionZoomDialog] = useState({ open: false, mode: 'change', sessionId: null });
  const [editingSession, setEditingSession] = useState(null);
  const [sessionForm, setSessionForm] = useState({
    title: "",
    description: "",
    image_url: "",
    image_focal_point: null,
    use_event_image: true,
    speaker_ids: [],
    start_time: "",
    end_time: "",
    location: "",
    is_online: false,
    track_ids: [],
    zoom_type: "meeting",
    zoom_host_id: "",
    zoom_host_email: "",
    zoom_registration_required: false,
    zoom_link_mode: "auto_create",
    auto_create_zoom: true,
    link_existing_zoom_id: "",
    zoom_meeting_id: null,
    zoom_webinar_id: null,
    zoom_join_url: null,
  });
  const [sessionDuration, setSessionDuration] = useState("custom");
  const [sessionSpeakerModalOpen, setSessionSpeakerModalOpen] = useState(false);

  const [ticketClasses, setTicketClasses] = useState([]);
  const [expandedTickets, setExpandedTickets] = useState({});
  const [ticketsInitialized, setTicketsInitialized] = useState(false);

  const [unlimitedSeats, setUnlimitedSeats] = useState(true);
  const [showSeatCount, setShowSeatCount] = useState(true);
  const [showTicketAvailability, setShowTicketAvailability] = useState(false);
  const [qrOnConfirmation, setQrOnConfirmation] = useState(false);
  const [collectThirdPartyConsent, setCollectThirdPartyConsent] = useState(false);

  const { data: roles = [], isLoading: loadingRoles } = useQuery({
    queryKey: ['/api/entities/Role'],
    queryFn: () => base44.entities.Role.list({ sort: { name: 'asc' } })
  });

  const { data: memberGroups = [], isLoading: loadingMemberGroups } = useQuery({
    queryKey: ['/api/entities/MemberGroup'],
    queryFn: () => base44.entities.MemberGroup.list({ filter: { is_active: true }, sort: { name: 'asc' } })
  });

  const { data: systemSettings = [] } = useQuery({
    queryKey: ['/api/entities/SystemSettings'],
    queryFn: () => base44.entities.SystemSettings.list()
  });

  const { data: speakers = [] } = useQuery({
    queryKey: ['/api/entities/Speaker'],
    queryFn: () => base44.entities.Speaker.list({ filter: { is_active: true }, sort: { full_name: 'asc' } })
  });

  const { data: zoomUsers = [], isLoading: loadingZoomUsers } = useQuery({
    queryKey: ['/api/zoom/users'],
    queryFn: async () => {
      const resp = await fetch('/api/zoom/users', { credentials: 'include' });
      if (!resp.ok) return [];
      return resp.json();
    },
    staleTime: 60000
  });

  const { eventTypes } = useEventTypes();

  const { data: resourceCategories = [] } = useQuery({
    queryKey: ['/api/entities/ResourceCategory'],
    queryFn: () => base44.entities.ResourceCategory.list('display_order')
  });

  const globalShowSeats = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'show_event_seats');
    return !setting || setting.setting_value !== 'false';
  }, [systemSettings]);

  // Whether dietary/allergy/accessibility collection is enabled tenant-wide (defaults to true)
  const collectAttendeeOptionsEnabled = useMemo(
    () => isAttendeeOptionsCollectionEnabled(systemSettings),
    [systemSettings]
  );

  const eventCategories = useMemo(() => {
    return resourceCategories
      .filter(cat =>
        cat.is_active &&
        Array.isArray(cat.applies_to_content_types) &&
        cat.applies_to_content_types.includes('Events') &&
        Array.isArray(cat.subcategories) &&
        cat.subcategories.length > 0
      )
      .map(cat => ({
        id: cat.id,
        name: cat.name,
        subcategories: cat.subcategories || []
      }));
  }, [resourceCategories]);

  const [selectedFilterTags, setSelectedFilterTags] = useState([]);
  const [filterTagsInitialized, setFilterTagsInitialized] = useState(false);
  const [selectedSponsors, setSelectedSponsors] = useState([]);
  const [sponsorDetails, setSponsorDetails] = useState({});
  const [sponsorsExpanded, setSponsorsExpanded] = useState(false);
  const [seoTitle, setSeoTitle] = useState("");
  const [attachedDocuments, setAttachedDocuments] = useState([]);
  const [documentsSectionTitle, setDocumentsSectionTitle] = useState("");
  const [dietaryOptions, setDietaryOptions] = useState([]);
  const [allergyOptions, setAllergyOptions] = useState([]);
  const [accessibilityOptions, setAccessibilityOptions] = useState([]);
  const [seoDescription, setSeoDescription] = useState("");
  const [ogImageUrl, setOgImageUrl] = useState("");
  const [isProgramEvent, setIsProgramEvent] = useState(false);
  const [isDirtyState, setIsDirtyState] = useState(false);
  const baselineSnapshotRef = useRef(null);
  const pendingBaselineResetRef = useRef(false);
  const [sponsorsInitialized, setSponsorsInitialized] = useState(false);

  const [eventEmails, setEventEmails] = useState([]);
  const [isSavingEmails, setIsSavingEmails] = useState(false);
  const [isRequeueingEmails, setIsRequeueingEmails] = useState(false);
  const [emailSaveErrors, setEmailSaveErrors] = useState({}); // Per-email inline save errors keyed by email.id

  const { data: programs = [], isLoading: loadingPrograms } = useQuery({
    queryKey: ['/api/entities/Program'],
    queryFn: () => base44.entities.Program.list({ sort: { name: 'asc' } })
  });

  const summaryMaxLength = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'event_summary_max_length');
    return setting ? parseInt(setting.setting_value) || 150 : 150;
  }, [systemSettings]);

  // Whether an internal reference is required to save an event (defaults to false)
  const requireInternalReference = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'require_internal_reference');
    return setting ? setting.setting_value === 'true' : false;
  }, [systemSettings]);

  const handleTimingChange = (newTiming) => {
    setFormData(prev => ({
      ...prev,
      status: newTiming,
      ...(newTiming === 'tbc' ? { start_date: '', end_date: '', registration_closes_at: '' } : {})
    }));
  };

  const speakerModuleName = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'speaker_module_name');
    if (setting?.setting_value) {
      try {
        const names = JSON.parse(setting.setting_value);
        return { singular: names.singular || "Speaker", plural: names.plural || "Speakers" };
      } catch {
        return { singular: setting.setting_value, plural: setting.setting_value + "s" };
      }
    }
    return { singular: "Speaker", plural: "Speakers" };
  }, [systemSettings]);

  const defaultVatRate = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'event_default_vat_rate');
    if (setting?.setting_value) {
      try { return JSON.parse(setting.setting_value); } catch { return null; }
    }
    return null;
  }, [systemSettings]);

  const availableVatRates = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'xero_vat_rates');
    if (setting?.setting_value) {
      try {
        const parsed = JSON.parse(setting.setting_value);
        return parsed.rates || [];
      } catch { return []; }
    }
    return [];
  }, [systemSettings]);

  const { data: existingEvent, isLoading: loadingEvent } = useQuery({
    queryKey: ["/api/entities/ComplexEvent", editId],
    queryFn: () => base44.entities.ComplexEvent.get(editId),
    enabled: isEditMode,
  });

  // Task #1519: Group-Admin limited mode for the complex event editor.
  const { data: authMe } = useQuery({
    queryKey: ['authMe'],
    queryFn: async () => {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      if (!r.ok) return null;
      return r.json();
    },
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });
  const isTenantAdmin = authMe?.isAdmin === true;
  const lockedGroupId = groupIdParam || existingEvent?.member_group_id || null;
  // Any complex event that belongs to a member group is edited in the reduced/
  // gated group-event UI — including for tenant admins — so the client never
  // offers options the server rejects for group events.
  const isGroupLimited = groupEventParam || !!existingEvent?.member_group_id;
  const lockedGroupName = useMemo(
    () => memberGroups.find((g) => g.id === lockedGroupId)?.name || null,
    [memberGroups, lockedGroupId]
  );

  const { data: existingTracks = [], isLoading: loadingTracks } = useQuery({
    queryKey: ["/api/entities/ComplexEventTrack", editId],
    queryFn: () =>
      base44.entities.ComplexEventTrack.list({
        filter: { complex_event_id: editId },
        sort: { display_order: "asc" },
      }),
    enabled: isEditMode,
  });

  const { data: existingSessions = [], isLoading: loadingSessions } = useQuery({
    queryKey: ["/api/complex-event-sessions", editId],
    queryFn: async () => {
      const resp = await fetch(`/api/complex-event-sessions?event_id=${editId}`, { credentials: 'include' });
      if (!resp.ok) return [];
      return resp.json();
    },
    enabled: isEditMode,
  });

  const { data: existingTicketClasses = [], isLoading: loadingTicketClasses } = useQuery({
    queryKey: ["/api/entities/ComplexEventTicketClass", editId],
    queryFn: () =>
      base44.entities.ComplexEventTicketClass.list({
        filter: { complex_event_id: editId },
        sort: { display_order: "asc" },
      }),
    enabled: isEditMode,
  });

  const { data: fetchedEventEmails = [], isLoading: loadingEmails } = useQuery({
    queryKey: ['event-emails', editId],
    queryFn: async () => {
      const response = await fetch(`/api/event-emails/${editId}`, {
        credentials: 'include'
      });
      if (!response.ok) {
        if (response.status === 404) return [];
        throw new Error('Failed to fetch event emails');
      }
      return response.json();
    },
    enabled: isEditMode && !!editId
  });

  const { data: emailTemplates = [] } = useQuery({
    queryKey: ['/api/entities/EmailTemplate', 'events'],
    queryFn: async () => {
      const allTemplates = await base44.entities.EmailTemplate.list();
      return allTemplates.filter(t => t.category === 'events' && t.is_active);
    }
  });

  useEffect(() => {
    if (fetchedEventEmails.length > 0 && eventEmails.length === 0) {
      setEventEmails(fetchedEventEmails);
    }
  }, [fetchedEventEmails]);

  // Email configuration helpers now live in the shared
  // EventEmailSettingsEditor component (Task #3263).
  const addEventEmail = (emailType = 'reminder') => {
    setEventEmails([...eventEmails, createEmptyEmail(emailType)]);
  };

  // Clear any prior save error for an email row once the admin edits it.
  const handleEmailRowEdited = (emailId) => {
    setEmailSaveErrors(prev => {
      if (!prev[emailId]) return prev;
      const { [emailId]: _removed, ...rest } = prev;
      return rest;
    });
  };

  const requeueReminders = async () => {
    if (!editId) return;
    setIsRequeueingEmails(true);
    try {
      const response = await fetch(`/api/event-emails/${editId}/reschedule`, {
        method: 'POST',
        credentials: 'include',
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result?.error || 'Failed to re-queue reminders');
      }
      if (result.schedulingFailures?.length || result.error) {
        toast.error(formatSchedulingFailures(result));
      } else if ((result.requeued || 0) === 0 && result.skipped?.length > 0) {
        toast.error(`No reminders queued — ${formatSkippedSummary(result.skipped)}`);
      } else {
        const skippedSuffix = result.skipped?.length
          ? ` (${formatSkippedSummary(result.skipped)})`
          : '';
        toast.success(`Queued ${result.requeued} reminder(s) for ${result.bookingsScheduled} booking(s)${skippedSuffix}`);
      }
      queryClient.invalidateQueries({ queryKey: ['event-emails', editId] });
    } catch (err) {
      console.error('Re-queue reminders error:', err);
      toast.error(err.message || 'Failed to re-queue reminders');
    } finally {
      setIsRequeueingEmails(false);
    }
  };

  const saveEventEmails = async () => {
    const invalidCc = findInvalidCcAddresses(eventEmails);
    if (invalidCc.length > 0) {
      toast.error(`Invalid CC email address: ${invalidCc.join(', ')}`);
      return;
    }
    setEmailSaveErrors({});
    setIsSavingEmails(true);
    const requestEmails = eventEmails;
    try {
      const { response, result } = await putEventEmails(editId, requestEmails, true);

      if (response.ok) {
        const savedFromOk = Array.isArray(result)
          ? result
          : (Array.isArray(result?.savedEmails) ? result.savedEmails : []);
        if (savedFromOk.length > 0) {
          setEventEmails(savedFromOk);
        } else if (savedFromOk.length === 0 && requestEmails.length > 0) {
          throw new Error('Server returned empty response — emails may not have been saved');
        }
        queryClient.invalidateQueries({ queryKey: ['event-emails', editId] });
        const scheduling = !Array.isArray(result) ? result : null;
        const failures = scheduling?.schedulingFailures || [];
        const skipped = scheduling?.skipped || [];
        const schedulerError = scheduling?.schedulerError || scheduling?.error;
        if (failures.length > 0 || schedulerError) {
          toast.error(`Saved, but ${formatSchedulingFailures({ schedulingFailures: failures, error: schedulerError })}`);
        } else if (skipped.length > 0) {
          toast.success(`Email configurations saved (${formatSkippedSummary(skipped)})`);
        } else {
          toast.success('Email configurations saved');
        }
        return;
      }

      // Failure path. The API returns { error, details: [{email_type, error, request_index}], savedEmails }
      // when one or more rows fail to insert/update. Each `details` entry includes the
      // `request_index` (position in the PUT body) so we can map errors back to rows
      // deterministically — even when multiple rows share the same `email_type`.
      const details = Array.isArray(result?.details) ? result.details : [];
      const savedEmails = Array.isArray(result?.savedEmails) ? result.savedEmails : [];

      if (details.length > 0) {
        const { errMap, failedIndexes } = mapEmailSaveFailureDetails(details, requestEmails);
        setEmailSaveErrors(errMap);

        // Merge any successfully-saved rows back in. The API loop processes emails in
        // request order and pushes successes to `savedEmails` in that same order, so
        // walking the non-failed request rows lines up exactly with `savedEmails`.
        if (savedEmails.length > 0 && failedIndexes.size > 0) {
          let savedCursor = 0;
          setEventEmails(prev => prev.map((e, i) => {
            if (failedIndexes.has(i)) return e;
            const saved = savedEmails[savedCursor++];
            return saved ? { ...saved } : e;
          }));
        }

        const total = requestEmails.length;
        const failed = details.length;
        toast.error(
          `${failed} of ${total} email${total === 1 ? '' : 's'} failed to save — see details below`
        );
      } else {
        toast.error(result?.error || 'Failed to save email configurations');
      }
    } catch (error) {
      console.error('Error saving emails:', error);
      toast.error(error.message || 'Failed to save email configurations');
    } finally {
      setIsSavingEmails(false);
    }
  };

  const buildSnapshot = useCallback(() => {
    return JSON.stringify({ formData, tracks, sessions, ticketClasses, selectedSponsors, sponsorDetails, seoTitle, seoDescription, ogImageUrl, selectedFilterTags, unlimitedSeats, showSeatCount, showTicketAvailability, qrOnConfirmation, collectThirdPartyConsent, isProgramEvent });
  }, [formData, tracks, sessions, ticketClasses, selectedSponsors, sponsorDetails, seoTitle, seoDescription, ogImageUrl, selectedFilterTags, unlimitedSeats, showSeatCount, showTicketAvailability, qrOnConfirmation, collectThirdPartyConsent, isProgramEvent]);

  const isDirty = !isEditMode || isDirtyState;

  useEffect(() => {
    if (isEditMode && existingTicketClasses.length > 0 && !ticketsInitialized) {
      const loaded = existingTicketClasses.map(tc => ({
        _localId: tc.id,
        _dbId: tc.id,
        name: tc.name || "",
        price: tc.price != null ? String(Number(tc.price)) : "",
        is_free: tc.is_free || false,
        role_ids: tc.role_ids || [],
        member_group_ids: Array.isArray(tc.member_group_ids) ? tc.member_group_ids : [],
        is_default: false,
        visibility_mode: tc.visibility_mode || 'members_only',
        role_match_only: tc.role_match_only || false,
        offer_type: tc.offer_type || "none",
        bogo_logic_type: tc.bogo_logic_type || "buy_x_get_y_free",
        bogo_buy_quantity: tc.bogo_buy_quantity != null ? String(tc.bogo_buy_quantity) : "",
        bogo_get_free_quantity: tc.bogo_get_free_quantity != null ? String(tc.bogo_get_free_quantity) : "",
        bulk_discount_threshold: tc.bulk_discount_threshold != null ? String(tc.bulk_discount_threshold) : "",
        bulk_discount_percentage: tc.bulk_discount_percentage != null ? String(tc.bulk_discount_percentage) : "",
        available_count: tc.available_count != null ? String(tc.available_count) : "",
        is_unlimited_tickets: tc.is_unlimited_tickets !== false,
        vat_rate_key: tc.vat_rate_key || null,
        vat_rate_label: tc.vat_rate_label || null,
        vat_rate_percentage: tc.vat_rate_percentage || null,
        is_group_ticket: tc.is_group_ticket || false,
        group_size: tc.group_size != null ? String(tc.group_size) : "",
        group_cutoff_date: tc.group_cutoff_date || "",
        early_bird_enabled: tc.early_bird_enabled || false,
        early_bird_price: tc.early_bird_price != null ? String(Number(tc.early_bird_price)) : "",
        early_bird_deadline: tc.early_bird_deadline ? tc.early_bird_deadline.slice(0, 16) : "",
        all_tracks: tc.all_tracks !== false,
        linked_track_ids: tc.linked_track_ids || [],
      }));
      setTicketClasses(loaded);
      setTicketsInitialized(true);
      if (loaded.length > 0) {
        setExpandedTickets({ [loaded[0]._localId]: true });
      }
    }
  }, [existingTicketClasses, isEditMode, ticketsInitialized]);

  useEffect(() => {
    if (existingEvent && isEditMode) {
      let loadedStatus = existingEvent.status || "published";
      let loadedEventState = existingEvent.event_state || "active";
      if (loadedStatus === 'draft') {
        loadedStatus = 'published';
        loadedEventState = 'draft';
      } else if (loadedStatus === 'closed') {
        loadedStatus = 'published';
        loadedEventState = 'closed';
      }
      // Task #3285: load speaker award config
      setSpeakerAwards(configToFormState(existingEvent.speaker_award_config));

      setFormData({
        title: existingEvent.title || "",
        slug: existingEvent.slug || "",
        description: existingEvent.description || "",
        summary: existingEvent.summary || "",
        custom_duration_explainer: existingEvent.custom_duration_explainer || "",
        image_url: existingEvent.image_url || "",
        image_focal_point: existingEvent.image_focal_point || null,
        start_date: existingEvent.start_date
          ? (toDateTz(existingEvent.start_date, existingEvent.timezone || DEFAULT_TIMEZONE)?.toISOString() || "")
          : "",
        end_date: existingEvent.end_date
          ? (toDateTz(existingEvent.end_date, existingEvent.timezone || DEFAULT_TIMEZONE)?.toISOString() || "")
          : "",
        location: existingEvent.location || "",
        status: loadedStatus,
        event_state: loadedEventState,
        is_featured: existingEvent.is_featured === true,
        timezone: existingEvent.timezone || "Europe/London",
        available_seats: existingEvent.available_seats != null ? String(existingEvent.available_seats) : "",
        internal_reference: existingEvent.internal_reference || "",
        xero_account_code: existingEvent.xero_account_code || "",
        event_type: parseEventTypes(existingEvent.event_type),
        registration_closes_at: existingEvent.registration_closes_at
          ? (toDateTz(existingEvent.registration_closes_at, existingEvent.timezone || DEFAULT_TIMEZONE)?.toISOString() || "")
          : "",
        program_tag: existingEvent.program_tag || "",
        cta_override_url: existingEvent.cta_override_url || "",
        cta_override_mode: existingEvent.cta_override_mode || "card",
        group_event_public: existingEvent.group_event_public === true,
      });
      setSlugManuallyEdited(true);
      setSeoTitle(existingEvent.seo_title || "");
      setSeoDescription(existingEvent.seo_description || "");
      setOgImageUrl(existingEvent.og_image_url || "");
      setAttachedDocuments(Array.isArray(existingEvent.attached_documents) ? existingEvent.attached_documents : []);
      setDocumentsSectionTitle(existingEvent.documents_section_title || "");
      setDietaryOptions(Array.isArray(existingEvent.dietary_options) ? existingEvent.dietary_options : []);
      setAllergyOptions(Array.isArray(existingEvent.allergy_options) ? existingEvent.allergy_options : []);
      setAccessibilityOptions(Array.isArray(existingEvent.accessibility_options) ? existingEvent.accessibility_options : []);
      if (existingEvent.program_tag) {
        setIsProgramEvent(true);
      }

      if (existingEvent.is_unlimited_registration === true) {
        setUnlimitedSeats(true);
      } else if (existingEvent.is_unlimited_registration === false) {
        setUnlimitedSeats(false);
      } else {
        setUnlimitedSeats(existingEvent.available_seats === null);
      }
      setShowSeatCount(existingEvent.show_seat_count !== false);
      setShowTicketAvailability(existingEvent.show_ticket_availability === true);
      setQrOnConfirmation(existingEvent.qr_on_confirmation !== false);
      setCollectThirdPartyConsent(existingEvent.pricing_config?.collectThirdPartyConsent === true);

      base44.entities.EventSponsorAssignment.list({ filter: { event_id: existingEvent.id, event_type: 'complex' } })
        .then(assignments => {
          setSelectedSponsors(assignments.map(a => a.sponsor_id).filter(Boolean));
          const details = {};
          assignments.forEach(a => { if (a.sponsor_id && a.sponsorship_detail) details[a.sponsor_id] = a.sponsorship_detail; });
          setSponsorDetails(details);
          setSponsorsInitialized(true);
        })
        .catch(e => { console.error('Failed to load sponsor assignments:', e); setSelectedSponsors([]); setSponsorDetails({}); setSponsorsInitialized(true); });
    }
  }, [existingEvent, isEditMode]);

  useEffect(() => {
    if (isEditMode && existingEvent && eventCategories.length > 0 && !filterTagsInitialized) {
      if (existingEvent.filter_tags && existingEvent.filter_tags.length > 0) {
        const normalizedTags = normalizeFilterTags(existingEvent.filter_tags, eventCategories);
        setSelectedFilterTags(normalizedTags);
      }
      setFilterTagsInitialized(true);
    }
  }, [existingEvent, eventCategories, isEditMode, filterTagsInitialized]);

  useEffect(() => {
    if (isEditMode && existingTracks.length > 0) {
      const loadedTracks = existingTracks.map((t) => ({
        ...t,
        _localId: t.id,
      }));
      setTracks(loadedTracks);
      const expanded = {};
      loadedTracks.forEach((t) => { expanded[t._localId] = true; });
      setExpandedTracks(expanded);
    }
  }, [existingTracks, isEditMode]);

  useEffect(() => {
    if (isEditMode && existingSessions.length > 0) {
      const loadedSessions = existingSessions.map((s) => ({
        ...s,
        _localId: s.id,
        speaker_ids: s.speaker_ids || [],
        speaker_names: s.speaker_names || [],
        track_ids: s.track_ids || [],
        image_focal_point: s.image_focal_point || null,
        use_event_image: s.use_event_image !== undefined ? s.use_event_image : !s.image_url,
        zoom_type: s.zoom_type || 'meeting',
        zoom_host_id: s.zoom_host_id || '',
        zoom_host_email: s.zoom_host_email || '',
        zoom_registration_required: s.zoom_registration_required || false,
        zoom_link_mode: s.zoom_link_mode || 'auto_create',
        auto_create_zoom: s.auto_create_zoom !== undefined ? s.auto_create_zoom : true,
        link_existing_zoom_id: s.zoom_meeting_id || s.zoom_webinar_id || '',
      }));
      setSessions(loadedSessions);
    }
  }, [existingSessions, isEditMode]);

  const allEditDataReady = isEditMode && !!existingEvent
    && !loadingTracks && !loadingSessions && !loadingTicketClasses
    && (ticketsInitialized || existingTicketClasses.length === 0)
    && sponsorsInitialized
    && (filterTagsInitialized || eventCategories.length === 0);

  useEffect(() => {
    if (!isEditMode || !allEditDataReady) return;
    if (!baselineSnapshotRef.current || pendingBaselineResetRef.current) {
      baselineSnapshotRef.current = buildSnapshot();
      pendingBaselineResetRef.current = false;
      setIsDirtyState(false);
    }
  }, [isEditMode, allEditDataReady, buildSnapshot]);

  useEffect(() => {
    if (!isEditMode || !baselineSnapshotRef.current) return;
    const current = buildSnapshot();
    setIsDirtyState(current !== baselineSnapshotRef.current);
  }, [isEditMode, buildSnapshot]);

  useEffect(() => {
    if (formData.title && !slugManuallyEdited) {
      const generated = formData.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      setFormData((prev) => ({ ...prev, slug: generated }));
    }
  }, [formData.title, slugManuallyEdited]);

  useEffect(() => {
    if (!formData.slug) {
      setSlugError(null);
      return;
    }
    const checkSlugUniqueness = async () => {
      setCheckingSlug(true);
      try {
        const allEvents = await base44.entities.ComplexEvent.list();
        const duplicate = allEvents.find(
          (e) => e.slug === formData.slug && (!isEditMode || e.id !== editId)
        );
        if (duplicate) {
          setSlugError("This URL slug is already in use. Please choose a different one.");
        } else {
          setSlugError(null);
        }
      } catch (error) {
        console.error("Error checking slug uniqueness:", error);
      } finally {
        setCheckingSlug(false);
      }
    };
    const timer = setTimeout(checkSlugUniqueness, 500);
    return () => clearTimeout(timer);
  }, [formData.slug, editId, isEditMode]);

  useEffect(() => {
    if (formData.status === 'tbc') return;
    const tz = formData.timezone || DEFAULT_TIMEZONE;
    const allTimes = sessions
      .filter(s => s.start_time || s.end_time)
      .flatMap(s => {
        const times = [];
        if (s.start_time) times.push(toDateTz(s.start_time, tz));
        if (s.end_time) times.push(toDateTz(s.end_time, tz));
        return times;
      })
      .filter(d => d && !isNaN(d.getTime()));

    if (allTimes.length === 0) return;

    const earliest = new Date(Math.min(...allTimes.map(d => d.getTime())));
    const latest = new Date(Math.max(...allTimes.map(d => d.getTime())));

    setFormData(prev => ({
      ...prev,
      start_date: earliest.toISOString(),
      end_date: latest.toISOString(),
    }));
  }, [sessions, formData.status, formData.timezone]);

  const updateField = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const addTrack = () => {
    const colourIdx = tracks.length % TRACK_COLOURS.length;
    const newTrack = {
      _localId: generateId(),
      name: "",
      description: "",
      colour: TRACK_COLOURS[colourIdx],
      display_order: tracks.length,
    };
    setTracks((prev) => [...prev, newTrack]);
    setExpandedTracks((prev) => ({ ...prev, [newTrack._localId]: true }));
  };

  const updateTrack = (localId, field, value) => {
    setTracks((prev) =>
      prev.map((t) => (t._localId === localId ? { ...t, [field]: value } : t))
    );
  };

  const removeTrack = (localId) => {
    const track = tracks.find(t => t._localId === localId);
    const trackRef = track?.id || localId;
    setTracks((prev) => prev.filter((t) => t._localId !== localId));
    setTicketClasses((prev) => prev.map(t => ({
      ...t,
      linked_track_ids: (t.linked_track_ids || []).filter(id => id !== trackRef),
    })));
    setSessions((prev) => prev.map(s => ({
      ...s,
      track_ids: (s.track_ids || []).filter(id => id !== trackRef),
    })));
  };

  const moveTrack = (localId, direction) => {
    setTracks((prev) => {
      const idx = prev.findIndex((t) => t._localId === localId);
      if ((direction === -1 && idx === 0) || (direction === 1 && idx === prev.length - 1)) return prev;
      const next = [...prev];
      [next[idx], next[idx + direction]] = [next[idx + direction], next[idx]];
      return next.map((t, i) => ({ ...t, display_order: i }));
    });
  };

  const DURATION_OPTIONS = useMemo(() => {
    const options = [];
    for (let mins = 15; mins <= 240; mins += 15) {
      const hrs = Math.floor(mins / 60);
      const remainMins = mins % 60;
      let label;
      if (hrs === 0) {
        label = `${mins} min`;
      } else if (remainMins === 0) {
        label = `${hrs} hr${hrs > 1 ? 's' : ''}`;
      } else {
        label = `${hrs} hr ${remainMins} min`;
      }
      options.push({ value: String(mins), label });
    }
    options.push({ value: "custom", label: "Custom end time" });
    return options;
  }, []);

  const detectDurationFromTimes = (startTime, endTime) => {
    if (!startTime || !endTime) return "custom";
    const startMs = new Date(startTime).getTime();
    const endMs = new Date(endTime).getTime();
    const diffMins = Math.round((endMs - startMs) / 60000);
    if (diffMins >= 15 && diffMins <= 240 && diffMins % 15 === 0) {
      return String(diffMins);
    }
    return "custom";
  };

  const toLocalDatetimeStr = (isoStr) => {
    if (!isoStr) return "";
    if (typeof isoStr !== 'string') {
      try {
        const tz = formData.timezone || DEFAULT_TIMEZONE;
        return formatInTimeZone(isoStr, tz, "yyyy-MM-dd'T'HH:mm");
      } catch {
        return "";
      }
    }
    const hasOffset = /[+-]\d{2}(:\d{2})?$/.test(isoStr) || isoStr.endsWith("Z");
    if (!hasOffset) {
      return isoStr.slice(0, 16);
    }
    try {
      const tz = formData.timezone || DEFAULT_TIMEZONE;
      return formatInTimeZone(parseISO(isoStr), tz, "yyyy-MM-dd'T'HH:mm");
    } catch {
      return isoStr.slice(0, 16);
    }
  };

  const computeEndTimeFromDuration = (startTime, durationMins) => {
    if (!startTime || !durationMins || durationMins === "custom") return "";
    const tz = formData.timezone || DEFAULT_TIMEZONE;
    const startUtc = fromZonedTime(startTime, tz);
    const startMs = startUtc.getTime();
    if (isNaN(startMs)) return "";
    const endMs = startMs + parseInt(durationMins) * 60000;
    const endDate = new Date(endMs);
    try {
      return formatInTimeZone(endDate, tz, "yyyy-MM-dd'T'HH:mm");
    } catch {
      const pad = (n) => String(n).padStart(2, '0');
      return `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}T${pad(endDate.getHours())}:${pad(endDate.getMinutes())}`;
    }
  };

  const openSessionDialog = (session = null, prefill = null) => {
    setSessionDialogOpen(true);
    if (session) {
      setEditingSession(session._localId);
      setSessionForm({
        title: session.title || "",
        description: session.description || "",
        image_url: session.image_url || "",
        image_focal_point: session.image_focal_point || null,
        use_event_image: session.use_event_image !== undefined ? session.use_event_image : !session.image_url,
        speaker_ids: session.speaker_ids || [],
        start_time: toLocalDatetimeStr(session.start_time),
        end_time: toLocalDatetimeStr(session.end_time),
        location: session.location || "",
        is_online: session.is_online || false,
        track_ids: session.track_ids || [],
        zoom_type: session.zoom_type || "meeting",
        zoom_host_id: session.zoom_host_id || "",
        zoom_host_email: session.zoom_host_email || "",
        zoom_registration_required: session.zoom_registration_required || false,
        zoom_link_mode: session.zoom_link_mode || "auto_create",
        auto_create_zoom: session.auto_create_zoom !== undefined ? session.auto_create_zoom : true,
        link_existing_zoom_id: session.link_existing_zoom_id || "",
        zoom_meeting_id: session.zoom_meeting_id || null,
        zoom_webinar_id: session.zoom_webinar_id || null,
        zoom_join_url: session.zoom_join_url || null,
      });
      setSessionDuration(detectDurationFromTimes(
        toLocalDatetimeStr(session.start_time),
        toLocalDatetimeStr(session.end_time)
      ));
    } else {
      setEditingSession(null);
      const prefillStartTime = prefill?.start_time || "";
      const prefillTrackIds = prefill?.track_ids || [];
      setSessionForm({
        title: "",
        description: "",
        image_url: "",
        image_focal_point: null,
        use_event_image: true,
        speaker_ids: [],
        start_time: prefillStartTime,
        end_time: "",
        location: "",
        is_online: false,
        track_ids: prefillTrackIds,
        zoom_type: "meeting",
        zoom_host_id: "",
        zoom_host_email: "",
        zoom_registration_required: false,
        zoom_link_mode: "auto_create",
        auto_create_zoom: true,
        link_existing_zoom_id: "",
        zoom_meeting_id: null,
        zoom_webinar_id: null,
        zoom_join_url: null,
      });
      setSessionDuration("custom");
    }
  };

  const closeSessionDialog = () => {
    setSessionDialogOpen(false);
    setEditingSession(null);
  };

  const checkSessionOverlaps = (sessionData, currentLocalId) => {
    if (!sessionData.start_time || !sessionData.end_time || !(sessionData.track_ids || []).length) return [];
    const tz = formData.timezone || DEFAULT_TIMEZONE;
    const newStartDate = toDateTz(sessionData.start_time, tz);
    const newEndDate = toDateTz(sessionData.end_time, tz);
    const newStart = newStartDate ? newStartDate.getTime() : NaN;
    const newEnd = newEndDate ? newEndDate.getTime() : NaN;
    if (isNaN(newStart) || isNaN(newEnd) || newEnd <= newStart) return [];

    const overlaps = [];
    for (const s of sessions) {
      if (s._localId === currentLocalId) continue;
      if (!s.start_time || !s.end_time) continue;
      const sStartDate = toDateTz(s.start_time, tz);
      const sEndDate = toDateTz(s.end_time, tz);
      const sStart = sStartDate ? sStartDate.getTime() : NaN;
      const sEnd = sEndDate ? sEndDate.getTime() : NaN;
      if (isNaN(sStart) || isNaN(sEnd)) continue;
      const sharedTracks = (sessionData.track_ids || []).filter(tid => (s.track_ids || []).includes(tid));
      if (sharedTracks.length > 0 && newStart < sEnd && newEnd > sStart) {
        const trackLabels = sharedTracks.map(tid => {
          const t = tracks.find(tr => (tr.id || tr._localId) === tid);
          return t?.name || 'Unknown';
        });
        overlaps.push({ session: s.title, tracks: trackLabels });
      }
    }
    return overlaps;
  };

  const liveSessionClashes = useMemo(() => {
    return checkSessionOverlaps(sessionForm, editingSession);
  }, [sessionForm.start_time, sessionForm.end_time, sessionForm.track_ids, sessions, tracks, editingSession, formData.timezone]);

  const saveSession = () => {
    if (!sessionForm.title.trim()) {
      toast.error("Session title is required");
      return;
    }

    const overlaps = checkSessionOverlaps(sessionForm, editingSession);
    if (overlaps.length > 0) {
      const msgs = overlaps.map(o => `"${o.session}" on track(s): ${o.tracks.join(', ')}`);
      toast.warning(`Time overlap detected with: ${msgs.join('; ')}. Session saved, but please review.`);
    }

    if (editingSession) {
      setSessions((prev) =>
        prev.map((s) =>
          s._localId === editingSession ? { ...s, ...sessionForm } : s
        )
      );
    } else {
      setSessions((prev) => [
        ...prev,
        { ...sessionForm, _localId: generateId(), display_order: prev.length },
      ]);
    }
    closeSessionDialog();
  };

  const removeSession = (sessionLocalId) => {
    setSessions((prev) => prev.filter((s) => s._localId !== sessionLocalId));
  };

  const moveSession = (sessionLocalId, direction) => {
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s._localId === sessionLocalId);
      if ((direction === -1 && idx === 0) || (direction === 1 && idx === prev.length - 1))
        return prev;
      const next = [...prev];
      [next[idx], next[idx + direction]] = [next[idx + direction], next[idx]];
      return next.map((s, i) => ({ ...s, display_order: i }));
    });
  };

  const toggleTrackForSession = (trackRef) => {
    setSessionForm((prev) => {
      const current = prev.track_ids || [];
      const updated = current.includes(trackRef)
        ? current.filter(id => id !== trackRef)
        : [...current, trackRef];
      return { ...prev, track_ids: updated };
    });
  };

  const selectedSessionSpeakers = useMemo(() => {
    return speakers.filter(s => (sessionForm.speaker_ids || []).includes(s.id));
  }, [speakers, sessionForm.speaker_ids]);

  const addTicketClass = () => {
    const newTicket = createEmptyTicketClass(ticketClasses.length === 0, defaultVatRate);
    if (isGroupLimited) {
      newTicket.is_free = true;
      newTicket.price = '0';
      newTicket.early_bird_enabled = false;
      newTicket.is_group_ticket = false;
      newTicket.offer_type = 'none';
      if (newTicket.is_default && groupTicketTypeName) {
        newTicket.name = groupTicketTypeName;
      }
    }
    setTicketClasses(prev => [...prev, newTicket]);
    setExpandedTickets(prev => ({ ...prev, [newTicket._localId]: true }));
  };

  const removeTicketClass = (localId) => {
    setTicketClasses(prev => prev.filter(t => t._localId !== localId));
  };

  const updateTicketClass = (localId, field, value) => {
    setTicketClasses(prev => prev.map(t =>
      t._localId === localId ? { ...t, [field]: value } : t
    ));
  };

  const setTicketFree = (localId, isFree) => {
    setTicketClasses(prev => prev.map(t =>
      t._localId === localId ? {
        ...t,
        is_free: isFree,
        price: isFree ? '0' : t.price,
        ...(isFree ? { early_bird_enabled: false, early_bird_price: '', early_bird_deadline: '' } : {})
      } : t
    ));
  };

  const toggleRoleForTicket = (localId, roleId) => {
    setTicketClasses(prev => prev.map(t => {
      if (t._localId !== localId) return t;
      const currentRoles = t.role_ids || [];
      const newRoles = currentRoles.includes(roleId)
        ? currentRoles.filter(id => id !== roleId)
        : [...currentRoles, roleId];
      return { ...t, role_ids: newRoles };
    }));
  };

  const toggleMemberGroupForTicket = (localId, groupId) => {
    setTicketClasses(prev => prev.map(t => {
      if (t._localId !== localId) return t;
      const currentGroups = t.member_group_ids || [];
      const newGroups = currentGroups.includes(groupId)
        ? currentGroups.filter(id => id !== groupId)
        : [...currentGroups, groupId];
      return { ...t, member_group_ids: newGroups };
    }));
  };

  const toggleExpandTicket = (localId) => {
    setExpandedTickets(prev => ({ ...prev, [localId]: !prev[localId] }));
  };

  const getRoleNames = (roleIds) => {
    if (!roleIds || roleIds.length === 0) return "All Roles";
    return roleIds.map(id => roles.find(r => r.id === id)?.name || 'Unknown').join(', ');
  };

  const moveTicketClass = (localId, direction) => {
    setTicketClasses(prev => {
      const idx = prev.findIndex(t => t._localId === localId);
      if (idx < 0) return prev;
      const newIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const arr = [...prev];
      [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
      return arr;
    });
  };

  const toggleTrackForTicket = (localId, trackId) => {
    setTicketClasses(prev => prev.map(t => {
      if (t._localId !== localId) return t;
      const current = t.linked_track_ids || [];
      const updated = current.includes(trackId)
        ? current.filter(id => id !== trackId)
        : [...current, trackId];
      return { ...t, linked_track_ids: updated };
    }));
  };

  const handleSave = async (skipClashCheck = false) => {
    if (!formData.title.trim()) {
      toast.error("Event title is required");
      return;
    }
    if (!formData.slug.trim()) {
      toast.error("Event slug is required");
      return;
    }
    if (slugError) {
      toast.error("Please fix the URL slug before saving");
      return;
    }
    if (requireInternalReference && !isGroupLimited && !formData.internal_reference?.trim()) {
      toast.error("Please enter an internal reference");
      return;
    }

    if (isGroupLimited && !lockedGroupId) {
      toast.error("This group event is missing its group. Please reopen it from the Group Events page.");
      return;
    }

    // Emails configured during creation are saved right after the event is
    // created — validate their CC addresses up front (Task #3263).
    if (!isEditMode && eventEmails.length > 0) {
      const invalidCc = findInvalidCcAddresses(eventEmails);
      if (invalidCc.length > 0) {
        toast.error(`Invalid CC email address in Emails tab: ${invalidCc.join(', ')}`);
        return;
      }
    }

    if (!unlimitedSeats) {
      const seats = parseInt(formData.available_seats);
      if (!formData.available_seats || isNaN(seats) || seats < 1) {
        toast.error('Please enter a valid number of seats (or enable "Unlimited")');
        return;
      }
    }

    // Advisory time-clash check (never blocks saving). Compare per session, not
    // the whole multi-day span. Skip for TBC events / sessions without times.
    if (!skipClashCheck && formData.status !== 'tbc') {
      const windows = sessions
        .filter((s) => s.start_time && s.end_time)
        .map((s) => ({
          start: s.start_time,
          end: s.end_time,
          timezone: formData.timezone || 'Europe/London',
          label: s.title || null,
        }));
      if (windows.length > 0) {
        setCheckingClashes(true);
        try {
          const { hasClashes, clashes, redacted, clashCount } = await checkEventClashes({
            windows,
            excludeComplexEventId: isEditMode ? editId : null,
          });
          if (hasClashes) {
            setClashDialog({ open: true, clashes, redacted: !!redacted, clashCount: clashCount ?? 0 });
            setCheckingClashes(false);
            return;
          }
        } catch (err) {
          // Never block saving on a clash-check failure.
        }
        setCheckingClashes(false);
      }
    }

    setSaving(true);
    try {
      const eventPayload = {
        title: formData.title,
        slug: formData.slug,
        description: formData.description || null,
        summary: formData.summary || null,
        custom_duration_explainer: (formData.custom_duration_explainer || "").trim().slice(0, 75) || null,
        speaker_award_config: formStateToConfig(speakerAwards),
        image_url: formData.image_url || null,
        image_focal_point: formData.image_focal_point || null,
        start_date: formData.start_date || null,
        end_date: formData.end_date || null,
        location: formData.location || null,
        status: formData.status,
        event_state: formData.event_state,
        is_featured: formData.is_featured || false,
        timezone: formData.timezone,
        available_seats: unlimitedSeats ? null : (formData.available_seats ? parseInt(formData.available_seats, 10) : null),
        is_unlimited_registration: unlimitedSeats,
        show_seat_count: showSeatCount,
        show_ticket_availability: showTicketAvailability,
        qr_on_confirmation: qrOnConfirmation,
        pricing_config: { collectThirdPartyConsent: collectThirdPartyConsent === true },
        internal_reference: formData.internal_reference || null,
        xero_account_code: formData.xero_account_code || null,
        event_type: serializeEventTypes(formData.event_type),
        registration_closes_at: formData.registration_closes_at || null,
        filter_tags: selectedFilterTags.length > 0
          ? selectedFilterTags.map(key => parseFilterTagKey(key).label)
          : null,
        seo_title: seoTitle || null,
        seo_description: seoDescription || null,
        og_image_url: ogImageUrl || null,
        attached_documents: attachedDocuments,
        documents_section_title: documentsSectionTitle.trim() || null,
        dietary_options: dietaryOptions.map((o) => (o || "").trim()).filter(Boolean),
        allergy_options: allergyOptions.map((o) => (o || "").trim()).filter(Boolean),
        accessibility_options: accessibilityOptions.map((o) => (o || "").trim()).filter(Boolean),
        program_tag: formData.program_tag || null,
        cta_override_url: formData.cta_override_url || null,
        cta_override_mode: formData.cta_override_mode || 'card',
        ...(isGroupLimited ? {
          member_group_id: lockedGroupId,
          group_event_public: formData.group_event_public === true,
        } : {}),
      };

      let eventId;
      if (isEditMode) {
        await base44.entities.ComplexEvent.update(editId, eventPayload);
        eventId = editId;
      } else {
        const created = await base44.entities.ComplexEvent.create(eventPayload);
        eventId = created.id;
      }

      if (isEditMode) {
        const existingTrackIds = existingTracks.map((t) => t.id);
        const currentTrackDbIds = tracks.filter((t) => t.id).map((t) => t.id);
        const deletedTrackIds = existingTrackIds.filter((id) => !currentTrackDbIds.includes(id));
        for (const trackId of deletedTrackIds) {
          await base44.entities.ComplexEventTrack.delete(trackId);
        }
      }

      const trackIdMap = {};
      for (let ti = 0; ti < tracks.length; ti++) {
        const track = tracks[ti];
        const trackPayload = {
          complex_event_id: eventId,
          name: track.name || "Untitled Track",
          description: track.description || null,
          colour: track.colour || null,
          display_order: ti,
        };

        let trackId;
        if (track.id) {
          await base44.entities.ComplexEventTrack.update(track.id, trackPayload);
          trackId = track.id;
        } else {
          const created = await base44.entities.ComplexEventTrack.create(trackPayload);
          trackId = created.id;
        }
        trackIdMap[track._localId] = trackId;
        if (track.id) trackIdMap[track.id] = trackId;
      }

      if (isEditMode) {
        const existingSessionIds = existingSessions.map((s) => s.id);
        const currentSessionDbIds = sessions.filter((s) => s.id).map((s) => s.id);
        const deletedSessionIds = existingSessionIds.filter(
          (id) => !currentSessionDbIds.includes(id)
        );
        for (const sid of deletedSessionIds) {
          const delResp = await fetch(`/api/complex-event-sessions/${sid}`, {
            method: 'DELETE',
            credentials: 'include',
          });
          if (!delResp.ok) {
            console.error(`Failed to delete session ${sid}:`, delResp.status);
          }
        }
      }

      for (let si = 0; si < sessions.length; si++) {
        const session = sessions[si];
        const resolvedTrackIds = (session.track_ids || []).map(id => trackIdMap[id] || id);
        const sessionImageUrl = session.use_event_image ? null : (session.image_url || null);
        const sessionPayload = {
          complex_event_id: eventId,
          title: session.title || "Untitled Session",
          description: session.description || null,
          image_url: sessionImageUrl,
          image_focal_point: session.use_event_image ? null : (session.image_focal_point || null),
          speaker_ids: session.speaker_ids || [],
          speaker_names: session.speaker_names || [],
          start_time: session.start_time || null,
          end_time: session.end_time || null,
          location: session.location || null,
          is_online: session.is_online || false,
          display_order: si,
          track_ids: resolvedTrackIds,
          timezone: formData.timezone,
        };

        if (session.is_online && !isGroupLimited) {
          sessionPayload.zoom_type = session.zoom_type || 'meeting';
          sessionPayload.zoom_host_id = session.zoom_host_id || null;
          sessionPayload.zoom_host_email = session.zoom_host_email || null;
          sessionPayload.zoom_registration_required = session.zoom_registration_required || false;
          sessionPayload.zoom_link_mode = session.zoom_link_mode || 'auto_create';
          sessionPayload.auto_create_zoom = session.auto_create_zoom !== undefined ? session.auto_create_zoom : true;
          if (session.zoom_link_mode === 'link_existing' && session.link_existing_zoom_id) {
            if (session.zoom_type === 'webinar') {
              sessionPayload.zoom_webinar_id = session.link_existing_zoom_id;
              sessionPayload.zoom_meeting_id = null;
            } else {
              sessionPayload.zoom_meeting_id = session.link_existing_zoom_id;
              sessionPayload.zoom_webinar_id = null;
            }
          } else {
            sessionPayload.zoom_meeting_id = session.zoom_meeting_id || null;
            sessionPayload.zoom_webinar_id = session.zoom_webinar_id || null;
            sessionPayload.zoom_join_url = session.zoom_join_url || null;
          }
        } else {
          sessionPayload.zoom_type = null;
          sessionPayload.zoom_host_id = null;
          sessionPayload.zoom_host_email = null;
          sessionPayload.zoom_meeting_id = null;
          sessionPayload.zoom_webinar_id = null;
          sessionPayload.zoom_join_url = null;
          sessionPayload.zoom_start_url = null;
          sessionPayload.zoom_registration_url = null;
          sessionPayload.zoom_registration_required = false;
          sessionPayload.zoom_link_mode = null;
          sessionPayload.auto_create_zoom = false;
        }

        if (session.id) {
          // task-692: strip Zoom resource cols + setup-mode flags from the
          // bypass PATCH. Zoom changes go through change-zoom only.
          const {
            zoom_meeting_id: _zmi,
            zoom_webinar_id: _zwi,
            zoom_join_url: _zju,
            zoom_start_url: _zsu,
            zoom_registration_url: _zru,
            auto_create_zoom: _ac,
            zoom_link_mode: _zlm,
            link_existing_zoom_id: _lez,
            ...patchPayload
          } = sessionPayload;
          const resp = await fetch(`/api/complex-event-sessions/${session.id}?skipOverlapCheck=true`, {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patchPayload),
          });
          if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(errData.error || `Failed to update session: ${session.title}`);
          }
        } else {
          const resp = await fetch('/api/complex-event-sessions?skipOverlapCheck=true', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sessionPayload),
          });
          if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(errData.error || `Failed to create session: ${session.title}`);
          }
        }
      }

      if (isEditMode) {
        const existingDbIds = existingTicketClasses.map(tc => tc.id);
        const currentDbIds = ticketClasses.filter(t => t._dbId).map(t => t._dbId);
        const deletedIds = existingDbIds.filter(id => !currentDbIds.includes(id));
        for (const tcId of deletedIds) {
          await base44.entities.ComplexEventTicketClass.delete(tcId);
        }
      }

      for (let ti = 0; ti < ticketClasses.length; ti++) {
        const ticket = ticketClasses[ti];
        const tcPayload = {
          complex_event_id: eventId,
          name: ticket.name || "Standard Ticket",
          price: isGroupLimited ? 0 : (parseFloat(ticket.price) || 0),
          is_free: isGroupLimited ? true : (ticket.is_free || false),
          early_bird_enabled: isGroupLimited ? false : (ticket.early_bird_enabled || false),
          early_bird_price: !isGroupLimited && ticket.early_bird_enabled && ticket.early_bird_price ? parseFloat(ticket.early_bird_price) : null,
          early_bird_deadline: !isGroupLimited && ticket.early_bird_enabled && ticket.early_bird_deadline ? ticket.early_bird_deadline : null,
          is_group_ticket: isGroupLimited ? false : (ticket.is_group_ticket || false),
          group_size: !isGroupLimited && ticket.is_group_ticket && ticket.group_size ? parseInt(ticket.group_size) : null,
          group_cutoff_date: !isGroupLimited && ticket.is_group_ticket && ticket.group_cutoff_date ? ticket.group_cutoff_date : null,
          vat_rate_key: ticket.vat_rate_key || null,
          vat_rate_label: ticket.vat_rate_label || null,
          vat_rate_percentage: ticket.vat_rate_percentage || null,
          visibility_mode: ticket.visibility_mode || 'members_only',
          role_ids: ticket.role_ids || [],
          member_group_ids: ticket.member_group_ids || [],
          role_match_only: ticket.role_match_only || false,
          offer_type: isGroupLimited ? 'none' : (ticket.offer_type || 'none'),
          bogo_logic_type: !isGroupLimited && ticket.offer_type === 'bogo' ? (ticket.bogo_logic_type || 'buy_x_get_y_free') : null,
          bogo_buy_quantity: !isGroupLimited && ticket.offer_type === 'bogo' && ticket.bogo_buy_quantity ? parseInt(ticket.bogo_buy_quantity) : null,
          bogo_get_free_quantity: !isGroupLimited && ticket.offer_type === 'bogo' && ticket.bogo_get_free_quantity ? parseInt(ticket.bogo_get_free_quantity) : null,
          bulk_discount_threshold: !isGroupLimited && ticket.offer_type === 'bulk_discount' && ticket.bulk_discount_threshold ? parseInt(ticket.bulk_discount_threshold) : null,
          bulk_discount_percentage: !isGroupLimited && ticket.offer_type === 'bulk_discount' && ticket.bulk_discount_percentage ? parseFloat(ticket.bulk_discount_percentage) : null,
          available_count: ticket.is_unlimited_tickets ? null : (ticket.available_count ? parseInt(ticket.available_count) : null),
          is_unlimited_tickets: ticket.is_unlimited_tickets !== false,
          linked_track_ids: ticket.all_tracks ? [] : (ticket.linked_track_ids || []).map(id => trackIdMap[id] || id),
          all_tracks: ticket.all_tracks !== false,
          display_order: ti,
        };

        if (ticket._dbId) {
          await base44.entities.ComplexEventTicketClass.update(ticket._dbId, tcPayload);
        } else {
          await base44.entities.ComplexEventTicketClass.create(tcPayload);
        }
      }

      // Save sponsor assignments
      try {
        if (isEditMode) {
          const existingAssignments = await base44.entities.EventSponsorAssignment.list({ filter: { event_id: eventId, event_type: 'complex' } });
          for (const a of existingAssignments) {
            await base44.entities.EventSponsorAssignment.delete(a.id);
          }
        }
        let sponsorCategoryMap = {};
        if (selectedSponsors.length > 0) {
          const allSponsors = await base44.entities.EventSponsor.list();
          (allSponsors || []).forEach(s => { sponsorCategoryMap[s.id] = s.category_id || null; });
        }
        for (const sponsorId of selectedSponsors) {
          const detail = (sponsorDetails[sponsorId] || '').trim();
          await base44.entities.EventSponsorAssignment.create({
            event_id: eventId,
            event_type: 'complex',
            sponsor_id: sponsorId,
            category_id: sponsorCategoryMap[sponsorId] || null,
            sponsorship_detail: detail || null
          });
        }
      } catch (sponsorErr) {
        console.error('Failed to save sponsor assignments:', sponsorErr);
        toast.error('Event saved but sponsor assignments could not be saved');
      }

      queryClient.invalidateQueries({ queryKey: ["/api/entities/ComplexEvent"] });
      queryClient.invalidateQueries({ queryKey: ["/api/entities/ComplexEventTicketClass"] });
      queryClient.invalidateQueries({ queryKey: ["/api/entities/EventSponsorAssignment"] });
      // Group events return to where they came from: the group events list
      // (when opened from there) or the member group detail page.
      const returnGroupId = groupIdParam || existingEvent?.member_group_id || null;
      const groupReturnUrl = returnGroupId
        ? (fromParam === 'GroupEvents'
            ? createPageUrl("GroupEvents")
            : createPageUrl("MemberGroupDetail") + "?id=" + returnGroupId)
        : null;
      if (isEditMode) {
        queryClient.invalidateQueries({ queryKey: ["/api/entities/ComplexEventTrack", editId] });
        queryClient.invalidateQueries({ queryKey: ["/api/complex-event-sessions", editId] });
        queryClient.invalidateQueries({ queryKey: ["/api/entities/ComplexEventTicketClass", editId] });
        toast.success("Complex event updated");
        // Group events leave the editor and return to the group page; normal
        // events stay on the editor as before.
        if (groupReturnUrl) {
          setTimeout(() => { window.location.href = groupReturnUrl; }, 500);
        } else {
          baselineSnapshotRef.current = buildSnapshot();
          pendingBaselineResetRef.current = true;
          setIsDirtyState(false);
          setSponsorsInitialized(false);
        }
      } else {
        // Task #3263: persist emails configured during creation, now that the
        // event has an ID. A failure here must never lose the created event —
        // surface a clear error and send the admin to edit mode to fix it.
        let emailSaveFailed = false;
        if (eventEmails.length > 0) {
          try {
            const { response, result } = await putEventEmails(eventId, eventEmails, true);
            if (!response.ok) {
              throw new Error(result?.error || 'Failed to save email configurations');
            }
            const failures = result?.schedulingFailures || [];
            const schedulerError = result?.schedulerError || result?.error;
            if (failures.length > 0 || schedulerError) {
              toast.error(`Event created and emails saved, but ${formatSchedulingFailures({ schedulingFailures: failures, error: schedulerError })}`);
            }
          } catch (emailErr) {
            console.error('Failed to save event emails after creation:', emailErr);
            emailSaveFailed = true;
            toast.error(
              `Event created, but email settings could not be saved: ${emailErr.message || 'Unknown error'}. Opening the event so you can fix them in the Emails tab.`,
              { duration: 10000 }
            );
          }
        }
        if (emailSaveFailed) {
          window.location.href = `${createPageUrl("CreateComplexEvent")}?id=${eventId}`;
        } else {
          toast.success("Complex event created");
          window.location.href = groupReturnUrl || createPageUrl("Events");
        }
      }
    } catch (err) {
      console.error("Save error:", err);
      toast.error("Failed to save: " + (err.message || "Unknown error"));
    } finally {
      setSaving(false);
    }
  };

  const handleClashConfirm = () => {
    setClashDialog({ open: false, clashes: [], redacted: false, clashCount: 0 });
    handleSave(true);
  };

  const handleClashCancel = () => {
    setClashDialog({ open: false, clashes: [], redacted: false, clashCount: 0 });
  };

  if (isEditMode && (loadingEvent || loadingTracks || loadingSessions || loadingTicketClasses)) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                // Group events return to where they came from: the group events
                // list (when opened from there) or the member group detail page.
                // Non-group events keep returning to the general Events list.
                const backGroupId = groupIdParam || existingEvent?.member_group_id || null;
                if (backGroupId) {
                  window.location.href = fromParam === 'GroupEvents'
                    ? createPageUrl('GroupEvents')
                    : createPageUrl('MemberGroupDetail') + '?id=' + backGroupId;
                } else {
                  window.location.href = createPageUrl('Events');
                }
              }}
              data-testid="button-back"
            >
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h1 className="text-2xl font-bold text-slate-900" data-testid="text-page-title">
              {isEditMode ? "Edit Complex Event" : "Create Complex Event"}
            </h1>
          </div>
          <Button onClick={() => handleSave()} disabled={saving || checkingClashes || !isDirty} data-testid="button-save">
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
            {isEditMode ? "Save Changes" : "Create Event"}
          </Button>
        </div>

        <Tabs value={activeSection} onValueChange={setActiveSection}>
          <TabsList className="mb-6">
            <TabsTrigger value="details" data-testid="button-section-details">Event Details</TabsTrigger>
            <TabsTrigger value="tracks" data-testid="button-section-tracks">Tracks</TabsTrigger>
            <TabsTrigger value="sessions" data-testid="button-section-sessions">Sessions</TabsTrigger>
            <TabsTrigger value="tickets" data-testid="button-section-tickets">Tickets</TabsTrigger>
            <TabsTrigger value="emails" data-testid="button-section-emails">Emails</TabsTrigger>
            {isEditMode && (
              <TabsTrigger value="surveys" data-testid="button-section-surveys">Surveys</TabsTrigger>
            )}
          </TabsList>

        <TabsContent value="details">
          <>
            {/* Task #1519: Group event banner + audience control (limited mode) */}
            {isGroupLimited && (
              <Card className="border-blue-200 bg-blue-50/40 shadow-sm mb-6" data-testid="card-group-event">
                <CardHeader className="pb-4">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Users className="h-5 w-5 text-blue-600" />
                    Group Event
                  </CardTitle>
                  <CardDescription>
                    This event is locked to a group and limited to free tickets with a manual online link.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center gap-2 p-3 rounded-lg border-2 border-blue-200 bg-white">
                    <Building2 className="h-4 w-4 text-blue-600 shrink-0" />
                    <span className="text-sm text-slate-700">
                      This event is for{" "}
                      <span className="font-semibold text-slate-900" data-testid="text-locked-group-name">
                        {lockedGroupName || "your group"}
                      </span>
                    </span>
                  </div>

                  <div>
                    <Label className="text-sm font-medium mb-3 block">Audience</Label>
                    <p className="text-xs text-slate-500 mb-3">Choose who can see and register for this event</p>
                    <RadioGroup
                      value={formData.group_event_public ? "public" : "group_only"}
                      onValueChange={(v) => updateField("group_event_public", v === "public")}
                      className="grid grid-cols-1 md:grid-cols-2 gap-4"
                      data-testid="radio-group-audience"
                    >
                      <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${!formData.group_event_public ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}>
                        <RadioGroupItem value="group_only" id="audience-group-only" data-testid="radio-audience-group-only" />
                        <Label htmlFor="audience-group-only" className="cursor-pointer flex-1">
                          <span className="font-medium">Group members only</span>
                          <p className="text-xs text-slate-500">Only members of this group can see it</p>
                        </Label>
                      </div>
                      <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${formData.group_event_public ? 'border-green-500 bg-green-50' : 'border-slate-200 hover:border-slate-300'}`}>
                        <RadioGroupItem value="public" id="audience-public" data-testid="radio-audience-public" />
                        <Label htmlFor="audience-public" className="cursor-pointer flex-1">
                          <span className="font-medium">Public</span>
                          <p className="text-xs text-slate-500">Anyone can see and register</p>
                        </Label>
                      </div>
                    </RadioGroup>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Event Status Card — matches EditEvent */}
            <Card className="border-slate-200 shadow-sm mb-6">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Eye className="h-5 w-5 text-purple-600" />
                  Event Status
                </CardTitle>
                <CardDescription>Configure when and how members can access this event</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {!isGroupLimited && (
                <div className="flex items-center justify-between p-3 rounded-lg border-2 border-slate-200">
                  <div>
                    <Label className="font-medium">Featured Event</Label>
                    <p className="text-xs text-slate-500">Highlight this event at the top of event listings</p>
                  </div>
                  <Switch
                    checked={formData.is_featured}
                    onCheckedChange={(checked) => updateField("is_featured", checked)}
                    data-testid="switch-is-featured"
                  />
                </div>
                )}

                {!isGroupLimited && (
                  <SpeakerAwardsSection
                    speakers={speakers.filter(s =>
                      sessions.some(sess => (sess.speaker_ids || []).includes(s.id))
                    )}
                    value={speakerAwards}
                    onChange={setSpeakerAwards}
                    eventId={isEditMode ? editId : undefined}
                    eventType={isEditMode ? "complex_event" : undefined}
                  />
                )}

                {!isGroupLimited && (
                <div>
                  <Label className="text-sm font-medium mb-3 block">Event Timing</Label>
                  <p className="text-xs text-slate-500 mb-3">Determines whether dates are required for this event</p>
                  <RadioGroup
                    value={formData.status}
                    onValueChange={handleTimingChange}
                    className="grid grid-cols-2 gap-4"
                    data-testid="radio-event-timing"
                  >
                    <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${formData.status === 'published' ? 'border-green-500 bg-green-50' : 'border-slate-200 hover:border-slate-300'}`}>
                      <RadioGroupItem value="published" id="timing-published" data-testid="radio-timing-published" />
                      <Label htmlFor="timing-published" className="cursor-pointer flex-1">
                        <span className="font-medium">Scheduled</span>
                        <p className="text-xs text-slate-500">Event has confirmed dates</p>
                      </Label>
                    </div>
                    <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${formData.status === 'tbc' ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}>
                      <RadioGroupItem value="tbc" id="timing-tbc" data-testid="radio-timing-tbc" />
                      <Label htmlFor="timing-tbc" className="cursor-pointer flex-1">
                        <span className="font-medium">To Be Confirmed</span>
                        <p className="text-xs text-slate-500">Dates not yet set</p>
                      </Label>
                    </div>
                  </RadioGroup>
                  {formData.status === 'tbc' && (
                    <p className="mt-3 text-sm text-blue-600 bg-blue-50 p-2 rounded">
                      Dates will be shown as "To be confirmed" and Zoom webinar/meeting selection is optional.
                    </p>
                  )}
                </div>
                )}

                <div>
                  <Label className="text-sm font-medium mb-3 block">Event State</Label>
                  <p className="text-xs text-slate-500 mb-3">Controls visibility and whether members can register</p>
                  <RadioGroup
                    value={formData.event_state}
                    onValueChange={(v) => updateField("event_state", v)}
                    className="grid grid-cols-3 gap-4"
                    data-testid="radio-event-state"
                  >
                    <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${formData.event_state === 'active' ? 'border-green-500 bg-green-50' : 'border-slate-200 hover:border-slate-300'}`}>
                      <RadioGroupItem value="active" id="state-active" data-testid="radio-state-active" />
                      <Label htmlFor="state-active" className="cursor-pointer flex-1">
                        <span className="font-medium">Active</span>
                        <p className="text-xs text-slate-500">Visible, accepting registrations</p>
                      </Label>
                    </div>
                    <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${formData.event_state === 'draft' ? 'border-warning/50 bg-warning/10' : 'border-slate-200 hover:border-slate-300'}`}>
                      <RadioGroupItem value="draft" id="state-draft" data-testid="radio-state-draft" />
                      <Label htmlFor="state-draft" className="cursor-pointer flex-1">
                        <span className="font-medium">Draft</span>
                        <p className="text-xs text-slate-500">Hidden from members</p>
                      </Label>
                    </div>
                    <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${formData.event_state === 'closed' ? 'border-red-500 bg-red-50' : 'border-slate-200 hover:border-slate-300'}`}>
                      <RadioGroupItem value="closed" id="state-closed" data-testid="radio-state-closed" />
                      <Label htmlFor="state-closed" className="cursor-pointer flex-1">
                        <span className="font-medium">Closed</span>
                        <p className="text-xs text-slate-500">Visible, registration closed</p>
                      </Label>
                    </div>
                  </RadioGroup>
                </div>
              </CardContent>
            </Card>

            {/* Event Details Card — matches EditEvent (minus Session Leaders & CTA Override) */}
            <Card className="border-slate-200 shadow-sm mb-6">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Calendar className="h-5 w-5 text-blue-600" />
                  Event Details
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Program vs One-off Toggle */}
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
                  <div className="space-y-0.5">
                    <Label htmlFor="program-toggle" className="text-base font-medium">
                      {isProgramEvent ? "Program Event" : "One-off Event"}
                    </Label>
                    <p className="text-sm text-slate-500">
                      {isProgramEvent
                        ? "Event is part of a program - requires program tickets to attend"
                        : "Standalone event - not linked to any program"}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-sm ${!isProgramEvent ? 'text-slate-900 font-medium' : 'text-slate-500'}`}>
                      One-off
                    </span>
                    <Switch
                      id="program-toggle"
                      checked={isProgramEvent}
                      onCheckedChange={(checked) => {
                        setIsProgramEvent(checked);
                        if (!checked) {
                          updateField('program_tag', '');
                        }
                      }}
                      data-testid="switch-program-toggle"
                    />
                    <span className={`text-sm ${isProgramEvent ? 'text-slate-900 font-medium' : 'text-slate-500'}`}>
                      Program
                    </span>
                  </div>
                </div>

                {isProgramEvent && (
                  <div className="space-y-2">
                    <Label htmlFor="program">Program *</Label>
                    <Select
                      value={formData.program_tag}
                      onValueChange={(value) => updateField('program_tag', value)}
                      disabled={loadingPrograms}
                      data-testid="select-program"
                    >
                      <SelectTrigger data-testid="select-program-trigger">
                        <SelectValue placeholder={loadingPrograms ? "Loading programs..." : "Select a program"} />
                      </SelectTrigger>
                      <SelectContent>
                        {programs.map((program) => (
                          <SelectItem
                            key={program.id}
                            value={program.program_tag || program.name}
                            data-testid={`select-program-${program.id}`}
                          >
                            {program.name || program.program_tag}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-slate-500">
                      The program determines ticket types that can be used for this event
                    </p>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="title">Event Title *</Label>
                  <Input
                    id="title"
                    value={formData.title}
                    onChange={(e) => updateField("title", e.target.value)}
                    placeholder="Enter event title"
                    required
                    data-testid="input-title"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="slug">URL Slug</Label>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-500 whitespace-nowrap">/session-events/</span>
                    <Input
                      id="slug"
                      value={formData.slug}
                      onChange={(e) => {
                        setSlugManuallyEdited(true);
                        const value = e.target.value
                          .toLowerCase()
                          .replace(/[^a-z0-9-]/g, '');
                        updateField("slug", value);
                      }}
                      placeholder="my-event-name"
                      data-testid="input-slug"
                    />
                  </div>
                  {slugError && (
                    <p className="text-xs text-red-600" data-testid="text-slug-error">{slugError}</p>
                  )}
                  {checkingSlug && (
                    <p className="text-xs text-slate-400">Checking availability...</p>
                  )}
                  <p className="text-xs text-slate-500">
                    Friendly URL for sharing. Leave empty to use the default URL format.
                  </p>
                </div>

                {/* Event Sponsors - Collapsible */}
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <button
                    type="button"
                    className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors"
                    onClick={() => setSponsorsExpanded(prev => !prev)}
                    data-testid="button-toggle-sponsors-section"
                  >
                    <span className="flex items-center gap-2 font-medium text-slate-700">
                      <Handshake className="h-4 w-4 text-blue-600" />
                      Sponsors
                      {selectedSponsors.length > 0 && (
                        <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">{selectedSponsors.length}</span>
                      )}
                    </span>
                    {sponsorsExpanded ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
                  </button>
                  {sponsorsExpanded && (
                    <div className="p-4 border-t border-slate-200">
                      <EventSponsorSelector
                        eventId={editId}
                        eventType="complex"
                        selectedSponsorIds={selectedSponsors}
                        onSelectedSponsorIdsChange={setSelectedSponsors}
                        sponsorDetails={sponsorDetails}
                        onSponsorDetailsChange={(id, val) => setSponsorDetails(prev => ({ ...prev, [id]: val }))}
                      />
                    </div>
                  )}
                </div>

                <SEOSettings
                  seoTitle={seoTitle}
                  onSeoTitleChange={setSeoTitle}
                  seoDescription={seoDescription}
                  onSeoDescriptionChange={setSeoDescription}
                  ogImageUrl={ogImageUrl}
                  onOgImageUrlChange={setOgImageUrl}
                  defaultTitle={formData.title}
                  defaultDescription={formData.summary}
                />
                {(() => {
                  const complexPreviewPath = formData.slug
                    ? `/complex-event/${formData.slug}`
                    : editId
                      ? `/ComplexEventDetail?id=${editId}`
                      : null;
                  return (
                    <UnfurlPreview
                      title={seoTitle || formData.title || ''}
                      description={seoDescription || formData.summary || ''}
                      image={ogImageUrl || formData.image_url || ''}
                      url={typeof window !== 'undefined' && complexPreviewPath ? `${window.location.origin}${complexPreviewPath}` : ''}
                      previewPath={complexPreviewPath}
                    />
                  );
                })()}

                <div className="space-y-2">
                  <Label htmlFor="summary">Summary</Label>
                  <Textarea
                    id="summary"
                    value={formData.summary}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value.length <= summaryMaxLength) {
                        updateField("summary", value);
                      }
                    }}
                    placeholder={`Brief summary for event cards (max ${summaryMaxLength} characters)`}
                    className="resize-none"
                    rows={2}
                    data-testid="input-summary"
                  />
                  <div className="flex justify-between text-xs text-slate-500">
                    <span>Displayed on event cards and listings</span>
                    <span className={formData.summary.length >= summaryMaxLength - 10 ? 'text-warning' : ''}>
                      {formData.summary.length}/{summaryMaxLength}
                    </span>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="custom-duration-explainer">Custom duration explainer</Label>
                  <Input
                    id="custom-duration-explainer"
                    value={formData.custom_duration_explainer}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value.length <= 75) {
                        updateField("custom_duration_explainer", value);
                      }
                    }}
                    placeholder="e.g. Runs Tuesdays & Thursdays over 2 weeks"
                    data-testid="input-custom-duration-explainer"
                  />
                  <div className="flex justify-between text-xs text-slate-500">
                    <span>Shown with the day count on cards when event days are not consecutive</span>
                    <span className={(formData.custom_duration_explainer || "").length >= 65 ? 'text-warning' : ''}>
                      {(formData.custom_duration_explainer || "").length}/75
                    </span>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Full Description</Label>
                  <div className="border rounded-md overflow-hidden" data-testid="input-description">
                    <ReactQuill
                      theme="snow"
                      value={formData.description || ''}
                      onChange={(val) => updateField("description", val)}
                      modules={QUILL_MODULES}
                      formats={QUILL_FORMATS}
                      placeholder="Describe the event..."
                      style={{ minHeight: '150px' }}
                    />
                  </div>
                </div>

                {/* Filter Tags */}
                {eventCategories.length > 0 && (
                  <div className="space-y-2">
                    <Label className="flex items-center gap-2">
                      <Tag className="h-4 w-4 text-slate-500" />
                      Filter Tags
                    </Label>
                    <p className="text-xs text-slate-500 mb-2">
                      Select one or more filter values to help categorize this event.
                    </p>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          className="w-full justify-between gap-2"
                          data-testid="filter-tags-trigger"
                        >
                          <div className="flex items-center gap-2">
                            <Tag className="w-4 h-4" />
                            {selectedFilterTags.length === 0 ? (
                              <span className="text-slate-500">Select filter tags...</span>
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
                            <span className="text-sm font-medium text-slate-700">Select filter tags</span>
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
                                    type="button"
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
                    {selectedFilterTags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {selectedFilterTags.map((tagKey, idx) => (
                          <Badge
                            key={idx}
                            variant="secondary"
                            className="text-xs"
                          >
                            {parseFilterTagKey(tagKey).label}
                            <button
                              type="button"
                              className="ml-1 hover:text-slate-900"
                              onClick={() => setSelectedFilterTags(prev => prev.filter(t => t !== tagKey))}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {!isGroupLimited && (
                  <div className="space-y-2">
                    <Label htmlFor="internal_reference">Internal Reference{requireInternalReference && ' *'}</Label>
                    <Input
                      id="internal_reference"
                      value={formData.internal_reference}
                      onChange={(e) => updateField("internal_reference", e.target.value)}
                      placeholder="e.g. PROJECT-123, Budget Code, etc."
                      data-testid="input-internal-reference"
                    />
                    <p className="text-xs text-slate-500">
                      For internal use only. Not shown to attendees but included on invoices.
                    </p>
                  </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="xero_account_code">Xero Account Code</Label>
                    <Input
                      id="xero_account_code"
                      value={formData.xero_account_code}
                      onChange={(e) => updateField("xero_account_code", e.target.value)}
                      placeholder={(() => {
                        const setting = systemSettings.find(s => s.setting_key === 'xero_sales_account_code');
                        return setting?.setting_value || '200';
                      })()}
                      data-testid="input-xero-account-code"
                    />
                    <p className="text-xs text-slate-500">
                      {formData.xero_account_code
                        ? "This event will use its own Xero account code for invoices."
                        : "Using default from Event Settings. Set a value here to override."}
                    </p>
                  </div>
                </div>

                {eventTypes.length > 0 && !isGroupLimited && (
                  <div className="space-y-2">
                    <Label htmlFor="event_type">Event Type</Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="w-full justify-between font-normal" data-testid="select-event-type">
                          {formData.event_type?.length > 0
                            ? formData.event_type.join(', ')
                            : "Select event types..."}
                          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-full min-w-[260px] p-2" align="start">
                        <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
                            {eventTypes.map((type, idx) => {
                              const typeName = typeof type === 'string' ? type : type.name;
                              const isSelected = formData.event_type?.includes(typeName);
                              return (
                                <button
                                  key={idx}
                                  type="button"
                                  className={`flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left hover-elevate ${isSelected ? 'bg-accent' : ''}`}
                                  data-testid={`option-event-type-${idx}`}
                                  onClick={() => {
                                    const current = formData.event_type || [];
                                    const updated = isSelected
                                      ? current.filter(t => t !== typeName)
                                      : [...current, typeName];
                                    updateField('event_type', updated);
                                  }}
                                >
                                  <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${isSelected ? 'bg-primary border-primary' : 'border-input'}`}>
                                    {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                                  </div>
                                  {typeName}
                                </button>
                              );
                            })}
                          </div>
                          {formData.event_type?.length > 0 && (
                            <button
                              type="button"
                              className="w-full mt-2 pt-2 border-t text-xs text-muted-foreground hover:text-foreground text-center"
                              onClick={() => updateField('event_type', [])}
                              data-testid="button-clear-event-types"
                            >
                              Clear all
                            </button>
                          )}
                        </PopoverContent>
                      </Popover>
                      <p className="text-xs text-slate-500">
                        Categorize this event by type (e.g., Workshop, Training). You can select multiple types.
                      </p>
                    </div>
                  )}

                {!isGroupLimited && (
                <div className="space-y-2">
                  <Label htmlFor="cta_override_url">CTA Override URL</Label>
                  <Input
                    id="cta_override_url"
                    value={formData.cta_override_url || ""}
                    onChange={(e) => updateField('cta_override_url', e.target.value)}
                    placeholder="e.g. /my-custom-page or https://example.com/event-page"
                    data-testid="input-cta-override-url"
                  />
                  <p className="text-xs text-slate-500">
                    Optional. Use this to link to a custom Event Spotlight page or external booking flow.
                  </p>
                  <div className="space-y-2 pt-2">
                    <Label htmlFor="cta_override_mode">CTA Override Mode</Label>
                    <Select
                      value={formData.cta_override_mode || 'card'}
                      onValueChange={(value) => updateField('cta_override_mode', value)}
                      disabled={!formData.cta_override_url}
                    >
                      <SelectTrigger id="cta_override_mode" data-testid="select-cta-override-mode">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="card" data-testid="option-cta-mode-card">
                          Card CTA links to override URL
                        </SelectItem>
                        <SelectItem value="detail_page" data-testid="option-cta-mode-detail-page">
                          Card opens detail page; "Continue to book" links to override URL
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-slate-500">
                      {formData.cta_override_url
                        ? 'In "detail page" mode, the event card opens the standard detail page where attendees can see ticket prices before being redirected to the override URL via a "Continue to book" button.'
                        : 'Set a CTA Override URL above to enable this option.'}
                    </p>
                  </div>
                </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="start_date">
                      Start Date & Time
                    </Label>
                    <TimezoneAwareDateTimeInput
                      id="start_date"
                      tz={formData.timezone || DEFAULT_TIMEZONE}
                      value={formData.start_date}
                      onChange={() => {}}
                      disabled
                      className="bg-slate-100 cursor-not-allowed"
                      data-testid="input-start-date"
                    />
                    <p className="text-xs text-slate-500">
                      {formData.status === 'tbc'
                        ? "Date disabled for TBC events"
                        : "Auto-populated from the earliest session across all tracks"}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="end_date">End Date & Time</Label>
                    <TimezoneAwareDateTimeInput
                      id="end_date"
                      tz={formData.timezone || DEFAULT_TIMEZONE}
                      value={formData.end_date}
                      onChange={() => {}}
                      disabled
                      className="bg-slate-100 cursor-not-allowed"
                      data-testid="input-end-date"
                    />
                    <p className="text-xs text-slate-500">
                      {formData.status === 'tbc'
                        ? "Date disabled for TBC events"
                        : "Auto-populated from the latest session across all tracks"}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="location">Location</Label>
                    <Input
                      id="location"
                      value={formData.location}
                      onChange={(e) => updateField("location", e.target.value)}
                      placeholder="Venue or address"
                      data-testid="input-location"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="timezone">Event Timezone</Label>
                    <Select value={formData.timezone} onValueChange={(v) => updateField("timezone", v)}>
                      <SelectTrigger id="timezone" data-testid="select-timezone">
                        <SelectValue placeholder="Select timezone" />
                      </SelectTrigger>
                      <SelectContent>
                        {TIMEZONE_OPTIONS.map((tz) => (
                          <SelectItem key={tz.value} value={tz.value}>
                            {tz.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-slate-500">
                      Times will be displayed and stored in this timezone.
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="registration_closes_at">Registration Closes On (Optional)</Label>
                  <TimezoneAwareDateTimeInput
                    id="registration_closes_at"
                    tz={formData.timezone || DEFAULT_TIMEZONE}
                    value={formData.registration_closes_at}
                    onChange={(iso) => {
                      if (iso && formData.end_date && new Date(iso) > new Date(formData.end_date)) {
                        toast.error('Registration close date cannot be after the event end date');
                        return;
                      }
                      updateField("registration_closes_at", iso);
                    }}
                    max={formData.end_date || undefined}
                    disabled={formData.status === 'tbc'}
                    className={formData.status === 'tbc' ? "bg-slate-100 cursor-not-allowed" : ""}
                    data-testid="input-registration-closes-at"
                  />
                  <p className="text-xs text-slate-500">
                    If set, registration will automatically close at this time. Must be on or before the event end time.
                  </p>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="available_seats">Available Seats</Label>
                    <div className="flex items-center gap-2">
                      <Switch
                        id="unlimited-seats"
                        checked={unlimitedSeats}
                        onCheckedChange={(checked) => {
                          setUnlimitedSeats(checked);
                          if (checked) {
                            updateField('available_seats', '');
                          }
                        }}
                        data-testid="switch-unlimited-seats"
                      />
                      <Label htmlFor="unlimited-seats" className="text-sm font-normal cursor-pointer">
                        Unlimited
                      </Label>
                    </div>
                  </div>
                  {!unlimitedSeats && (
                    <Input
                      id="available_seats"
                      type="number"
                      min="1"
                      value={formData.available_seats}
                      onChange={(e) => updateField("available_seats", e.target.value)}
                      placeholder="Enter number of seats"
                      data-testid="input-seats"
                    />
                  )}
                  <p className="text-xs text-slate-500">
                    Set the maximum number of attendees for this event
                  </p>

                  {globalShowSeats && !isGroupLimited && (
                    <div className="flex items-center justify-between pt-2 border-t">
                      <div>
                        <Label htmlFor="show-seat-count" className="text-sm">Show seat count</Label>
                        <p className="text-xs text-slate-500">Display available seats on event cards</p>
                      </div>
                      <Switch
                        id="show-seat-count"
                        checked={showSeatCount}
                        onCheckedChange={setShowSeatCount}
                        data-testid="switch-show-seat-count"
                      />
                    </div>
                  )}

                  {!isGroupLimited && (<>
                  <div className="flex items-center justify-between pt-2 border-t">
                    <div>
                      <Label htmlFor="show-ticket-availability" className="text-sm">Show ticket availability</Label>
                      <p className="text-xs text-slate-500">Display remaining tickets per class on event page</p>
                    </div>
                    <Switch
                      id="show-ticket-availability"
                      checked={showTicketAvailability}
                      onCheckedChange={setShowTicketAvailability}
                      data-testid="switch-show-ticket-availability"
                    />
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t">
                    <div className="flex items-center gap-2">
                      <QrCode className="h-4 w-4 text-slate-500" />
                      <div>
                        <Label htmlFor="qr-on-confirmation" className="text-sm">Entrance QR code</Label>
                        <p className="text-xs text-slate-500">Attach a check-in QR code to booking confirmation emails (per in-person session)</p>
                      </div>
                    </div>
                    <Switch
                      id="qr-on-confirmation"
                      checked={qrOnConfirmation}
                      onCheckedChange={setQrOnConfirmation}
                      data-testid="switch-qr-on-confirmation"
                    />
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t">
                    <div>
                      <Label htmlFor="collect-third-party-consent" className="text-sm">Collect third-party data sharing consent</Label>
                      <p className="text-xs text-slate-500">Adds an optional, default-checked consent checkbox below the terms &amp; conditions on the registration page</p>
                    </div>
                    <Switch
                      id="collect-third-party-consent"
                      checked={collectThirdPartyConsent}
                      onCheckedChange={setCollectThirdPartyConsent}
                      data-testid="switch-collect-third-party-consent"
                    />
                  </div>
                  </>)}
                </div>

                <EventImageUpload
                  value={formData.image_url}
                  onChange={(url) => updateField("image_url", url)}
                />

                {formData.image_url && (
                  <FocalPointPicker
                    imageUrl={formData.image_url}
                    focalPoint={formData.image_focal_point}
                    onChange={(point) => updateField('image_focal_point', point)}
                  />
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-200 shadow-sm">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg">Documents</CardTitle>
                <CardDescription>
                  Upload public files (programmes, agendas, info packs) shown on the event page. PDFs open in an in-page viewer; other files open in a new tab.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <EventDocumentsManager
                  sectionTitle={documentsSectionTitle}
                  onSectionTitleChange={setDocumentsSectionTitle}
                  documents={attachedDocuments}
                  onDocumentsChange={setAttachedDocuments}
                  entityId={editId || null}
                />
              </CardContent>
            </Card>

            {!isGroupLimited && collectAttendeeOptionsEnabled && (
            <Card className="border-slate-200 shadow-sm">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg">Dietary, Allergy &amp; Accessibility Options</CardTitle>
                <CardDescription>
                  Define the options registrants can choose from for each attendee during booking. Sections with no options are hidden from registrants.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <EventOptionListsEditor
                  dietaryOptions={dietaryOptions}
                  allergyOptions={allergyOptions}
                  accessibilityOptions={accessibilityOptions}
                  onDietaryChange={setDietaryOptions}
                  onAllergyChange={setAllergyOptions}
                  onAccessibilityChange={setAccessibilityOptions}
                />
              </CardContent>
            </Card>
            )}

          </>
        </TabsContent>

        <TabsContent value="tracks">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="pb-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-lg">Tracks</CardTitle>
                  <CardDescription>
                    Define tracks to organise sessions by theme, room, or stream.
                  </CardDescription>
                </div>
                <Button onClick={addTrack} data-testid="button-add-track">
                  <Plus className="w-4 h-4 mr-2" />
                  Add Track
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">

              {tracks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <p className="text-slate-500 mb-2" data-testid="text-no-tracks">
                    No tracks yet
                  </p>
                  <p className="text-slate-400 text-sm mb-4">
                    Add tracks to organise sessions by theme, room, or stream.
                  </p>
                  <Button variant="outline" onClick={addTrack} data-testid="button-add-first-track">
                    <Plus className="w-4 h-4 mr-2" />
                    Add First Track
                  </Button>
                </div>
              ) : (
                tracks.map((track, trackIdx) => (
                  <div key={track._localId} className="border border-slate-200 rounded-md overflow-hidden" data-testid={`card-track-${track._localId}`}>
                    <div className="flex flex-row items-center justify-between gap-2 p-4 pb-2">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <div
                          className="w-4 h-4 rounded-full flex-shrink-0"
                          style={{ backgroundColor: track.colour || "#3B82F6" }}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            setExpandedTracks((prev) => ({
                              ...prev,
                              [track._localId]: !prev[track._localId],
                            }))
                          }
                        >
                          {expandedTracks[track._localId] ? (
                            <ChevronUp className="w-4 h-4" />
                          ) : (
                            <ChevronDown className="w-4 h-4" />
                          )}
                        </Button>
                        <span className="font-semibold truncate">
                          {track.name || "Untitled Track"}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={trackIdx === 0}
                          onClick={() => moveTrack(track._localId, -1)}
                          data-testid={`button-move-track-up-${track._localId}`}
                        >
                          <ChevronUp className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={trackIdx === tracks.length - 1}
                          onClick={() => moveTrack(track._localId, 1)}
                          data-testid={`button-move-track-down-${track._localId}`}
                        >
                          <ChevronDown className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeTrack(track._localId)}
                          data-testid={`button-remove-track-${track._localId}`}
                        >
                          <Trash2 className="w-4 h-4 text-red-500" />
                        </Button>
                      </div>
                    </div>

                    {expandedTracks[track._localId] && (
                      <div className="px-4 pb-4 space-y-4">
                        <div className="grid gap-4 md:grid-cols-2">
                          <div className="space-y-2">
                            <Label>Track Name *</Label>
                            <Input
                              value={track.name}
                              onChange={(e) => updateTrack(track._localId, "name", e.target.value)}
                              placeholder="e.g. Main Stage, Workshop Room A"
                              data-testid={`input-track-name-${track._localId}`}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Colour</Label>
                            <div className="flex flex-wrap gap-2">
                              {TRACK_COLOURS.map((c) => (
                                <button
                                  key={c}
                                  className={`w-7 h-7 rounded-full border-2 transition-all ${
                                    track.colour === c ? "border-slate-900 scale-110" : "border-transparent"
                                  }`}
                                  style={{ backgroundColor: c }}
                                  onClick={() => updateTrack(track._localId, "colour", c)}
                                  data-testid={`button-colour-${c}-${track._localId}`}
                                />
                              ))}
                            </div>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label>Track Description</Label>
                          <Textarea
                            value={track.description || ""}
                            onChange={(e) => updateTrack(track._localId, "description", e.target.value)}
                            placeholder="Describe this track..."
                            rows={2}
                            data-testid={`input-track-description-${track._localId}`}
                          />
                        </div>

                        {(() => {
                          const trackRef = track.id || track._localId;
                          const linkedSessions = sessions.filter(s => (s.track_ids || []).includes(trackRef));
                          if (linkedSessions.length === 0) return null;
                          return (
                            <div className="space-y-1.5" data-testid={`track-sessions-ref-${track._localId}`}>
                              <Label className="text-xs text-slate-400">Linked Sessions</Label>
                              <div className="space-y-1">
                                {linkedSessions.map(s => (
                                  <div key={s._localId} className="flex items-center gap-2 text-xs text-slate-500 px-2 py-1 rounded bg-slate-50">
                                    <span className="font-medium truncate">{s.title || 'Untitled'}</span>
                                    {s.start_time && (
                                      <span className="text-slate-400 flex-shrink-0">
                                        {new Date(s.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sessions">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="pb-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-lg">Sessions</CardTitle>
                  <CardDescription>
                    Add sessions and assign them to one or more tracks.
                  </CardDescription>
                </div>
                <Button onClick={() => openSessionDialog()} data-testid="button-add-session">
                  <Plus className="w-4 h-4 mr-2" />
                  Add Session
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">

              {sessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <p className="text-slate-500 mb-2" data-testid="text-no-sessions">
                    No sessions yet
                  </p>
                  <p className="text-slate-400 text-sm mb-4">
                    Add sessions and assign them to tracks.
                  </p>
                  <Button variant="outline" onClick={() => openSessionDialog()} data-testid="button-add-first-session">
                    <Plus className="w-4 h-4 mr-2" />
                    Add First Session
                  </Button>
                </div>
              ) : (
                <AdminScheduleGrid
                  sessions={sessions}
                  tracks={tracks}
                  timezone={formData.timezone || DEFAULT_TIMEZONE}
                  speakerMap={speakers.reduce((map, s) => { map[s.id] = s; return map; }, {})}
                  onEdit={(session) => openSessionDialog(session)}
                  onDelete={(localId) => removeSession(localId)}
                  onAddAtSlot={({ startTime, trackId }) => {
                    const prefillStartTime = startTime ? toLocalDatetimeStr(startTime) : "";
                    const prefillTrackIds = trackId ? [trackId] : [];
                    openSessionDialog(null, { start_time: prefillStartTime, track_ids: prefillTrackIds });
                  }}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tickets" forceMount className={activeSection !== 'tickets' ? 'hidden' : ''}>
        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="pb-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-lg">Ticket Classes</CardTitle>
                <CardDescription>Add ticket classes to allow registrations for this event</CardDescription>
              </div>
              {!isGroupLimited && (
              <Button onClick={addTicketClass} data-testid="button-add-ticket-class">
                <Plus className="w-4 h-4 mr-2" />
                Add Ticket Class
              </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">

        {ticketClasses.length === 0 ? (
            <div className="py-12 text-center text-slate-500">
              <Ticket className="w-12 h-12 mx-auto mb-3 text-slate-300" />
              <p className="font-medium">No ticket classes yet</p>
              <p className="text-sm">Add ticket classes to allow registrations for this event</p>
            </div>
        ) : (
          <div className="space-y-3">
            {ticketClasses.map((ticket, idx) => (
              <div key={ticket._localId} className="border border-slate-200 rounded-lg overflow-hidden">
                  <div
                    className="flex items-center justify-between p-4 bg-slate-50 cursor-pointer"
                    onClick={() => toggleExpandTicket(ticket._localId)}
                    data-testid={`ticket-header-${ticket._localId}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-100 text-blue-600 font-medium text-sm">
                        {idx + 1}
                      </div>
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-slate-900">
                            {ticket.name || "Unnamed Ticket"}
                          </span>
                          {ticket.visibility_mode === 'members_and_public' && (
                            <Badge variant="outline" className="text-xs bg-green-50 text-green-700 border-green-200">
                              <Globe className="h-3 w-3 mr-1" />
                              Members & Public
                            </Badge>
                          )}
                          {ticket.visibility_mode === 'public_only' && (
                            <Badge variant="outline" className="text-xs bg-purple-50 text-purple-700 border-purple-200">
                              <Globe className="h-3 w-3 mr-1" />
                              Public Only
                            </Badge>
                          )}
                          {ticket.is_group_ticket && (
                            <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">
                              <Users className="h-3 w-3 mr-1" />
                              Group ({ticket.group_size || '?'})
                            </Badge>
                          )}
                          {ticket.early_bird_enabled && ticket.early_bird_price && (
                            <Badge variant="outline" className="text-xs bg-warning/10 text-warning border-warning/30">
                              <Bird className="h-3 w-3 mr-1" />
                              Early Bird £{ticket.early_bird_price}
                            </Badge>
                          )}
                          {!ticket.all_tracks && (ticket.linked_track_ids || []).length > 0 && (
                            <Badge variant="outline" className="text-xs">
                              {(ticket.linked_track_ids || []).length} track(s)
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-sm text-slate-500">
                          <span>£{ticket.price || "0.00"}</span>
                          <span className="text-slate-300">|</span>
                          <span className="flex items-center gap-1">
                            <Users className="h-3 w-3" />
                            {getRoleNames(ticket.role_ids)}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={idx === 0}
                        onClick={(e) => { e.stopPropagation(); moveTicketClass(ticket._localId, 'up'); }}
                        data-testid={`button-move-up-ticket-${ticket._localId}`}
                      >
                        <ChevronUp className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={idx === ticketClasses.length - 1}
                        onClick={(e) => { e.stopPropagation(); moveTicketClass(ticket._localId, 'down'); }}
                        data-testid={`button-move-down-ticket-${ticket._localId}`}
                      >
                        <ChevronDown className="w-4 h-4" />
                      </Button>
                      {ticketClasses.length > 1 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={(e) => { e.stopPropagation(); removeTicketClass(ticket._localId); }}
                          className="text-slate-400 hover:text-red-500"
                          data-testid={`button-remove-ticket-${ticket._localId}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                      {expandedTickets[ticket._localId] ? (
                        <ChevronUp className="h-5 w-5 text-slate-400" />
                      ) : (
                        <ChevronDown className="h-5 w-5 text-slate-400" />
                      )}
                    </div>
                  </div>

                  {expandedTickets[ticket._localId] && (
                    <div className="p-4 space-y-4 border-t border-slate-200">
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="space-y-2 md:col-span-2">
                          <Label htmlFor={`ticket-name-${ticket._localId}`}>Ticket Name *</Label>
                          <Input
                            id={`ticket-name-${ticket._localId}`}
                            value={ticket.name}
                            onChange={(e) => updateTicketClass(ticket._localId, 'name', e.target.value)}
                            placeholder="e.g. Standard, VIP, Student"
                            data-testid={`input-ticket-name-${ticket._localId}`}
                          />
                        </div>
                        {isGroupLimited ? (
                          <div className="space-y-2">
                            <Label>Price</Label>
                            <div className="flex items-center h-9">
                              <Badge variant="secondary" data-testid={`badge-free-ticket-${ticket._localId}`}>Free ticket</Badge>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <Label htmlFor={`ticket-price-${ticket._localId}`}>Price (£) *</Label>
                            <div className="flex items-center gap-3">
                              <div className="relative w-28">
                                <PoundSterling className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                                <Input
                                  id={`ticket-price-${ticket._localId}`}
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  value={ticket.is_free ? '0' : ticket.price}
                                  onChange={(e) => updateTicketClass(ticket._localId, 'price', e.target.value)}
                                  placeholder="0.00"
                                  className="pl-9"
                                  disabled={ticket.is_free}
                                  data-testid={`input-ticket-price-${ticket._localId}`}
                                />
                              </div>
                              <div className="flex items-center gap-2">
                                <Switch
                                  id={`ticket-free-${ticket._localId}`}
                                  checked={ticket.is_free || false}
                                  onCheckedChange={(val) => setTicketFree(ticket._localId, val)}
                                  data-testid={`switch-free-${ticket._localId}`}
                                />
                                <Label htmlFor={`ticket-free-${ticket._localId}`} className="text-sm font-medium">Free</Label>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="border rounded-md p-3 space-y-3">
                        <h5 className="font-medium text-sm text-slate-700">Track Access</h5>
                        <div className="flex items-center gap-1.5">
                          <Switch
                            checked={ticket.all_tracks}
                            onCheckedChange={(val) => {
                              updateTicketClass(ticket._localId, 'all_tracks', val);
                              if (val) updateTicketClass(ticket._localId, 'linked_track_ids', []);
                            }}
                            data-testid={`switch-all-tracks-${ticket._localId}`}
                          />
                          <Label className="text-sm">Access to all tracks</Label>
                        </div>
                        {!ticket.all_tracks && (
                          <div className="space-y-1.5">
                            {tracks.length === 0 ? (
                              <p className="text-sm text-slate-400">No tracks created yet. Add tracks in the Tracks tab.</p>
                            ) : (
                              tracks.map((track) => (
                                <div
                                  key={track._localId}
                                  className="flex items-center gap-2 p-1.5 cursor-pointer hover-elevate rounded"
                                  onClick={() => toggleTrackForTicket(ticket._localId, track.id || track._localId)}
                                >
                                  <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                                    (ticket.linked_track_ids || []).includes(track.id || track._localId) ? 'bg-blue-500 border-blue-500' : 'border-slate-300'
                                  }`}>
                                    {(ticket.linked_track_ids || []).includes(track.id || track._localId) && (
                                      <Check className="w-3 h-3 text-white" />
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2">
                                    {track.colour && (
                                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: track.colour }} />
                                    )}
                                    <span className="text-sm">{track.name || 'Untitled Track'}</span>
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>

                      {!ticket.is_free && !isGroupLimited && (
                        <div className="space-y-3">
                          <div className="flex items-center gap-2">
                            <Switch
                              id={`ticket-early-bird-${ticket._localId}`}
                              checked={ticket.early_bird_enabled || false}
                              onCheckedChange={(val) => {
                                updateTicketClass(ticket._localId, 'early_bird_enabled', val);
                                if (!val) {
                                  updateTicketClass(ticket._localId, 'early_bird_price', '');
                                  updateTicketClass(ticket._localId, 'early_bird_deadline', '');
                                }
                              }}
                              data-testid={`switch-early-bird-${ticket._localId}`}
                            />
                            <Label htmlFor={`ticket-early-bird-${ticket._localId}`} className="text-sm font-medium flex items-center gap-1.5">
                              <Bird className="h-4 w-4 text-warning" />
                              Early Bird Pricing
                            </Label>
                          </div>
                          {ticket.early_bird_enabled && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-2 border-l-2 border-warning/30 ml-1">
                              <div className="space-y-1.5">
                                <Label htmlFor={`ticket-early-bird-price-${ticket._localId}`} className="text-sm">
                                  Early Bird Price (£) *
                                </Label>
                                <div className="relative w-28">
                                  <PoundSterling className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                                  <Input
                                    id={`ticket-early-bird-price-${ticket._localId}`}
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={ticket.early_bird_price || ''}
                                    onChange={(e) => updateTicketClass(ticket._localId, 'early_bird_price', e.target.value)}
                                    placeholder="0.00"
                                    className="pl-9"
                                    data-testid={`input-early-bird-price-${ticket._localId}`}
                                  />
                                </div>
                                {ticket.early_bird_price && ticket.price && Number(ticket.early_bird_price) >= Number(ticket.price) && (
                                  <p className="text-xs text-red-500">Must be less than standard price (£{ticket.price})</p>
                                )}
                              </div>
                              <div className="space-y-1.5">
                                <Label htmlFor={`ticket-early-bird-deadline-${ticket._localId}`} className="text-sm">
                                  Deadline *
                                </Label>
                                <Input
                                  id={`ticket-early-bird-deadline-${ticket._localId}`}
                                  type="datetime-local"
                                  value={ticket.early_bird_deadline ? ticket.early_bird_deadline.slice(0, 16) : ''}
                                  onChange={(e) => updateTicketClass(ticket._localId, 'early_bird_deadline', e.target.value || '')}
                                  data-testid={`input-early-bird-deadline-${ticket._localId}`}
                                />
                                <p className="text-xs text-slate-500">Price reverts to standard after this date/time</p>
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="space-y-2">
                        <Label className="flex items-center gap-2">
                          <Ticket className="h-4 w-4 text-slate-500" />
                          Ticket Availability
                        </Label>
                        <p className="text-xs text-slate-500 mb-2">
                          Set how many of this ticket type are available. This is independent of event seat capacity.
                        </p>
                        <div className="flex items-center gap-4">
                          <div className="flex items-center gap-2">
                            <Switch
                              id={`ticket-unlimited-${ticket._localId}`}
                              checked={ticket.is_unlimited_tickets !== false}
                              onCheckedChange={(val) => {
                                updateTicketClass(ticket._localId, 'is_unlimited_tickets', val);
                                if (val) updateTicketClass(ticket._localId, 'available_count', '');
                              }}
                              data-testid={`switch-unlimited-${ticket._localId}`}
                            />
                            <Label htmlFor={`ticket-unlimited-${ticket._localId}`} className="text-sm font-medium">Unlimited</Label>
                          </div>
                          {ticket.is_unlimited_tickets === false && (
                            <div className="flex items-center gap-2">
                              <Input
                                id={`ticket-available-count-${ticket._localId}`}
                                type="number"
                                min="1"
                                value={ticket.available_count || ""}
                                onChange={(e) => updateTicketClass(ticket._localId, 'available_count', e.target.value)}
                                placeholder="e.g. 50"
                                className="w-24"
                                data-testid={`input-ticket-count-${ticket._localId}`}
                              />
                              <span className="text-sm text-slate-500">tickets</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {!isGroupLimited && (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2">
                          <Switch
                            id={`ticket-group-${ticket._localId}`}
                            checked={ticket.is_group_ticket || false}
                            onCheckedChange={(val) => updateTicketClass(ticket._localId, 'is_group_ticket', val)}
                            data-testid={`switch-group-${ticket._localId}`}
                          />
                          <Label htmlFor={`ticket-group-${ticket._localId}`} className="text-sm font-medium flex items-center gap-1.5">
                            <Users className="h-4 w-4 text-slate-500" />
                            Group Ticket
                          </Label>
                        </div>
                        <p className="text-xs text-slate-500">
                          A group ticket covers multiple participants. The booker receives a link to add people by email.
                        </p>
                        {ticket.is_group_ticket && (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-2 border-l-2 border-blue-200 ml-1">
                            <div className="space-y-1.5">
                              <Label htmlFor={`ticket-group-size-${ticket._localId}`} className="text-sm">
                                Group Size (max participants) *
                              </Label>
                              <Input
                                id={`ticket-group-size-${ticket._localId}`}
                                type="number"
                                min="2"
                                value={ticket.group_size || ""}
                                onChange={(e) => updateTicketClass(ticket._localId, 'group_size', e.target.value)}
                                placeholder="e.g. 10"
                                className="w-28"
                                data-testid={`input-group-size-${ticket._localId}`}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label htmlFor={`ticket-group-cutoff-${ticket._localId}`} className="text-sm">
                                Cut-off Date/Time
                              </Label>
                              <Input
                                id={`ticket-group-cutoff-${ticket._localId}`}
                                type="datetime-local"
                                value={ticket.group_cutoff_date || ""}
                                onChange={(e) => updateTicketClass(ticket._localId, 'group_cutoff_date', e.target.value)}
                                data-testid={`input-group-cutoff-${ticket._localId}`}
                              />
                              <p className="text-xs text-slate-400">
                                After this time, no more changes to the group can be made.
                              </p>
                            </div>
                          </div>
                        )}
                      </div>
                      )}

                      <div className="space-y-2">
                        <Label className="flex items-center gap-2">
                          <Users className="h-4 w-4 text-slate-500" />
                          Available to Roles
                        </Label>
                        <p className="text-xs text-slate-500 mb-2">
                          Select which roles can purchase this ticket. Leave empty for all roles.
                        </p>
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline"
                              className="w-full justify-between gap-2"
                              data-testid={`button-roles-${ticket._localId}`}
                            >
                              <div className="flex items-center gap-2">
                                <Users className="w-4 h-4" />
                                {(ticket.role_ids || []).length === 0 ? (
                                  <span className="text-green-600 font-medium">All Roles</span>
                                ) : (ticket.role_ids || []).length === 1 ? (
                                  <span className="truncate max-w-[200px]">
                                    {roles.find(r => r.id === ticket.role_ids[0])?.name || 'Unknown'}
                                  </span>
                                ) : (
                                  <span>{(ticket.role_ids || []).length} roles selected</span>
                                )}
                              </div>
                              <div className="flex items-center gap-1">
                                {(ticket.role_ids || []).length > 0 && (
                                  <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                                    {(ticket.role_ids || []).length}
                                  </Badge>
                                )}
                                <ChevronDown className="w-4 h-4 opacity-50" />
                              </div>
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-64 p-0" align="start">
                            <div className="p-2 border-b border-slate-100">
                              <div className="flex items-center justify-between">
                                <span className="text-sm font-medium text-slate-700">Select roles</span>
                                {(ticket.role_ids || []).length > 0 && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 text-xs text-slate-500 hover:text-slate-700"
                                    onClick={() => updateTicketClass(ticket._localId, 'role_ids', [])}
                                    data-testid={`role-clear-${ticket._localId}`}
                                  >
                                    Clear all
                                  </Button>
                                )}
                              </div>
                            </div>
                            <div className="max-h-[280px] overflow-y-auto p-1">
                              {roles.map(role => {
                                const isSelected = (ticket.role_ids || []).includes(role.id);
                                return (
                                  <button
                                    key={role.id}
                                    className={`w-full flex items-center gap-2 px-2 py-2 text-sm rounded-md transition-colors ${
                                      isSelected
                                        ? "bg-slate-100 text-slate-900 font-medium"
                                        : "text-slate-600 hover:bg-slate-50"
                                    }`}
                                    onClick={() => toggleRoleForTicket(ticket._localId, role.id)}
                                    data-testid={`role-toggle-${ticket._localId}-${role.id}`}
                                  >
                                    <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                                      isSelected ? "bg-primary border-primary" : "border-slate-300"
                                    }`}>
                                      {isSelected && <Check className="w-3 h-3 text-white" />}
                                    </div>
                                    <span className="truncate">{role.name}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </PopoverContent>
                        </Popover>

                        {(ticket.role_ids || []).length === 0 && (
                          <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded text-sm text-green-700">
                            This ticket is available to all roles
                          </div>
                        )}

                        {(ticket.role_ids || []).length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {(ticket.role_ids || []).map(roleId => {
                              const role = roles.find(r => r.id === roleId);
                              return role ? (
                                <Badge
                                  key={roleId}
                                  variant="secondary"
                                  className="text-xs"
                                >
                                  {role.name}
                                  <button
                                    type="button"
                                    className="ml-1 hover:text-slate-900"
                                    onClick={() => toggleRoleForTicket(ticket._localId, roleId)}
                                  >
                                    <X className="h-3 w-3" />
                                  </button>
                                </Badge>
                              ) : null;
                            })}
                          </div>
                        )}

                      </div>

                      {/* Member Group Assignment */}
                      <div className="space-y-2">
                        <Label className="flex items-center gap-2">
                          <Users className="h-4 w-4 text-slate-500" />
                          Available to {memberGroupFeatureName}
                        </Label>
                        <p className="text-xs text-slate-500 mb-2">
                          Select which member groups can purchase this ticket. Combined with roles using OR logic. Leave empty for no group restriction.
                        </p>

                        {loadingMemberGroups ? (
                          <div className="text-sm text-slate-500">Loading member groups...</div>
                        ) : memberGroups.length === 0 ? (
                          <div className="p-2 bg-slate-50 border border-slate-200 rounded text-sm text-slate-500">
                            No member groups defined yet
                          </div>
                        ) : (
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                variant="outline"
                                className="w-full justify-between gap-2"
                                data-testid={`group-selector-trigger-${ticket._localId}`}
                              >
                                <div className="flex items-center gap-2">
                                  <Users className="w-4 h-4" />
                                  {(ticket.member_group_ids || []).length === 0 ? (
                                    <span className="text-slate-500">No group restriction</span>
                                  ) : (ticket.member_group_ids || []).length === 1 ? (
                                    <span className="truncate max-w-[200px]">
                                      {memberGroups.find(g => g.id === ticket.member_group_ids[0])?.name || 'Unknown'}
                                    </span>
                                  ) : (
                                    <span>{(ticket.member_group_ids || []).length} groups selected</span>
                                  )}
                                </div>
                                <div className="flex items-center gap-1">
                                  {(ticket.member_group_ids || []).length > 0 && (
                                    <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                                      {(ticket.member_group_ids || []).length}
                                    </Badge>
                                  )}
                                  <ChevronDown className="w-4 h-4 opacity-50" />
                                </div>
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-64 p-0" align="start">
                              <div className="p-2 border-b border-slate-100">
                                <div className="flex items-center justify-between">
                                  <span className="text-sm font-medium text-slate-700">Select member groups</span>
                                  {(ticket.member_group_ids || []).length > 0 && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 text-xs text-slate-500 hover:text-slate-700"
                                      onClick={() => updateTicketClass(ticket._localId, 'member_group_ids', [])}
                                      data-testid={`group-clear-${ticket._localId}`}
                                    >
                                      Clear all
                                    </Button>
                                  )}
                                </div>
                              </div>
                              <div className="max-h-[280px] overflow-y-auto p-1">
                                {memberGroups.map(group => {
                                  const isSelected = (ticket.member_group_ids || []).includes(group.id);
                                  return (
                                    <button
                                      key={group.id}
                                      type="button"
                                      className={`w-full flex items-center gap-2 px-2 py-2 text-sm rounded-md transition-colors ${
                                        isSelected
                                          ? "bg-slate-100 text-slate-900 font-medium"
                                          : "text-slate-600 hover:bg-slate-50"
                                      }`}
                                      onClick={() => toggleMemberGroupForTicket(ticket._localId, group.id)}
                                      data-testid={`group-toggle-${ticket._localId}-${group.id}`}
                                    >
                                      <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                                        isSelected ? "bg-primary border-primary" : "border-slate-300"
                                      }`}>
                                        {isSelected && <Check className="w-3 h-3 text-white" />}
                                      </div>
                                      <span className="truncate">{group.name}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            </PopoverContent>
                          </Popover>
                        )}

                        {(ticket.member_group_ids || []).length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {(ticket.member_group_ids || []).map(groupId => {
                              const group = memberGroups.find(g => g.id === groupId);
                              return group ? (
                                <Badge
                                  key={groupId}
                                  variant="secondary"
                                  className="text-xs"
                                >
                                  {group.name}
                                  <button
                                    type="button"
                                    className="ml-1 hover:text-slate-900"
                                    onClick={() => toggleMemberGroupForTicket(ticket._localId, groupId)}
                                  >
                                    <X className="h-3 w-3" />
                                  </button>
                                </Badge>
                              ) : null;
                            })}
                          </div>
                        )}

                        {/* Restrict-mode toggle: shown when roles OR groups selected AND visibility includes members */}
                        {((ticket.role_ids || []).length > 0 || (ticket.member_group_ids || []).length > 0) && ticket.visibility_mode !== 'public_only' && (
                          <div className="mt-3 flex items-center justify-between p-3 bg-warning/10 border border-warning/30 rounded-lg">
                            <div className="flex items-center gap-2">
                              <Users className="h-4 w-4 text-warning" />
                              <div>
                                <Label htmlFor={`role-match-only-${ticket._localId}`} className="text-sm font-medium text-warning">
                                  Restrict to selected roles / groups
                                </Label>
                                <p className="text-xs text-warning">
                                  {ticket.role_match_only
                                    ? "Ticket is hidden from users whose role and member groups don't match"
                                    : "Ticket is visible to all users (selection only affects who can register)"}
                                </p>
                              </div>
                            </div>
                            <Switch
                              id={`role-match-only-${ticket._localId}`}
                              checked={ticket.role_match_only || false}
                              onCheckedChange={(val) => updateTicketClass(ticket._localId, 'role_match_only', val)}
                              data-testid={`switch-role-match-${ticket._localId}`}
                            />
                          </div>
                        )}
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center gap-2">
                          <Globe className="h-5 w-5 text-blue-600" />
                          <Label className="text-base font-medium">Ticket Visibility</Label>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                          <div
                            className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                              (ticket.visibility_mode || 'members_only') === 'members_only'
                                ? 'border-blue-500 bg-blue-50'
                                : 'border-slate-200 hover:bg-slate-50'
                            }`}
                            onClick={() => updateTicketClass(ticket._localId, 'visibility_mode', 'members_only')}
                            data-testid={`visibility-members-only-${ticket._localId}`}
                          >
                            <div className={`h-4 w-4 rounded-full border-2 flex items-center justify-center ${
                              (ticket.visibility_mode || 'members_only') === 'members_only' ? 'border-blue-500' : 'border-slate-300'
                            }`}>
                              {(ticket.visibility_mode || 'members_only') === 'members_only' && (
                                <div className="h-2 w-2 rounded-full bg-blue-500" />
                              )}
                            </div>
                            <div>
                              <p className="text-sm font-medium">Members Only</p>
                              <p className="text-xs text-slate-500">Logged-in members only</p>
                            </div>
                          </div>
                          <div
                            className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                              ticket.visibility_mode === 'members_and_public'
                                ? 'border-blue-500 bg-blue-50'
                                : 'border-slate-200 hover:bg-slate-50'
                            }`}
                            onClick={() => updateTicketClass(ticket._localId, 'visibility_mode', 'members_and_public')}
                            data-testid={`visibility-members-and-public-${ticket._localId}`}
                          >
                            <div className={`h-4 w-4 rounded-full border-2 flex items-center justify-center ${
                              ticket.visibility_mode === 'members_and_public' ? 'border-blue-500' : 'border-slate-300'
                            }`}>
                              {ticket.visibility_mode === 'members_and_public' && (
                                <div className="h-2 w-2 rounded-full bg-blue-500" />
                              )}
                            </div>
                            <div>
                              <p className="text-sm font-medium">Members & Public</p>
                              <p className="text-xs text-slate-500">Both members and visitors</p>
                            </div>
                          </div>
                          <div
                            className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                              ticket.visibility_mode === 'public_only'
                                ? 'border-blue-500 bg-blue-50'
                                : 'border-slate-200 hover:bg-slate-50'
                            }`}
                            onClick={() => updateTicketClass(ticket._localId, 'visibility_mode', 'public_only')}
                            data-testid={`visibility-public-only-${ticket._localId}`}
                          >
                            <div className={`h-4 w-4 rounded-full border-2 flex items-center justify-center ${
                              ticket.visibility_mode === 'public_only' ? 'border-blue-500' : 'border-slate-300'
                            }`}>
                              {ticket.visibility_mode === 'public_only' && (
                                <div className="h-2 w-2 rounded-full bg-blue-500" />
                              )}
                            </div>
                            <div>
                              <p className="text-sm font-medium">Public Only</p>
                              <p className="text-xs text-slate-500">Non-logged in visitors only</p>
                            </div>
                          </div>
                        </div>
                      </div>

                      {availableVatRates.length > 0 && !isGroupLimited && (
                        <div className="space-y-1.5">
                          <Label>VAT Rate</Label>
                          <Select
                            value={ticket.vat_rate_key || '_none'}
                            onValueChange={(val) => {
                              if (val === '_none') {
                                updateTicketClass(ticket._localId, 'vat_rate_key', null);
                                updateTicketClass(ticket._localId, 'vat_rate_label', null);
                                updateTicketClass(ticket._localId, 'vat_rate_percentage', null);
                              } else {
                                const rate = availableVatRates.find(r => r.taxType === val);
                                if (rate) {
                                  updateTicketClass(ticket._localId, 'vat_rate_key', rate.taxType);
                                  updateTicketClass(ticket._localId, 'vat_rate_label', rate.name);
                                  updateTicketClass(ticket._localId, 'vat_rate_percentage', rate.effectiveRate);
                                }
                              }
                            }}
                          >
                            <SelectTrigger data-testid={`select-vat-${ticket._localId}`}>
                              <SelectValue placeholder="No VAT" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="_none">No VAT</SelectItem>
                              {availableVatRates.map((rate) => (
                                <SelectItem key={rate.taxType} value={rate.taxType}>
                                  {rate.name} ({rate.effectiveRate}%)
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {!isGroupLimited && (
                      <>
                      <Separator />

                      <div className="space-y-4">
                        <Label className="text-sm font-medium text-slate-700">Special Offer</Label>
                        <RadioGroup
                          value={ticket.offer_type}
                          onValueChange={(val) => updateTicketClass(ticket._localId, 'offer_type', val)}
                          className="grid grid-cols-1 md:grid-cols-3 gap-2"
                        >
                          <Label
                            htmlFor={`offer-none-${ticket._localId}`}
                            className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                              ticket.offer_type === 'none'
                                ? 'border-blue-500 bg-blue-50'
                                : 'border-slate-200 hover:bg-slate-50'
                            }`}
                          >
                            <RadioGroupItem value="none" id={`offer-none-${ticket._localId}`} />
                            <span className="text-sm">No Offer</span>
                          </Label>
                          <Label
                            htmlFor={`offer-bogo-${ticket._localId}`}
                            className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                              ticket.offer_type === 'bogo'
                                ? 'border-blue-500 bg-blue-50'
                                : 'border-slate-200 hover:bg-slate-50'
                            }`}
                          >
                            <RadioGroupItem value="bogo" id={`offer-bogo-${ticket._localId}`} />
                            <span className="text-sm">BOGO</span>
                          </Label>
                          <Label
                            htmlFor={`offer-bulk-${ticket._localId}`}
                            className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                              ticket.offer_type === 'bulk_discount'
                                ? 'border-blue-500 bg-blue-50'
                                : 'border-slate-200 hover:bg-slate-50'
                            }`}
                          >
                            <RadioGroupItem value="bulk_discount" id={`offer-bulk-${ticket._localId}`} />
                            <span className="text-sm">Bulk Discount</span>
                          </Label>
                        </RadioGroup>

                        {ticket.offer_type === 'bogo' && (
                          <div className="space-y-3 mt-2 p-3 bg-slate-50 rounded-md">
                            <RadioGroup
                              value={ticket.bogo_logic_type}
                              onValueChange={(value) => updateTicketClass(ticket._localId, 'bogo_logic_type', value)}
                            >
                              <div className="space-y-2">
                                <div className="flex items-center gap-2">
                                  <RadioGroupItem value="buy_x_get_y_free" id={`bogo-logic-1-${ticket._localId}`} />
                                  <Label htmlFor={`bogo-logic-1-${ticket._localId}`} className="text-sm cursor-pointer">
                                    Buy X, Get Y Free
                                  </Label>
                                </div>
                                <div className="flex items-center gap-2">
                                  <RadioGroupItem value="enter_total_pay_less" id={`bogo-logic-2-${ticket._localId}`} />
                                  <Label htmlFor={`bogo-logic-2-${ticket._localId}`} className="text-sm cursor-pointer">
                                    Enter Total, Pay Less
                                  </Label>
                                </div>
                              </div>
                            </RadioGroup>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div className="space-y-1.5">
                                <Label className="text-sm">Buy Quantity</Label>
                                <Input
                                  type="number"
                                  min="1"
                                  value={ticket.bogo_buy_quantity}
                                  onChange={(e) => updateTicketClass(ticket._localId, 'bogo_buy_quantity', e.target.value)}
                                  data-testid={`input-bogo-buy-${ticket._localId}`}
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-sm">Get Free Quantity</Label>
                                <Input
                                  type="number"
                                  min="1"
                                  value={ticket.bogo_get_free_quantity}
                                  onChange={(e) => updateTicketClass(ticket._localId, 'bogo_get_free_quantity', e.target.value)}
                                  data-testid={`input-bogo-free-${ticket._localId}`}
                                />
                              </div>
                            </div>
                          </div>
                        )}

                        {ticket.offer_type === 'bulk_discount' && (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
                            <div className="space-y-1.5">
                              <Label className="text-sm">Minimum Quantity</Label>
                              <Input
                                type="number"
                                min="2"
                                value={ticket.bulk_discount_threshold}
                                onChange={(e) => updateTicketClass(ticket._localId, 'bulk_discount_threshold', e.target.value)}
                                data-testid={`input-bulk-threshold-${ticket._localId}`}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-sm">Discount %</Label>
                              <Input
                                type="number"
                                min="1"
                                max="100"
                                value={ticket.bulk_discount_percentage}
                                onChange={(e) => updateTicketClass(ticket._localId, 'bulk_discount_percentage', e.target.value)}
                                data-testid={`input-bulk-percentage-${ticket._localId}`}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                      </>
                      )}
                    </div>
                  )}
              </div>
            ))}
          </div>
        )}
          </CardContent>
        </Card>
        </TabsContent>

        <TabsContent value="emails">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Mail className="h-5 w-5 text-blue-600" />
                    Email Configuration
                  </CardTitle>
                  <CardDescription>
                    Configure confirmation and reminder emails for this event. Reminders are scheduled relative to each session's start time.
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => addEventEmail('booking_confirmation')}
                    data-testid="button-add-confirmation-email"
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Confirmation
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => addEventEmail('reminder')}
                    data-testid="button-add-reminder-email"
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Reminder
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {!isEditMode && eventEmails.length > 0 && (
                <div className="flex items-start gap-2 p-3 rounded-md border border-blue-200 bg-blue-50 text-blue-800 text-sm" data-testid="note-emails-saved-on-create">
                  <Mail className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>These email settings will be saved when you create the event.</span>
                </div>
              )}
              <EventEmailSettingsEditor
                emails={eventEmails}
                setEmails={setEventEmails}
                emailTemplates={emailTemplates}
                saveErrors={emailSaveErrors}
                onRowEdited={handleEmailRowEdited}
                eventTimezone={formData.timezone || DEFAULT_TIMEZONE}
                loading={isEditMode && loadingEmails}
                mode="session"
              />
              {isEditMode && !loadingEmails && eventEmails.length > 0 && (
                <div className="flex flex-wrap justify-end gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={requeueReminders}
                    disabled={isRequeueingEmails || isSavingEmails}
                    data-testid="button-requeue-reminders"
                  >
                    {isRequeueingEmails ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Re-queueing...
                      </>
                    ) : (
                      <>Re-queue reminders</>
                    )}
                  </Button>
                  <Button
                    type="button"
                    onClick={saveEventEmails}
                    disabled={isSavingEmails}
                    className="bg-blue-600 hover:bg-blue-700"
                    data-testid="button-save-emails"
                  >
                    {isSavingEmails ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Saving Emails...
                      </>
                    ) : (
                      <>
                        <Save className="h-4 w-4 mr-2" />
                        Save Email Settings
                      </>
                    )}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {isEditMode && (
          <TabsContent value="surveys">
            <Card>
              <CardHeader>
                <CardTitle>Surveys</CardTitle>
                <CardDescription>
                  Attach surveys to this event so attendees can give feedback. Set optional open/close windows and control who can respond.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <EventSurveysSection eventId={editId} eventType="complex_event" />
              </CardContent>
            </Card>
          </TabsContent>
        )}

        </Tabs>

      <Dialog open={sessionDialogOpen} onOpenChange={() => closeSessionDialog()}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col gap-0 p-0">
          <DialogHeader className="p-6 pb-4 shrink-0">
            <DialogTitle>{editingSession ? "Edit Session" : "Add Session"}</DialogTitle>
            <DialogDescription>
              {editingSession ? "Update the session details below." : "Fill in the session details below."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto px-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Title *</Label>
              <Input
                value={sessionForm.title}
                onChange={(e) =>
                  setSessionForm((prev) => ({ ...prev, title: e.target.value }))
                }
                placeholder="Session title"
                data-testid="input-session-title"
              />
            </div>

            <div className="space-y-2">
              <Label>Tracks</Label>
              {tracks.length === 0 ? (
                <p className="text-sm text-slate-400">No tracks created yet. Add tracks first.</p>
              ) : (
                <div className="space-y-1.5">
                  {tracks.map((track) => {
                    const trackRef = track.id || track._localId;
                    const isSelected = (sessionForm.track_ids || []).includes(trackRef);
                    return (
                      <div
                        key={track._localId}
                        className="flex items-center gap-2 p-2 cursor-pointer hover-elevate rounded-md"
                        onClick={() => toggleTrackForSession(trackRef)}
                        data-testid={`session-track-toggle-${track._localId}`}
                      >
                        <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                          isSelected ? 'bg-blue-500 border-blue-500' : 'border-slate-300'
                        }`}>
                          {isSelected && <Check className="w-3 h-3 text-white" />}
                        </div>
                        <div className="flex items-center gap-2">
                          <div
                            className="w-3 h-3 rounded-full"
                            style={{ backgroundColor: track.colour || "#94a3b8" }}
                          />
                          <span className="text-sm">{track.name || "Untitled Track"}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>Description</Label>
              <ReactQuill
                theme="snow"
                value={sessionForm.description}
                onChange={(val) =>
                  setSessionForm((prev) => ({ ...prev, description: val }))
                }
                modules={QUILL_MODULES}
                formats={QUILL_FORMATS}
              />
            </div>

            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Start Time</Label>
                  <Input
                    type="datetime-local"
                    value={sessionForm.start_time}
                    onChange={(e) => {
                      const newStartTime = e.target.value;
                      setSessionForm((prev) => {
                        const updated = { ...prev, start_time: newStartTime };
                        if (sessionDuration !== "custom" && newStartTime) {
                          updated.end_time = computeEndTimeFromDuration(newStartTime, sessionDuration);
                        }
                        return updated;
                      });
                    }}
                    data-testid="input-session-start-time"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Duration</Label>
                  <Select
                    value={sessionDuration}
                    onValueChange={(val) => {
                      setSessionDuration(val);
                      if (val !== "custom" && sessionForm.start_time) {
                        setSessionForm((prev) => ({
                          ...prev,
                          end_time: computeEndTimeFromDuration(prev.start_time, val),
                        }));
                      }
                    }}
                  >
                    <SelectTrigger data-testid="select-session-duration">
                      <SelectValue placeholder="Select duration" />
                    </SelectTrigger>
                    <SelectContent>
                      {DURATION_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value} data-testid={`duration-option-${opt.value}`}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {sessionDuration === "custom" && (
                <div className="space-y-2">
                  <Label>End Time</Label>
                  <Input
                    type="datetime-local"
                    value={sessionForm.end_time}
                    onChange={(e) =>
                      setSessionForm((prev) => ({ ...prev, end_time: e.target.value }))
                    }
                    data-testid="input-session-end-time"
                  />
                </div>
              )}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>{isGroupLimited && sessionForm.is_online ? "Meeting link / Location" : "Location"}</Label>
                <Input
                  value={sessionForm.location}
                  onChange={(e) =>
                    setSessionForm((prev) => ({ ...prev, location: e.target.value }))
                  }
                  placeholder={isGroupLimited && sessionForm.is_online ? "Paste your meeting link" : 'Physical address or "virtual"'}
                  data-testid="input-session-location"
                />
                {isGroupLimited && sessionForm.is_online && (
                  <p className="text-xs text-slate-500">Group events use a manual meeting link — Zoom is not available.</p>
                )}
              </div>
              <div className="space-y-2">
                <Label>Delivery Mode</Label>
                <div className="flex items-center gap-3 pt-2">
                  <Switch
                    checked={sessionForm.is_online}
                    onCheckedChange={(checked) =>
                      setSessionForm((prev) => ({ ...prev, is_online: checked }))
                    }
                    data-testid="switch-session-is-online"
                  />
                  <span className="text-sm text-slate-600">
                    {sessionForm.is_online ? "Virtual / Online" : "In-person"}
                  </span>
                </div>
              </div>
            </div>

            {!isGroupLimited && (() => {
              // task-692: always show the session Zoom panel for saved
              // sessions (regardless of is_online) so admins can attach a
              // Zoom link from any session that is being edited.
              const savedSession = sessions.find((s) => s._localId === editingSession);
              const savedSessionId = savedSession?.id || null;
              const hasZoom = !!(sessionForm.zoom_meeting_id || sessionForm.zoom_webinar_id);
              if (!savedSessionId) return null;
              return (
                <div className="mb-3 p-3 bg-blue-50 border border-blue-200 rounded-lg" data-testid="panel-session-zoom-link-admin">
                  <div className="flex items-center gap-2 mb-2">
                    <Globe className="h-4 w-4 text-blue-600" />
                    <span className="font-medium text-blue-900 text-sm">Session Zoom Link</span>
                  </div>
                  <p className="text-xs text-blue-800 mb-3">
                    {hasZoom
                      ? `Linked to a Zoom ${sessionForm.zoom_meeting_id ? 'meeting' : 'webinar'}. Use Change/Detach to safely re-route confirmed registrants.`
                      : 'No Zoom link attached. Confirmed attendees will not receive a join URL until you attach one.'}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {!hasZoom ? (
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        onClick={() => setSessionZoomDialog({ open: true, mode: 'attach', sessionId: savedSessionId })}
                        data-testid={`button-attach-session-zoom-${savedSessionId}`}
                      >
                        <Video className="h-4 w-4 mr-2" />
                        Attach Zoom Link
                      </Button>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setSessionZoomDialog({ open: true, mode: 'change', sessionId: savedSessionId })}
                          data-testid={`button-change-session-zoom-${savedSessionId}`}
                        >
                          <Video className="h-4 w-4 mr-2" />
                          Change Zoom Link
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setSessionZoomDialog({ open: true, mode: 'detach', sessionId: savedSessionId })}
                          data-testid={`button-detach-session-zoom-${savedSessionId}`}
                        >
                          <X className="h-4 w-4 mr-2" />
                          Detach Zoom Link
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })()}

            {sessionForm.is_online && !isGroupLimited && (
              <ZoomSessionConfig
                zoomType={sessionForm.zoom_type}
                zoomHostId={sessionForm.zoom_host_id}
                zoomHostEmail={sessionForm.zoom_host_email}
                zoomRegistrationRequired={sessionForm.zoom_registration_required}
                zoomLinkMode={sessionForm.zoom_link_mode}
                autoCreateZoom={sessionForm.auto_create_zoom}
                linkExistingZoomId={sessionForm.link_existing_zoom_id}
                zoomMeetingId={sessionForm.zoom_meeting_id}
                zoomWebinarId={sessionForm.zoom_webinar_id}
                zoomJoinUrl={sessionForm.zoom_join_url}
                zoomUsers={zoomUsers}
                loadingZoomUsers={loadingZoomUsers}
                onUpdate={(updates) => setSessionForm(prev => ({ ...prev, ...updates }))}
              />
            )}

            {!isGroupLimited && (
            <div className="space-y-2">
              <Label>{speakerModuleName.plural}</Label>
              {selectedSessionSpeakers.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {selectedSessionSpeakers.map((speaker) => (
                    <Badge key={speaker.id} variant="secondary" className="gap-1.5">
                      {speaker.profile_photo_url ? (
                        <img src={speaker.profile_photo_url} alt="" className="w-5 h-5 rounded-full object-cover" />
                      ) : (
                        <Mic className="w-3.5 h-3.5" />
                      )}
                      {speaker.full_name}
                      <button
                        onClick={() =>
                          setSessionForm((prev) => ({
                            ...prev,
                            speaker_ids: prev.speaker_ids.filter((id) => id !== speaker.id),
                          }))
                        }
                        className="ml-0.5"
                        data-testid={`button-remove-session-speaker-${speaker.id}`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={() => setSessionSpeakerModalOpen(true)}
                data-testid="button-select-session-speakers"
              >
                <Mic className="w-4 h-4 mr-2" />
                Select {speakerModuleName.plural}
              </Button>
              <SpeakerSelectionModal
                open={sessionSpeakerModalOpen}
                onOpenChange={setSessionSpeakerModalOpen}
                speakers={speakers}
                selectedSpeakerIds={sessionForm.speaker_ids || []}
                onConfirm={(ids) =>
                  setSessionForm((prev) => ({ ...prev, speaker_ids: ids }))
                }
              />
            </div>
            )}

            <div className="space-y-3">
              <Label>Session Image</Label>
              <div className="flex items-center gap-3">
                <Switch
                  id="use-event-image"
                  checked={sessionForm.use_event_image}
                  onCheckedChange={(checked) =>
                    setSessionForm((prev) => ({
                      ...prev,
                      use_event_image: checked,
                      ...(checked ? { image_url: "", image_focal_point: null } : {}),
                    }))
                  }
                  data-testid="switch-use-event-image"
                />
                <Label htmlFor="use-event-image" className="cursor-pointer font-normal">
                  {sessionForm.use_event_image ? "Use event image" : "Use custom session image"}
                </Label>
              </div>

              {sessionForm.use_event_image ? (
                formData.image_url ? (
                  <div className="rounded-lg overflow-hidden border">
                    <img
                      src={formData.image_url}
                      alt="Event image preview"
                      className="w-full h-48 object-cover"
                      style={formData.image_focal_point ? { objectPosition: `${formData.image_focal_point.x}% ${formData.image_focal_point.y}%` } : undefined}
                      data-testid="img-session-event-preview"
                    />
                    <p className="text-xs text-muted-foreground px-3 py-2">
                      This session will use the event image
                    </p>
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-32 rounded-lg border border-dashed">
                    <p className="text-sm text-muted-foreground" data-testid="text-no-event-image">
                      No event image set yet
                    </p>
                  </div>
                )
              ) : (
                <div className="space-y-3">
                  <EventImageUpload
                    value={sessionForm.image_url}
                    onChange={(url) =>
                      setSessionForm((prev) => ({ ...prev, image_url: url }))
                    }
                    label=""
                    helpText="Upload a custom image for this session"
                  />
                  {sessionForm.image_url && (
                    <FocalPointPicker
                      imageUrl={sessionForm.image_url}
                      focalPoint={sessionForm.image_focal_point}
                      onChange={(point) =>
                        setSessionForm((prev) => ({ ...prev, image_focal_point: point }))
                      }
                    />
                  )}
                </div>
              )}
            </div>
          </div>

          {liveSessionClashes.length > 0 && (
            <div className="flex items-start gap-2 p-3 mt-4 mb-4 rounded-md bg-warning/10 dark:bg-warning/40 border border-warning/30 dark:border-warning" data-testid="session-clash-warning">
              <AlertTriangle className="w-4 h-4 text-warning dark:text-warning mt-0.5 shrink-0" />
              <div className="text-sm text-warning dark:text-warning">
                <p className="font-medium mb-1">Time clash detected</p>
                <ul className="list-disc pl-4 space-y-0.5">
                  {liveSessionClashes.map((clash, i) => (
                    <li key={i}>
                      "{clash.session}" on track{clash.tracks.length > 1 ? 's' : ''}: {clash.tracks.join(', ')}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          </div>

          <div className="flex justify-end gap-2 p-6 pt-4 border-t shrink-0">
            <Button variant="outline" onClick={closeSessionDialog} data-testid="button-cancel-session">
              Cancel
            </Button>
            <Button onClick={saveSession} data-testid="button-save-session">
              {editingSession ? "Update Session" : "Add Session"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* task-692: session change-zoom dialog. */}
      <ChangeZoomDialog
        open={sessionZoomDialog.open}
        onOpenChange={(open) => setSessionZoomDialog((s) => ({ ...s, open }))}
        endpointBase={sessionZoomDialog.sessionId ? `/api/complex-event-sessions/${sessionZoomDialog.sessionId}` : ''}
        mode={sessionZoomDialog.mode}
        targetLabel="session"
        initialType={sessionForm.zoom_meeting_id ? 'meeting' : 'webinar'}
        onSuccess={async () => {
          // task-692: refetch the mutated session and patch local state
          // (avoid a hard reload which would drop unsaved editor state).
          const sid = sessionZoomDialog.sessionId;
          setSessionZoomDialog({ open: false, mode: 'change', sessionId: null });
          if (!sid) return;
          try {
            const resp = await fetch(`/api/complex-event-sessions/${sid}`, { credentials: 'include' });
            if (resp.ok) {
              const fresh = await resp.json();
              setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, ...fresh } : s)));
              setSessionForm((prev) => {
                const stillEditingThis = sessions.find((s) => s._localId === editingSession)?.id === sid;
                if (!stillEditingThis) return prev;
                return {
                  ...prev,
                  zoom_meeting_id: fresh.zoom_meeting_id ?? null,
                  zoom_webinar_id: fresh.zoom_webinar_id ?? null,
                  zoom_join_url: fresh.zoom_join_url ?? null,
                  zoom_start_url: fresh.zoom_start_url ?? null,
                  zoom_registration_url: fresh.zoom_registration_url ?? null,
                  start_time: fresh.start_time ?? prev.start_time,
                  duration_minutes: fresh.duration_minutes ?? prev.duration_minutes,
                };
              });
            }
          } catch (err) {
            console.warn('[CreateComplexEvent] failed to refetch session after change-zoom', err);
          }
          queryClient.invalidateQueries({ queryKey: ["/api/complex-event-sessions", editId] });
        }}
      />
      </div>
      <EventClashWarningDialog
        open={clashDialog.open}
        clashes={clashDialog.clashes}
        redacted={clashDialog.redacted}
        clashCount={clashDialog.clashCount}
        onConfirm={handleClashConfirm}
        onCancel={handleClashCancel}
        isSaving={saving || checkingClashes}
      />
    </div>
  );
}
