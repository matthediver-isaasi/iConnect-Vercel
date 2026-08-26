import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Plus,
  Trash2,
  Video,
  Users,
  MapPin,
  ChevronDown,
  ChevronUp,
  Calendar,
  Loader2,
  Monitor,
  Check,
  RefreshCw,
  LinkIcon
} from "lucide-react";
import { toast } from "sonner";
import ZoomSessionConfig from "@/components/events/ZoomSessionConfig";
import AttendancePolicyEditor from "@/components/events/AttendancePolicyEditor";
import { hasSupportedZoomTarget, normalizeAttendancePolicy } from "@/lib/attendancePolicy";

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    }
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
}

const DELIVERY_MODES = [
  { value: 'in_person', label: 'In-Person', icon: MapPin },
  { value: 'virtual', label: 'Virtual', icon: Video },
  { value: 'hybrid', label: 'Hybrid', icon: Monitor }
];

const createEmptySession = (sortOrder = 0) => ({
  _tempId: `session-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
  title: '',
  description: '',
  start_time: '',
  end_time: '',
  duration_minutes: 60,
  timezone: 'Europe/London',
  delivery_mode: 'in_person',
  track_name: '',
  sort_order: sortOrder,
  zoom_type: 'meeting',
  zoom_host_id: '',
  zoom_host_email: '',
  zoom_registration_required: false,
  zoom_link_mode: 'auto_create',
  auto_create_zoom: true,
  link_existing_zoom_id: '',
  link_existing_zoom_type: '',
  ...normalizeAttendancePolicy({}, { inherit: true }),
  _expanded: true
});

export default function ComplexEventSessions({
  sessions,
  onSessionsChange,
  timezoneOptions,
  eventTimezone,
  eventAttendancePolicy = {},
}) {
  const [expandedSessions, setExpandedSessions] = useState({});

  const { data: zoomUsers = [], isLoading: loadingZoomUsers } = useQuery({
    queryKey: ['/api/zoom/users'],
    queryFn: () => apiRequest('/api/zoom/users'),
    staleTime: 60000
  });

  const addSession = () => {
    const newSession = createEmptySession(sessions.length);
    if (eventTimezone) {
      newSession.timezone = eventTimezone;
    }
    onSessionsChange([...sessions, newSession]);
    setExpandedSessions(prev => ({ ...prev, [newSession._tempId]: true }));
  };

  const removeSession = (tempId) => {
    if (sessions.length <= 1) {
      toast.error('You must have at least one session');
      return;
    }
    onSessionsChange(sessions.filter(s => s._tempId !== tempId));
  };

  const updateSession = (tempId, field, value) => {
    onSessionsChange(sessions.map(s =>
      s._tempId === tempId ? { ...s, [field]: value } : s
    ));
  };

  const toggleExpand = (tempId) => {
    setExpandedSessions(prev => ({
      ...prev,
      [tempId]: !prev[tempId]
    }));
  };

  const isVirtual = (session) => session.delivery_mode === 'virtual' || session.delivery_mode === 'hybrid';

  return (
    <Card className="border-slate-200 shadow-sm mb-6">
      <CardHeader className="pb-4">
        <CardTitle className="text-lg flex items-center gap-2">
          <Calendar className="h-5 w-5 text-blue-600" />
          Event Sessions
        </CardTitle>
        <CardDescription>
          Define individual sessions for this complex event. Each session can have its own delivery mode and Zoom integration.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {sessions.map((session, index) => (
          <div key={session._tempId} className="border border-slate-200 rounded-lg">
            <Collapsible
              open={expandedSessions[session._tempId] !== false}
              onOpenChange={() => toggleExpand(session._tempId)}
            >
              <div className="flex items-center justify-between gap-2 p-3 bg-slate-50 rounded-t-lg">
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="flex items-center gap-2 flex-1 justify-start" data-testid={`button-toggle-session-${index}`}>
                    {expandedSessions[session._tempId] !== false ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                    <span className="font-medium truncate">
                      {session.title || `Session ${index + 1}`}
                    </span>
                    <div className="flex items-center gap-1 ml-2">
                      {session.delivery_mode === 'virtual' && (
                        <Badge variant="secondary" className="text-xs"><Video className="h-3 w-3 mr-1" />Virtual</Badge>
                      )}
                      {session.delivery_mode === 'hybrid' && (
                        <Badge variant="secondary" className="text-xs"><Monitor className="h-3 w-3 mr-1" />Hybrid</Badge>
                      )}
                      {session.delivery_mode === 'in_person' && (
                        <Badge variant="secondary" className="text-xs"><MapPin className="h-3 w-3 mr-1" />In-Person</Badge>
                      )}
                      {isVirtual(session) && session.zoom_type && (
                        <Badge variant="outline" className="text-xs">
                          {session.zoom_type === 'webinar' ? 'Webinar' : 'Meeting'}
                        </Badge>
                      )}
                    </div>
                  </Button>
                </CollapsibleTrigger>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeSession(session._tempId)}
                  className="text-red-500 hover:text-red-700"
                  data-testid={`button-remove-session-${index}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              <CollapsibleContent>
                <div className="p-4 space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Session Title *</Label>
                      <Input
                        value={session.title}
                        onChange={(e) => updateSession(session._tempId, 'title', e.target.value)}
                        placeholder="e.g. Opening Keynote"
                        data-testid={`input-session-title-${index}`}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Track / Stream</Label>
                      <Input
                        value={session.track_name}
                        onChange={(e) => updateSession(session._tempId, 'track_name', e.target.value)}
                        placeholder="e.g. Main Hall, Breakout A"
                        data-testid={`input-session-track-${index}`}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Description</Label>
                    <Textarea
                      value={session.description}
                      onChange={(e) => updateSession(session._tempId, 'description', e.target.value)}
                      placeholder="Brief description of this session..."
                      className="resize-none"
                      rows={2}
                      data-testid={`input-session-description-${index}`}
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label>Start Time</Label>
                      <Input
                        type="datetime-local"
                        value={session.start_time}
                        onChange={(e) => updateSession(session._tempId, 'start_time', e.target.value)}
                        data-testid={`input-session-start-${index}`}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>End Time</Label>
                      <Input
                        type="datetime-local"
                        value={session.end_time}
                        onChange={(e) => updateSession(session._tempId, 'end_time', e.target.value)}
                        data-testid={`input-session-end-${index}`}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Duration (minutes)</Label>
                      <Input
                        type="number"
                        min="1"
                        value={session.duration_minutes}
                        onChange={(e) => updateSession(session._tempId, 'duration_minutes', parseInt(e.target.value) || 60)}
                        data-testid={`input-session-duration-${index}`}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Timezone</Label>
                    <Select
                      value={session.timezone}
                      onValueChange={(value) => updateSession(session._tempId, 'timezone', value)}
                      data-testid={`select-session-timezone-${index}`}
                    >
                      <SelectTrigger data-testid={`select-session-timezone-trigger-${index}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(timezoneOptions || []).map(tz => (
                          <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <Separator />

                  <div className="space-y-3">
                    <Label className="text-base font-medium">Delivery Mode</Label>
                    <div className="flex flex-wrap gap-2">
                      {DELIVERY_MODES.map(mode => {
                        const Icon = mode.icon;
                        return (
                          <Button
                            key={mode.value}
                            type="button"
                            variant={session.delivery_mode === mode.value ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => updateSession(session._tempId, 'delivery_mode', mode.value)}
                            data-testid={`button-session-mode-${mode.value}-${index}`}
                          >
                            <Icon className="h-4 w-4 mr-1" />
                            {mode.label}
                          </Button>
                        );
                      })}
                    </div>
                  </div>

                  {isVirtual(session) && (
                    <div className="space-y-4">
                    <ZoomSessionConfig
                      zoomType={session.zoom_type}
                      zoomHostId={session.zoom_host_id}
                      zoomHostEmail={session.zoom_host_email}
                      zoomRegistrationRequired={session.zoom_registration_required}
                      zoomLinkMode={session.zoom_link_mode}
                      autoCreateZoom={session.auto_create_zoom}
                      linkExistingZoomId={session.link_existing_zoom_id}
                      zoomMeetingId={session.zoom_meeting_id}
                      zoomWebinarId={session.zoom_webinar_id}
                      zoomJoinUrl={session.zoom_join_url}
                      zoomUsers={zoomUsers}
                      loadingZoomUsers={loadingZoomUsers}
                      onUpdate={(updates) => {
                        Object.entries(updates).forEach(([key, value]) => {
                          updateSession(session._tempId, key, value);
                        });
                      }}
                      testIdSuffix={`-${index}`}
                    />
                    <AttendancePolicyEditor
                      value={session}
                      onChange={(policy) => onSessionsChange(sessions.map((item) =>
                        item._tempId === session._tempId ? { ...item, ...policy } : item
                      ))}
                      allowInheritance
                      parentPolicy={eventAttendancePolicy}
                      targetSupported={hasSupportedZoomTarget({
                        isOnline: true,
                        zoomMeetingId: session.zoom_meeting_id || (session.zoom_type !== 'webinar' ? session.link_existing_zoom_id : null),
                        zoomWebinarId: session.zoom_webinar_id || (session.zoom_type === 'webinar' ? session.link_existing_zoom_id : null),
                        zoomAutoCreate: session.zoom_link_mode !== 'link_existing' && session.auto_create_zoom,
                      })}
                      label="Session attendance policy"
                      testId={`session-attendance-policy-${index}`}
                    />
                    </div>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        ))}

        <Button
          type="button"
          variant="outline"
          onClick={addSession}
          className="w-full border-dashed"
          data-testid="button-add-session"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Session
        </Button>
      </CardContent>
    </Card>
  );
}
