// Training-event agenda editor (Task #3419).
// Unlimited day/date-range lines, each with a type from the admin-managed
// 'event_agenda_item_types' setting and a type-conditional detail field:
//   In person  -> required location text
//   Online     -> existing Zoom/Teams webinar/meeting picker (future items only)
//   Self study -> external LMS URL
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, ArrowUp, ArrowDown, MapPin, Video, GraduationCap } from "lucide-react";

async function fetchJson(url) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
  return response.json();
}

// Behaviour is inferred from the type name so renamed types keep working
// sensibly (exact seed names first, then keyword heuristics; unknown names get
// no conditional field).
export function agendaTypeBehaviour(typeName) {
  const n = String(typeName || '').trim().toLowerCase();
  if (!n) return null;
  if (n === 'in person' || n === 'in-person') return 'location';
  if (n === 'online') return 'zoom';
  if (n === 'self study' || n === 'self-study') return 'lms';
  if (n.includes('person') || n.includes('venue')) return 'location';
  if (n.includes('online') || n.includes('virtual') || n.includes('webinar') || n.includes('zoom') || n.includes('teams')) return 'zoom';
  if (n.includes('self') || n.includes('study') || n.includes('lms')) return 'lms';
  return null;
}

export function emptyAgendaLine(defaultType = 'In person') {
  return {
    start_date: '',
    end_date: '',
    description: '',
    item_type: defaultType,
    location: '',
    zoom_webinar_id: null,
    zoom_meeting_id: null,
    lms_url: '',
  };
}

export function validateAgendaLines(lines) {
  const errors = [];
  if (!lines || lines.length === 0) {
    errors.push('Please add at least one agenda line for this training event');
    return errors;
  }
  lines.forEach((line, i) => {
    const label = `Agenda line ${i + 1}`;
    if (!line.start_date) errors.push(`${label}: please set a start date`);
    if (line.start_date && line.end_date && line.end_date < line.start_date) {
      errors.push(`${label}: end date cannot be before the start date`);
    }
    if (!line.item_type) errors.push(`${label}: please choose a type`);
    const behaviour = agendaTypeBehaviour(line.item_type);
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

export default function TrainingAgendaEditor({ lines, onChange, agendaItemTypes }) {
  const anyOnline = (lines || []).some((l) => agendaTypeBehaviour(l.item_type) === 'zoom');

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
      {(lines || []).length === 0 && (
        <p className="text-sm text-slate-500">No agenda lines yet. Add one line per training day (or date range).</p>
      )}
      {(lines || []).map((line, index) => {
        const behaviour = agendaTypeBehaviour(line.item_type);
        return (
          <div key={index} className="p-4 border border-slate-200 rounded-lg bg-slate-50 space-y-3" data-testid={`agenda-line-${index}`}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-700">Day {index + 1}</span>
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

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Start date *</Label>
                <Input type="date" value={line.start_date || ''}
                  onChange={(e) => updateLine(index, { start_date: e.target.value })}
                  data-testid={`input-agenda-start-${index}`} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">End date (optional)</Label>
                <Input type="date" value={line.end_date || ''} min={line.start_date || undefined}
                  onChange={(e) => updateLine(index, { end_date: e.target.value })}
                  data-testid={`input-agenda-end-${index}`} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Type *</Label>
                <Select
                  value={line.item_type || undefined}
                  onValueChange={(value) => {
                    // Reset conditional fields when the type behaviour changes.
                    updateLine(index, {
                      item_type: value,
                      ...(agendaTypeBehaviour(value) !== 'location' ? { location: '' } : {}),
                      ...(agendaTypeBehaviour(value) !== 'zoom' ? { zoom_webinar_id: null, zoom_meeting_id: null } : {}),
                      ...(agendaTypeBehaviour(value) !== 'lms' ? { lms_url: '' } : {}),
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
          </div>
        );
      })}

      <Button type="button" variant="outline" onClick={addLine} data-testid="button-add-agenda-line">
        <Plus className="w-4 h-4 mr-2" />
        Add agenda line
      </Button>
    </div>
  );
}
