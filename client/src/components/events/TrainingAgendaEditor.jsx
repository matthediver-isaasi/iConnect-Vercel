// Training-event agenda editor (Task #3419).
// Unlimited day/date-range lines, each with a type from the admin-managed
// 'event_agenda_item_types' setting and a type-conditional detail field:
//   In person  -> required location text
//   Online     -> existing Zoom/Teams webinar/meeting picker (future items only)
//   Self study -> external LMS URL
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, sortableKeyboardCoordinates, arrayMove, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, ArrowUp, ArrowDown, MapPin, Video, GraduationCap, Mic, X, GripVertical } from "lucide-react";
import { SpeakerSelectionModal } from "@/components/SpeakerSelectionModal";
import { inferAgendaTypeBehaviour } from "@/hooks/useAgendaItemTypes";
import EventSponsorSelector from "@/components/events/EventSponsorSelector";

async function fetchJson(url) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
  return response.json();
}

// Behaviour for a line's type (Task #3561): the configured type's explicit
// `behaviour` wins (the settings parser already infers one for legacy saved
// entries), so renamed types keep their behaviour. Name inference is only the
// fallback for types not found in settings (e.g. old agenda rows whose type
// was since deleted). Returns 'location' | 'zoom' | 'lms' | null (no field).
export function agendaTypeBehaviour(typeName, agendaItemTypes) {
  const n = String(typeName || '').trim().toLowerCase();
  if (!n) return null;
  const configured = (agendaItemTypes || []).find(
    (t) => String(t?.name || '').trim().toLowerCase() === n
  );
  if (configured && ['location', 'zoom', 'lms', 'none'].includes(configured.behaviour)) {
    return configured.behaviour === 'none' ? null : configured.behaviour;
  }
  const inferred = inferAgendaTypeBehaviour(typeName);
  return inferred === 'none' ? null : inferred;
}

// Normalise a stored/typed time to HH:MM ('09:00:00' -> '09:00'); '' when unset.
export function normalizeAgendaTime(value) {
  const m = String(value || '').match(/^(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}

// Combined start datetime for a line. Missing start time counts as 00:00.
export function agendaLineStartDateTime(line) {
  if (!line?.start_date) return null;
  return `${line.start_date}T${normalizeAgendaTime(line.start_time) || '00:00'}:00`;
}

// Combined end datetime for a line. Missing end date falls back to the start
// date; missing end time counts as end-of-day 23:59 (matches the previous
// derived event-end behaviour for date-only rows).
export function agendaLineEndDateTime(line) {
  const d = line?.end_date || line?.start_date;
  if (!d) return null;
  return `${d}T${normalizeAgendaTime(line.end_time) || '23:59'}:00`;
}

// Chronological order: by start datetime, then end datetime; stable for ties
// and lines without dates keep their relative position at the end.
export function sortAgendaLinesChronologically(lines) {
  return (lines || [])
    .map((l, i) => [l, i])
    .sort(([a, ai], [b, bi]) => {
      const sa = agendaLineStartDateTime(a);
      const sb = agendaLineStartDateTime(b);
      if (sa !== sb) {
        if (sa === null) return 1;
        if (sb === null) return -1;
        return sa < sb ? -1 : 1;
      }
      const ea = agendaLineEndDateTime(a) || '';
      const eb = agendaLineEndDateTime(b) || '';
      if (ea !== eb) return ea < eb ? -1 : 1;
      return ai - bi;
    })
    .map(([l]) => l);
}

let agendaKeyCounter = 0;
export function nextAgendaLineKey() {
  agendaKeyCounter += 1;
  return `agenda-line-${Date.now()}-${agendaKeyCounter}`;
}

export function emptyAgendaLine(defaultType = 'In person') {
  return {
    _key: nextAgendaLineKey(),
    start_date: '',
    start_time: '',
    end_date: '',
    end_time: '',
    description: '',
    item_type: defaultType,
    location: '',
    zoom_webinar_id: null,
    zoom_meeting_id: null,
    lms_url: '',
    speaker_ids: [],
    sponsor_ids: [],
  };
}

export function validateAgendaLines(lines, agendaItemTypes) {
  const errors = [];
  if (!lines || lines.length === 0) {
    errors.push('Please add at least one agenda line for this training event');
    return errors;
  }
  lines.forEach((line, i) => {
    const label = `Agenda line ${i + 1}`;
    if (!line.start_date) errors.push(`${label}: please set a start date`);
    if (!normalizeAgendaTime(line.start_time)) errors.push(`${label}: please set a start time`);
    if (!normalizeAgendaTime(line.end_time)) errors.push(`${label}: please set an end time`);
    if (line.start_date && (line.end_date || line.end_time)) {
      // Compare full datetimes; an explicit end time on the start day must not
      // be before the start time.
      const start = agendaLineStartDateTime(line);
      const end = `${line.end_date || line.start_date}T${normalizeAgendaTime(line.end_time) || normalizeAgendaTime(line.start_time) || '00:00'}:00`;
      if (end < start) {
        errors.push(`${label}: the end date/time cannot be before the start date/time`);
      }
    }
    if (!line.item_type) errors.push(`${label}: please choose a type`);
    const behaviour = agendaTypeBehaviour(line.item_type, agendaItemTypes);
    if (behaviour === 'location' && !String(line.location || '').trim()) {
      errors.push(`${label}: please enter a location for this in-person day`);
    }
    if (behaviour === 'zoom' && !line.zoom_webinar_id && !line.zoom_meeting_id) {
      errors.push(`${label}: please select a webinar or meeting for this online day`);
    }
    if (behaviour === 'lms') {
      const url = String(line.lms_url || '').trim();
      if (!url) {
        errors.push(`${label}: please enter the learning platform (LMS) link`);
      } else if (!/^https?:\/\//i.test(url)) {
        errors.push(`${label}: the LMS link must start with http:// or https://`);
      }
    }
  });
  return errors;
}

// Sortable wrapper: provides the node ref + drag-handle props for one line.
function SortableAgendaLine({ id, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging ? { zIndex: 10, position: 'relative', opacity: 0.85 } : {}),
  };
  return children({ setNodeRef, style, handleProps: { ...attributes, ...listeners } });
}

export default function TrainingAgendaEditor({ lines, onChange, agendaItemTypes, speakers = [] }) {
  const anyOnline = (lines || []).some((l) => agendaTypeBehaviour(l.item_type, agendaItemTypes) === 'zoom');
  // Which line's speaker-selection modal is open (null = none).
  const [speakerModalIndex, setSpeakerModalIndex] = useState(null);

  // Stable per-line keys for drag & drop (saved rows have an id; new rows get
  // a _key from emptyAgendaLine; older callers fall back to the index).
  const lineIds = useMemo(
    () => (lines || []).map((l, i) => l._key || l.id || `line-${i}`),
    [lines]
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = lineIds.indexOf(active.id);
    const to = lineIds.indexOf(over.id);
    if (from < 0 || to < 0) return;
    onChange(arrayMove(lines, from, to));
  };

  // Same source as the event-level picker: future scheduled webinars/meetings only.
  const { data: webinars = [], isLoading: loadingWebinars } = useQuery({
    queryKey: ['/api/zoom/webinars'],
    queryFn: async () => {
      const data = await fetchJson('/api/zoom/webinars');
      return data.filter((w) => w.status === 'scheduled' && new Date(w.start_time) > new Date());
    },
    enabled: anyOnline,
  });
  const { data: meetings = [], isLoading: loadingMeetings } = useQuery({
    queryKey: ['/api/zoom/meetings'],
    queryFn: async () => {
      const data = await fetchJson('/api/zoom/meetings');
      return data.filter((m) => m.status === 'scheduled' && new Date(m.start_time) > new Date());
    },
    enabled: anyOnline,
  });

  const updateLine = (index, patch) => {
    const next = lines.map((l, i) => (i === index ? { ...l, ...patch } : l));
    onChange(next);
  };

  const removeLine = (index) => onChange(lines.filter((_, i) => i !== index));

  const moveLine = (index, dir) => {
    const target = index + dir;
    if (target < 0 || target >= lines.length) return;
    const next = [...lines];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const addLine = () => {
    const defaultType = agendaItemTypes?.[0]?.name || 'In person';
    onChange([...(lines || []), emptyAgendaLine(defaultType)]);
  };

  const behaviourIcon = (behaviour) => {
    if (behaviour === 'location') return <MapPin className="w-4 h-4 text-slate-500" />;
    if (behaviour === 'zoom') return <Video className="w-4 h-4 text-slate-500" />;
    if (behaviour === 'lms') return <GraduationCap className="w-4 h-4 text-slate-500" />;
    return null;
  };

  return (
    <div className="space-y-4" data-testid="training-agenda-editor">
      {(lines || []).length === 0 ? (
        <p className="text-sm text-slate-500">No agenda lines yet. Add one line per training day (or date range).</p>
      ) : (
        <p className="text-xs text-slate-500">
          Drag items to rearrange while editing — on save the agenda is stored in date/time order automatically.
        </p>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={lineIds} strategy={verticalListSortingStrategy}>
      {(lines || []).map((line, index) => {
        const behaviour = agendaTypeBehaviour(line.item_type, agendaItemTypes);
        return (
          <SortableAgendaLine key={lineIds[index]} id={lineIds[index]}>
          {({ setNodeRef, style, handleProps }) => (
          <div ref={setNodeRef} style={style} className="p-4 border border-slate-200 rounded-lg bg-slate-50 space-y-3" data-testid={`agenda-line-${index}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button type="button" className="cursor-grab active:cursor-grabbing text-slate-400 hover:text-slate-600 touch-none"
                  {...handleProps} aria-label={`Drag to reorder item ${index + 1}`} data-testid={`handle-agenda-drag-${index}`}>
                  <GripVertical className="w-4 h-4" />
                </button>
                <span className="text-sm font-medium text-slate-700">Item {index + 1}</span>
              </div>
              <div className="flex items-center gap-1">
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={index === 0}
                  onClick={() => moveLine(index, -1)} data-testid={`button-agenda-up-${index}`}>
                  <ArrowUp className="w-4 h-4" />
                </Button>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={index === lines.length - 1}
                  onClick={() => moveLine(index, 1)} data-testid={`button-agenda-down-${index}`}>
                  <ArrowDown className="w-4 h-4" />
                </Button>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                  onClick={() => removeLine(index)} data-testid={`button-agenda-remove-${index}`}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Start date *</Label>
                <Input type="date" value={line.start_date || ''}
                  onChange={(e) => updateLine(index, { start_date: e.target.value })}
                  data-testid={`input-agenda-start-${index}`} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Start time *</Label>
                <Input type="time" required value={normalizeAgendaTime(line.start_time)}
                  onChange={(e) => updateLine(index, { start_time: e.target.value })}
                  data-testid={`input-agenda-start-time-${index}`} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">End date (optional)</Label>
                <Input type="date" value={line.end_date || ''} min={line.start_date || undefined}
                  onChange={(e) => updateLine(index, { end_date: e.target.value })}
                  data-testid={`input-agenda-end-${index}`} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">End time *</Label>
                <Input type="time" required value={normalizeAgendaTime(line.end_time)}
                  onChange={(e) => updateLine(index, { end_time: e.target.value })}
                  data-testid={`input-agenda-end-time-${index}`} />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Type *</Label>
                <Select
                  value={line.item_type || undefined}
                  onValueChange={(value) => {
                    // Reset conditional fields when the type behaviour changes.
                    updateLine(index, {
                      item_type: value,
                      ...(agendaTypeBehaviour(value, agendaItemTypes) !== 'location' ? { location: '' } : {}),
                      ...(agendaTypeBehaviour(value, agendaItemTypes) !== 'zoom' ? { zoom_webinar_id: null, zoom_meeting_id: null } : {}),
                      ...(agendaTypeBehaviour(value, agendaItemTypes) !== 'lms' ? { lms_url: '' } : {}),
                    });
                  }}
                >
                  <SelectTrigger data-testid={`select-agenda-type-${index}`}>
                    <SelectValue placeholder="Choose type" />
                  </SelectTrigger>
                  <SelectContent>
                    {(agendaItemTypes || []).map((t) => (
                      <SelectItem key={t.name} value={t.name}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Description</Label>
              <Textarea rows={2} value={line.description || ''} placeholder="What happens on this day?"
                onChange={(e) => updateLine(index, { description: e.target.value })}
                data-testid={`input-agenda-description-${index}`} />
            </div>

            {behaviour === 'location' && (
              <div className="space-y-1">
                <Label className="text-xs flex items-center gap-1">{behaviourIcon(behaviour)} Location *</Label>
                <Input value={line.location || ''} placeholder="Venue for this day"
                  onChange={(e) => updateLine(index, { location: e.target.value })}
                  data-testid={`input-agenda-location-${index}`} />
              </div>
            )}

            {behaviour === 'zoom' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs flex items-center gap-1">{behaviourIcon(behaviour)} Webinar</Label>
                  <Select
                    value={line.zoom_webinar_id || undefined}
                    onValueChange={(value) => updateLine(index, { zoom_webinar_id: value, zoom_meeting_id: null })}
                  >
                    <SelectTrigger data-testid={`select-agenda-webinar-${index}`}>
                      <SelectValue placeholder={loadingWebinars ? 'Loading…' : 'Select a webinar'} />
                    </SelectTrigger>
                    <SelectContent>
                      {webinars.length === 0 && <SelectItem value="__none" disabled>No upcoming webinars</SelectItem>}
                      {webinars.map((w) => (
                        <SelectItem key={w.id} value={w.id}>{w.topic || 'Untitled webinar'}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">or Meeting</Label>
                  <Select
                    value={line.zoom_meeting_id || undefined}
                    onValueChange={(value) => updateLine(index, { zoom_meeting_id: value, zoom_webinar_id: null })}
                  >
                    <SelectTrigger data-testid={`select-agenda-meeting-${index}`}>
                      <SelectValue placeholder={loadingMeetings ? 'Loading…' : 'Select a meeting'} />
                    </SelectTrigger>
                    <SelectContent>
                      {meetings.length === 0 && <SelectItem value="__none" disabled>No upcoming meetings</SelectItem>}
                      {meetings.map((m) => (
                        <SelectItem key={m.id} value={m.id}>{m.topic || 'Untitled meeting'}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {behaviour === 'lms' && (
              <div className="space-y-1">
                <Label className="text-xs flex items-center gap-1">{behaviourIcon(behaviour)} Learning platform (LMS) link *</Label>
                <Input type="url" value={line.lms_url || ''} placeholder="https://your-lms.example.com/course"
                  onChange={(e) => updateLine(index, { lms_url: e.target.value })}
                  data-testid={`input-agenda-lms-${index}`} />
              </div>
            )}

            {/* Per-item speakers (Task #3436) — additive to the event-level speakers. */}
            <div className="space-y-1 pt-1 border-t border-slate-200">
              <Label className="text-xs flex items-center gap-1">
                <Mic className="w-4 h-4 text-slate-500" /> Speakers for this item (optional)
              </Label>
              <div className="flex flex-wrap items-center gap-2">
                {(line.speaker_ids || []).map((sid) => {
                  const sp = speakers.find((s) => s.id === sid);
                  return (
                    <span key={sid} className="inline-flex items-center gap-1.5 pl-1 pr-2 py-0.5 rounded-full bg-purple-50 border border-purple-200 text-xs text-purple-800"
                      data-testid={`chip-agenda-speaker-${index}-${sid}`}>
                      {sp?.profile_photo_url ? (
                        <img src={sp.profile_photo_url} alt={sp.full_name} className="w-5 h-5 rounded-full object-cover" />
                      ) : (
                        <Mic className="w-3 h-3 text-purple-500" />
                      )}
                      {sp?.full_name || 'Unknown speaker'}
                      <button type="button" className="text-purple-400 hover:text-purple-700"
                        onClick={() => updateLine(index, { speaker_ids: (line.speaker_ids || []).filter((x) => x !== sid) })}
                        data-testid={`button-remove-agenda-speaker-${index}-${sid}`}>
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  );
                })}
                <Button type="button" variant="outline" size="sm" onClick={() => setSpeakerModalIndex(index)}
                  data-testid={`button-agenda-speakers-${index}`}>
                  <Mic className="w-3.5 h-3.5 mr-1.5" />
                  {(line.speaker_ids || []).length > 0 ? 'Edit speakers' : 'Add speakers'}
                </Button>
              </div>
            </div>

            {/* Per-item sponsors (Task #3436) — additive to the event-level sponsors. */}
            <div className="pt-1 border-t border-slate-200">
              <EventSponsorSelector
                selectedSponsorIds={line.sponsor_ids || []}
                onSelectedSponsorIdsChange={(ids) => updateLine(index, { sponsor_ids: ids })}
              />
            </div>
          </div>
          )}
          </SortableAgendaLine>
        );
      })}
      </SortableContext>
      </DndContext>

      <SpeakerSelectionModal
        open={speakerModalIndex !== null}
        onOpenChange={(open) => { if (!open) setSpeakerModalIndex(null); }}
        speakers={speakers}
        selectedSpeakerIds={speakerModalIndex !== null ? (lines?.[speakerModalIndex]?.speaker_ids || []) : []}
        onConfirm={(ids) => {
          if (speakerModalIndex !== null) updateLine(speakerModalIndex, { speaker_ids: ids });
        }}
      />

      <Button type="button" variant="outline" onClick={addLine} data-testid="button-add-agenda-line">
        <Plus className="w-4 h-4 mr-2" />
        Add agenda line
      </Button>
    </div>
  );
}
