import { useState, useEffect } from "react";
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
import { toast } from "sonner";
import {
  ArrowLeft, Save, Loader2, Plus, Trash2, ChevronDown, ChevronUp,
  Calendar, MapPin, Monitor
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";
import EventImageUpload from "@/components/events/EventImageUpload";
import ReactQuill from "react-quill";
import "react-quill/dist/quill.snow.css";

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

function generateId() {
  return `tmp-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
}

export default function CreateComplexEvent() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const params = new URLSearchParams(location.search);
  const editId = params.get("id");
  const isEditMode = !!editId;

  const [activeSection, setActiveSection] = useState("details");
  const [saving, setSaving] = useState(false);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);

  const [formData, setFormData] = useState({
    title: "",
    slug: "",
    description: "",
    summary: "",
    image_url: "",
    start_date: "",
    end_date: "",
    location: "",
    status: "draft",
    timezone: "Europe/London",
    available_seats: "",
  });

  const [tracks, setTracks] = useState([]);
  const [expandedTracks, setExpandedTracks] = useState({});
  const [sessionDialogTrackId, setSessionDialogTrackId] = useState(null);
  const [editingSession, setEditingSession] = useState(null);
  const [sessionForm, setSessionForm] = useState({
    title: "",
    description: "",
    image_url: "",
    speaker_names: [],
    start_time: "",
    end_time: "",
    location: "",
    is_online: false,
  });
  const [speakerInput, setSpeakerInput] = useState("");

  const { data: existingEvent, isLoading: loadingEvent } = useQuery({
    queryKey: ["/api/entities/ComplexEvent", editId],
    queryFn: () => base44.entities.ComplexEvent.get(editId),
    enabled: isEditMode,
  });

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
    queryKey: ["/api/entities/ComplexEventSession", editId],
    queryFn: async () => {
      if (!existingTracks.length) return [];
      const allSessions = [];
      for (const track of existingTracks) {
        const sessions = await base44.entities.ComplexEventSession.list({
          filter: { complex_event_track_id: track.id },
          sort: { display_order: "asc" },
        });
        allSessions.push(...sessions);
      }
      return allSessions;
    },
    enabled: isEditMode && existingTracks.length > 0,
  });

  useEffect(() => {
    if (existingEvent && isEditMode) {
      setFormData({
        title: existingEvent.title || "",
        slug: existingEvent.slug || "",
        description: existingEvent.description || "",
        summary: existingEvent.summary || "",
        image_url: existingEvent.image_url || "",
        start_date: existingEvent.start_date ? existingEvent.start_date.slice(0, 16) : "",
        end_date: existingEvent.end_date ? existingEvent.end_date.slice(0, 16) : "",
        location: existingEvent.location || "",
        status: existingEvent.status || "draft",
        timezone: existingEvent.timezone || "Europe/London",
        available_seats: existingEvent.available_seats != null ? String(existingEvent.available_seats) : "",
      });
      setSlugManuallyEdited(true);
    }
  }, [existingEvent, isEditMode]);

  useEffect(() => {
    if (isEditMode && existingTracks.length > 0) {
      const tracksWithSessions = existingTracks.map((t) => ({
        ...t,
        _localId: t.id,
        sessions: existingSessions
          .filter((s) => s.complex_event_track_id === t.id)
          .map((s) => ({
            ...s,
            _localId: s.id,
            speaker_names: s.speaker_names || [],
          })),
      }));
      setTracks(tracksWithSessions);
      const expanded = {};
      tracksWithSessions.forEach((t) => { expanded[t._localId] = true; });
      setExpandedTracks(expanded);
    }
  }, [existingTracks, existingSessions, isEditMode]);

  useEffect(() => {
    if (formData.title && !slugManuallyEdited) {
      const generated = formData.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      setFormData((prev) => ({ ...prev, slug: generated }));
    }
  }, [formData.title, slugManuallyEdited]);

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
      sessions: [],
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
    setTracks((prev) => prev.filter((t) => t._localId !== localId));
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

  const openSessionDialog = (trackLocalId, session = null) => {
    setSessionDialogTrackId(trackLocalId);
    if (session) {
      setEditingSession(session._localId);
      setSessionForm({
        title: session.title || "",
        description: session.description || "",
        image_url: session.image_url || "",
        speaker_names: session.speaker_names || [],
        start_time: session.start_time ? session.start_time.slice(0, 16) : "",
        end_time: session.end_time ? session.end_time.slice(0, 16) : "",
        location: session.location || "",
        is_online: session.is_online || false,
      });
      setSpeakerInput("");
    } else {
      setEditingSession(null);
      setSessionForm({
        title: "",
        description: "",
        image_url: "",
        speaker_names: [],
        start_time: "",
        end_time: "",
        location: "",
        is_online: false,
      });
      setSpeakerInput("");
    }
  };

  const closeSessionDialog = () => {
    setSessionDialogTrackId(null);
    setEditingSession(null);
  };

  const saveSession = () => {
    if (!sessionForm.title.trim()) {
      toast.error("Session title is required");
      return;
    }
    setTracks((prev) =>
      prev.map((t) => {
        if (t._localId !== sessionDialogTrackId) return t;
        if (editingSession) {
          return {
            ...t,
            sessions: t.sessions.map((s) =>
              s._localId === editingSession ? { ...s, ...sessionForm } : s
            ),
          };
        }
        return {
          ...t,
          sessions: [
            ...t.sessions,
            { ...sessionForm, _localId: generateId(), display_order: t.sessions.length },
          ],
        };
      })
    );
    closeSessionDialog();
  };

  const removeSession = (trackLocalId, sessionLocalId) => {
    setTracks((prev) =>
      prev.map((t) =>
        t._localId === trackLocalId
          ? { ...t, sessions: t.sessions.filter((s) => s._localId !== sessionLocalId) }
          : t
      )
    );
  };

  const moveSession = (trackLocalId, sessionLocalId, direction) => {
    setTracks((prev) =>
      prev.map((t) => {
        if (t._localId !== trackLocalId) return t;
        const idx = t.sessions.findIndex((s) => s._localId === sessionLocalId);
        if ((direction === -1 && idx === 0) || (direction === 1 && idx === t.sessions.length - 1))
          return t;
        const next = [...t.sessions];
        [next[idx], next[idx + direction]] = [next[idx + direction], next[idx]];
        return { ...t, sessions: next.map((s, i) => ({ ...s, display_order: i })) };
      })
    );
  };

  const addSpeaker = () => {
    const name = speakerInput.trim();
    if (name && !sessionForm.speaker_names.includes(name)) {
      setSessionForm((prev) => ({ ...prev, speaker_names: [...prev.speaker_names, name] }));
      setSpeakerInput("");
    }
  };

  const removeSpeaker = (name) => {
    setSessionForm((prev) => ({
      ...prev,
      speaker_names: prev.speaker_names.filter((n) => n !== name),
    }));
  };

  const handleSave = async () => {
    if (!formData.title.trim()) {
      toast.error("Event title is required");
      return;
    }
    if (!formData.slug.trim()) {
      toast.error("Event slug is required");
      return;
    }

    setSaving(true);
    try {
      const eventPayload = {
        title: formData.title,
        slug: formData.slug,
        description: formData.description || null,
        summary: formData.summary || null,
        image_url: formData.image_url || null,
        start_date: formData.start_date || null,
        end_date: formData.end_date || null,
        location: formData.location || null,
        status: formData.status,
        timezone: formData.timezone,
        available_seats: formData.available_seats ? parseInt(formData.available_seats, 10) : null,
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
          const sessions = await base44.entities.ComplexEventSession.filter({
            complex_event_track_id: trackId,
          });
          for (const s of sessions) {
            await base44.entities.ComplexEventSession.delete(s.id);
          }
          await base44.entities.ComplexEventTrack.delete(trackId);
        }
      }

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

        if (isEditMode && track.id) {
          const existingSessionIds = existingSessions
            .filter((s) => s.complex_event_track_id === track.id)
            .map((s) => s.id);
          const currentSessionDbIds = track.sessions.filter((s) => s.id).map((s) => s.id);
          const deletedSessionIds = existingSessionIds.filter(
            (id) => !currentSessionDbIds.includes(id)
          );
          for (const sid of deletedSessionIds) {
            await base44.entities.ComplexEventSession.delete(sid);
          }
        }

        for (let si = 0; si < track.sessions.length; si++) {
          const session = track.sessions[si];
          const sessionPayload = {
            complex_event_track_id: trackId,
            title: session.title || "Untitled Session",
            description: session.description || null,
            image_url: session.image_url || null,
            speaker_names: session.speaker_names || [],
            start_time: session.start_time || null,
            end_time: session.end_time || null,
            location: session.location || null,
            is_online: session.is_online || false,
            display_order: si,
          };

          if (session.id) {
            await base44.entities.ComplexEventSession.update(session.id, sessionPayload);
          } else {
            await base44.entities.ComplexEventSession.create(sessionPayload);
          }
        }
      }

      queryClient.invalidateQueries({ queryKey: ["/api/entities/ComplexEvent"] });
      toast.success(isEditMode ? "Complex event updated" : "Complex event created");
      window.location.href = createPageUrl("ComplexEvents");
    } catch (err) {
      console.error("Save error:", err);
      toast.error("Failed to save: " + (err.message || "Unknown error"));
    } finally {
      setSaving(false);
    }
  };

  if (isEditMode && (loadingEvent || loadingTracks)) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  const sections = [
    { id: "details", label: "Event Details" },
    { id: "tracks", label: "Tracks & Sessions" },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => (window.location.href = createPageUrl("ComplexEvents"))}
              data-testid="button-back"
            >
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h1 className="text-2xl font-bold text-slate-900" data-testid="text-page-title">
              {isEditMode ? "Edit Complex Event" : "Create Complex Event"}
            </h1>
          </div>
          <Button onClick={handleSave} disabled={saving} data-testid="button-save">
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
            {isEditMode ? "Save Changes" : "Create Event"}
          </Button>
        </div>

        <div className="flex gap-2 mb-6">
          {sections.map((s) => (
            <Button
              key={s.id}
              variant={activeSection === s.id ? "default" : "outline"}
              onClick={() => setActiveSection(s.id)}
              data-testid={`button-section-${s.id}`}
            >
              {s.label}
            </Button>
          ))}
        </div>

        {activeSection === "details" && (
          <Card>
            <CardHeader>
              <CardTitle>Event Details</CardTitle>
              <CardDescription>Basic information about the complex event</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="title">Title *</Label>
                  <Input
                    id="title"
                    value={formData.title}
                    onChange={(e) => updateField("title", e.target.value)}
                    placeholder="Event title"
                    data-testid="input-title"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="slug">URL Slug *</Label>
                  <Input
                    id="slug"
                    value={formData.slug}
                    onChange={(e) => {
                      setSlugManuallyEdited(true);
                      updateField("slug", e.target.value);
                    }}
                    placeholder="event-url-slug"
                    data-testid="input-slug"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="summary">Summary</Label>
                <Textarea
                  id="summary"
                  value={formData.summary}
                  onChange={(e) => updateField("summary", e.target.value)}
                  placeholder="Brief summary of the event"
                  rows={2}
                  data-testid="input-summary"
                />
              </div>

              <div className="space-y-2">
                <Label>Description</Label>
                <ReactQuill
                  theme="snow"
                  value={formData.description}
                  onChange={(val) => updateField("description", val)}
                  modules={QUILL_MODULES}
                  formats={QUILL_FORMATS}
                  data-testid="input-description"
                />
              </div>

              <div className="space-y-2">
                <Label>Event Image</Label>
                <EventImageUpload
                  imageUrl={formData.image_url}
                  onImageChange={(url) => updateField("image_url", url)}
                />
              </div>

              <Separator />

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="start_date">Start Date</Label>
                  <Input
                    id="start_date"
                    type="datetime-local"
                    value={formData.start_date}
                    onChange={(e) => updateField("start_date", e.target.value)}
                    data-testid="input-start-date"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="end_date">End Date</Label>
                  <Input
                    id="end_date"
                    type="datetime-local"
                    value={formData.end_date}
                    onChange={(e) => updateField("end_date", e.target.value)}
                    data-testid="input-end-date"
                  />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
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
                  <Label htmlFor="timezone">Timezone</Label>
                  <Select value={formData.timezone} onValueChange={(v) => updateField("timezone", v)}>
                    <SelectTrigger data-testid="select-timezone">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TIMEZONE_OPTIONS.map((tz) => (
                        <SelectItem key={tz.value} value={tz.value}>
                          {tz.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="status">Status</Label>
                  <Select value={formData.status} onValueChange={(v) => updateField("status", v)}>
                    <SelectTrigger data-testid="select-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="published">Published</SelectItem>
                      <SelectItem value="tbc">TBC</SelectItem>
                      <SelectItem value="closed">Closed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="available_seats">Available Seats</Label>
                  <Input
                    id="available_seats"
                    type="number"
                    value={formData.available_seats}
                    onChange={(e) => updateField("available_seats", e.target.value)}
                    placeholder="Leave empty for unlimited"
                    data-testid="input-available-seats"
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {activeSection === "tracks" && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Tracks & Sessions</h2>
                <p className="text-sm text-slate-500">
                  Organise your event into tracks and add sessions to each track.
                </p>
              </div>
              <Button onClick={addTrack} data-testid="button-add-track">
                <Plus className="w-4 h-4 mr-2" />
                Add Track
              </Button>
            </div>

            {tracks.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
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
                </CardContent>
              </Card>
            ) : (
              tracks.map((track, trackIdx) => (
                <Card key={track._localId} data-testid={`card-track-${track._localId}`}>
                  <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
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
                      <Badge variant="secondary">{track.sessions?.length || 0} sessions</Badge>
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
                  </CardHeader>

                  {expandedTracks[track._localId] && (
                    <CardContent className="space-y-4">
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

                      <Separator />

                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h4 className="font-medium text-slate-700">Sessions</h4>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openSessionDialog(track._localId)}
                            data-testid={`button-add-session-${track._localId}`}
                          >
                            <Plus className="w-3.5 h-3.5 mr-1" />
                            Add Session
                          </Button>
                        </div>

                        {(!track.sessions || track.sessions.length === 0) ? (
                          <p className="text-sm text-slate-400 py-4 text-center" data-testid={`text-no-sessions-${track._localId}`}>
                            No sessions in this track yet.
                          </p>
                        ) : (
                          <div className="space-y-2">
                            {track.sessions.map((session, sessionIdx) => (
                              <div
                                key={session._localId}
                                className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg border border-slate-100"
                                data-testid={`session-item-${session._localId}`}
                              >
                                <div className="flex-1 min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-medium text-sm text-slate-800 truncate">
                                      {session.title || "Untitled Session"}
                                    </span>
                                    {session.is_online && (
                                      <Badge variant="outline" className="text-xs">
                                        <Monitor className="w-3 h-3 mr-1" />
                                        Virtual
                                      </Badge>
                                    )}
                                  </div>
                                  <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 mt-1">
                                    {session.start_time && (
                                      <span className="flex items-center gap-1">
                                        <Calendar className="w-3 h-3" />
                                        {new Date(session.start_time).toLocaleString(undefined, {
                                          month: "short",
                                          day: "numeric",
                                          hour: "2-digit",
                                          minute: "2-digit",
                                        })}
                                      </span>
                                    )}
                                    {session.location && (
                                      <span className="flex items-center gap-1">
                                        <MapPin className="w-3 h-3" />
                                        {session.location}
                                      </span>
                                    )}
                                    {session.speaker_names?.length > 0 && (
                                      <span>{session.speaker_names.join(", ")}</span>
                                    )}
                                  </div>
                                </div>
                                <div className="flex items-center gap-1">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    disabled={sessionIdx === 0}
                                    onClick={() => moveSession(track._localId, session._localId, -1)}
                                  >
                                    <ChevronUp className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    disabled={sessionIdx === track.sessions.length - 1}
                                    onClick={() => moveSession(track._localId, session._localId, 1)}
                                  >
                                    <ChevronDown className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => openSessionDialog(track._localId, session)}
                                    data-testid={`button-edit-session-${session._localId}`}
                                  >
                                    <Calendar className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => removeSession(track._localId, session._localId)}
                                    data-testid={`button-remove-session-${session._localId}`}
                                  >
                                    <Trash2 className="w-3.5 h-3.5 text-red-500" />
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </CardContent>
                  )}
                </Card>
              ))
            )}
          </div>
        )}
      </div>

      <Dialog open={!!sessionDialogTrackId} onOpenChange={() => closeSessionDialog()}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingSession ? "Edit Session" : "Add Session"}</DialogTitle>
            <DialogDescription>
              {editingSession ? "Update the session details below." : "Fill in the session details below."}
            </DialogDescription>
          </DialogHeader>
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

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Start Time</Label>
                <Input
                  type="datetime-local"
                  value={sessionForm.start_time}
                  onChange={(e) =>
                    setSessionForm((prev) => ({ ...prev, start_time: e.target.value }))
                  }
                  data-testid="input-session-start-time"
                />
              </div>
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
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Location</Label>
                <Input
                  value={sessionForm.location}
                  onChange={(e) =>
                    setSessionForm((prev) => ({ ...prev, location: e.target.value }))
                  }
                  placeholder='Physical address or "virtual"'
                  data-testid="input-session-location"
                />
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

            <div className="space-y-2">
              <Label>Speakers</Label>
              <div className="flex flex-wrap gap-2 mb-2">
                {sessionForm.speaker_names.map((name) => (
                  <Badge key={name} variant="secondary" className="gap-1">
                    {name}
                    <button
                      onClick={() => removeSpeaker(name)}
                      className="ml-1 hover:text-red-500"
                    >
                      &times;
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  value={speakerInput}
                  onChange={(e) => setSpeakerInput(e.target.value)}
                  placeholder="Type speaker name and press Add"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addSpeaker();
                    }
                  }}
                  data-testid="input-speaker-name"
                />
                <Button variant="outline" onClick={addSpeaker} data-testid="button-add-speaker">
                  Add
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Session Image</Label>
              <EventImageUpload
                imageUrl={sessionForm.image_url}
                onImageChange={(url) =>
                  setSessionForm((prev) => ({ ...prev, image_url: url }))
                }
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={closeSessionDialog} data-testid="button-cancel-session">
              Cancel
            </Button>
            <Button onClick={saveSession} data-testid="button-save-session">
              {editingSession ? "Update Session" : "Add Session"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
