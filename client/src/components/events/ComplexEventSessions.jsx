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
  _expanded: true
});

export default function ComplexEventSessions({ sessions, onSessionsChange, timezoneOptions, eventTimezone }) {
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
                    <div className="space-y-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                      <div className="flex items-center gap-2 text-blue-900 font-medium">
                        <Video className="h-4 w-4" />
                        Zoom Configuration
                      </div>

                      {(session.zoom_meeting_id || session.zoom_webinar_id) && (
                        <div className="flex items-center gap-2 p-2 bg-green-50 border border-green-200 rounded text-sm text-green-800">
                          <Check className="h-4 w-4" />
                          <span>
                            Zoom {session.zoom_webinar_id ? 'Webinar' : 'Meeting'} linked: {session.zoom_webinar_id || session.zoom_meeting_id}
                          </span>
                          {session.zoom_join_url && (
                            <a href={session.zoom_join_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline ml-auto" data-testid={`link-session-zoom-${index}`}>
                              Join URL
                            </a>
                          )}
                        </div>
                      )}

                      <div className="space-y-3">
                        <div className="space-y-2">
                          <Label>Zoom Type</Label>
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              variant={session.zoom_type === 'meeting' ? 'default' : 'outline'}
                              size="sm"
                              onClick={() => updateSession(session._tempId, 'zoom_type', 'meeting')}
                              data-testid={`button-session-zoom-meeting-${index}`}
                            >
                              <Video className="h-4 w-4 mr-1" />
                              Meeting
                            </Button>
                            <Button
                              type="button"
                              variant={session.zoom_type === 'webinar' ? 'default' : 'outline'}
                              size="sm"
                              onClick={() => updateSession(session._tempId, 'zoom_type', 'webinar')}
                              data-testid={`button-session-zoom-webinar-${index}`}
                            >
                              <Users className="h-4 w-4 mr-1" />
                              Webinar
                            </Button>
                          </div>
                          <p className="text-xs text-blue-700">
                            {session.zoom_type === 'webinar'
                              ? 'Webinars support large audiences with registration and panel features'
                              : 'Meetings allow all participants to share video and audio'
                            }
                          </p>
                        </div>

                        <div className="space-y-2">
                          <Label>Zoom Host</Label>
                          <Select
                            value={session.zoom_host_id}
                            onValueChange={(value) => {
                              const user = zoomUsers.find(u => u.id === value);
                              updateSession(session._tempId, 'zoom_host_id', value);
                              if (user) {
                                updateSession(session._tempId, 'zoom_host_email', user.email);
                              }
                            }}
                            disabled={loadingZoomUsers}
                            data-testid={`select-session-host-${index}`}
                          >
                            <SelectTrigger data-testid={`select-session-host-trigger-${index}`}>
                              <SelectValue placeholder={loadingZoomUsers ? "Loading hosts..." : "Select a Zoom host"} />
                            </SelectTrigger>
                            <SelectContent>
                              {zoomUsers.map(user => (
                                <SelectItem key={user.id} value={user.id}>
                                  <div className="flex flex-col">
                                    <span>{user.first_name} {user.last_name}</span>
                                    <span className="text-xs text-slate-500">{user.email}</span>
                                  </div>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        {session.zoom_type === 'webinar' && (
                          <div className="flex items-center justify-between">
                            <div>
                              <Label>Require Registration</Label>
                              <p className="text-xs text-blue-700">Attendees must register before joining</p>
                            </div>
                            <Switch
                              checked={session.zoom_registration_required}
                              onCheckedChange={(checked) => updateSession(session._tempId, 'zoom_registration_required', checked)}
                              data-testid={`switch-session-registration-${index}`}
                            />
                          </div>
                        )}

                        <Separator />
                        <div className="space-y-2">
                          <Label>Zoom Setup Mode</Label>
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              variant={(session.zoom_link_mode || 'auto_create') === 'auto_create' ? 'default' : 'outline'}
                              size="sm"
                              onClick={() => {
                                updateSession(session._tempId, 'zoom_link_mode', 'auto_create');
                                updateSession(session._tempId, 'auto_create_zoom', true);
                                updateSession(session._tempId, 'link_existing_zoom_id', '');
                              }}
                              data-testid={`button-session-zoom-auto-${index}`}
                            >
                              Auto-Create
                            </Button>
                            <Button
                              type="button"
                              variant={session.zoom_link_mode === 'link_existing' ? 'default' : 'outline'}
                              size="sm"
                              onClick={() => {
                                updateSession(session._tempId, 'zoom_link_mode', 'link_existing');
                                updateSession(session._tempId, 'auto_create_zoom', false);
                              }}
                              data-testid={`button-session-zoom-link-${index}`}
                            >
                              Link Existing
                            </Button>
                          </div>
                        </div>

                        {session.zoom_link_mode === 'link_existing' ? (
                          <div className="space-y-2">
                            <Label>Existing Zoom Meeting/Webinar ID</Label>
                            <Input
                              type="text"
                              placeholder="e.g. 12345678901"
                              value={session.link_existing_zoom_id || ''}
                              onChange={(e) => updateSession(session._tempId, 'link_existing_zoom_id', e.target.value.trim())}
                              data-testid={`input-session-existing-zoom-id-${index}`}
                            />
                            <p className="text-xs text-blue-700">
                              Enter the numeric Zoom {session.zoom_type} ID to link. The system will verify it and fetch details from Zoom.
                            </p>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between">
                            <div>
                              <Label>Auto-create Zoom on Save</Label>
                              <p className="text-xs text-blue-700">
                                Automatically create a Zoom {session.zoom_type} when the event is saved
                              </p>
                            </div>
                            <Switch
                              checked={session.auto_create_zoom}
                              onCheckedChange={(checked) => updateSession(session._tempId, 'auto_create_zoom', checked)}
                              data-testid={`switch-session-auto-zoom-${index}`}
                            />
                          </div>
                        )}
                      </div>
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
